import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, relative, dirname, join } from "node:path";

import type { VaultPaths, VaultNoteSummary } from "./types.js";
import { parseMarkdownNote, renderMarkdownNote, slugifyNoteTitle } from "./frontmatter.js";
import { ensureVaultDirectories, resolveVaultNotePath } from "./paths.js";
import { syncVault } from "./sync.js";
import { withVaultDatabase } from "./database.js";

export interface CreateNoteInput {
	title: string;
	body: string;
	id?: string;
	source?: string;
	tags?: string[];
	aliases?: string[];
	tier?: string;
	contentType?: string;
	status?: string;
	type?: string;
	summary?: string;
	doi?: string;
	venue?: string;
	citationCount?: number;
	isRetracted?: boolean;
	utilityScore?: number;
	authorityScore?: number;
	sourceDomain?: string;
	fetchedAt?: string;
	fetchProvider?: string;
	oaUrl?: string;
	oaSource?: string;
	oaVersion?: string;
	oaLicense?: string;
	oaRecoveryKind?: "substituted" | "rescued";
}

export interface UpdateNoteInput {
	title?: string;
	body?: string;
	status?: string;
	tags?: string[];
	aliases?: string[];
	summary?: string;
	metadata?: Record<string, unknown>;
}

export async function createVault(paths: VaultPaths): Promise<{ paths: VaultPaths; synced: number }> {
	await ensureVaultDirectories(paths);
	const summary = await syncVault(paths);
	return { paths, synced: summary.added + summary.updated + summary.unchanged };
}

export async function createNote(paths: VaultPaths, input: CreateNoteInput): Promise<VaultNoteSummary> {
	const title = input.title.trim();
	if (!title) throw new Error("Vault note title cannot be empty.");
	if (input.utilityScore !== undefined && (!Number.isFinite(input.utilityScore) || input.utilityScore < 0 || input.utilityScore > 18)) {
		throw new Error("Vault note utility score must be between 0 and 18.");
	}
	if (input.authorityScore !== undefined && (!Number.isFinite(input.authorityScore) || input.authorityScore < 0 || input.authorityScore > 1)) {
		throw new Error("Vault note authority score must be between 0 and 1.");
	}
	if (input.oaRecoveryKind !== undefined && !["substituted", "rescued"].includes(input.oaRecoveryKind)) {
		throw new Error("OA recovery kind must be substituted or rescued.");
	}
	await ensureVaultDirectories(paths);
	const id = input.id?.trim() || slugifyNoteTitle(title);
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(id)) throw new Error("Vault note id must start with a letter or number and contain only letters, numbers, dot, dash, or underscore.");
	const existing = await getNote(paths, id).catch(() => undefined);
	if (existing) throw new Error(`A vault note with id '${id}' already exists.`);
	let fileName = `${slugifyNoteTitle(title)}.md`;
	let targetPath = resolveVaultNotePath(paths, fileName);
	let suffix = 2;
	while (await fileExists(targetPath)) {
		fileName = `${slugifyNoteTitle(title)}-${suffix}.md`;
		targetPath = resolveVaultNotePath(paths, fileName);
		suffix += 1;
	}
	const created = new Date().toISOString();
	const frontmatter = {
		title,
		id,
		tags: input.tags ?? [],
		aliases: input.aliases ?? [],
		created,
		status: input.status ?? "draft",
		type: input.type ?? (input.source ? "raw" : "note"),
		...(input.source ? { source: input.source } : {}),
		...(input.tier ? { tier: input.tier } : {}),
		...(input.contentType ? { content_type: input.contentType } : {}),
		...(input.summary ? { summary: input.summary } : {}),
		...(input.doi ? { doi: input.doi } : {}),
		...(input.venue ? { venue: input.venue } : {}),
		...(input.citationCount !== undefined ? { citation_count: input.citationCount } : {}),
		...(input.utilityScore !== undefined ? { utility_score: input.utilityScore } : {}),
		...(input.authorityScore !== undefined ? { authority_score: input.authorityScore } : {}),
		...(input.sourceDomain ? { source_domain: input.sourceDomain } : {}),
		...(input.fetchedAt ? { fetched_at: input.fetchedAt } : {}),
		...(input.fetchProvider ? { fetch_provider: input.fetchProvider } : {}),
		...(input.oaUrl ? { oa_url: input.oaUrl } : {}),
		...(input.oaSource ? { oa_source: input.oaSource } : {}),
		...(input.oaVersion ? { oa_version: input.oaVersion } : {}),
		...(input.oaLicense ? { oa_license: input.oaLicense } : {}),
		...(input.oaRecoveryKind ? { oa_recovery_kind: input.oaRecoveryKind } : {}),
		...(input.isRetracted !== undefined ? { is_retracted: input.isRetracted } : {}),
	};
	await mkdir(dirname(targetPath), { recursive: true });
	await writeFile(targetPath, renderMarkdownNote(frontmatter, input.body), { encoding: "utf8", flag: "wx" });
	await syncVault(paths);
	return getNote(paths, id);
}

export async function getNote(paths: VaultPaths, id: string): Promise<VaultNoteSummary & { body: string; frontmatter: Record<string, unknown> }> {
	await syncVault(paths);
	const row = withVaultDatabase(paths, (db) => db.prepare(`
		SELECT n.*, nc.body FROM notes n JOIN note_content nc ON nc.note_id=n.id WHERE n.id=?
	`).get(id) as Record<string, unknown> | undefined, true);
	if (!row) throw new Error(`Vault note '${id}' was not found.`);
	const tags = withVaultDatabase(paths, (db) => db.prepare("SELECT tag FROM tags WHERE note_id=? ORDER BY tag").all(id) as { tag: string }[], true).map((item) => item.tag);
	const aliases = withVaultDatabase(paths, (db) => db.prepare("SELECT alias FROM aliases WHERE note_id=? ORDER BY alias").all(id) as { alias: string }[], true).map((item) => item.alias);
	return {
		...summaryFromRow(row, tags, aliases),
		body: String(row.body ?? ""),
		frontmatter: parseMarkdownNote(await readFile(resolveVaultNotePath(paths, String(row.path)), "utf8"), String(row.path)).frontmatter,
	};
}

export async function updateNote(paths: VaultPaths, id: string, input: UpdateNoteInput): Promise<VaultNoteSummary> {
	const current = await getNote(paths, id);
	const path = resolveVaultNotePath(paths, current.path);
	const metadata = {
		...current.frontmatter,
		...input.metadata,
		...(input.title ? { title: input.title.trim() } : {}),
		...(input.status ? { status: input.status } : {}),
		...(input.tags ? { tags: input.tags } : {}),
		...(input.aliases ? { aliases: input.aliases } : {}),
		...(input.summary !== undefined ? { summary: input.summary } : {}),
		updated: new Date().toISOString(),
	};
	const markdown = renderMarkdownNote(metadata as Record<string, unknown> & { title: string; id?: string }, input.body ?? current.body);
	const tempPath = `${path}.tmp-${process.pid}`;
	await writeFile(tempPath, markdown, "utf8");
	await rename(tempPath, path);
	await syncVault(paths);
	return getNote(paths, id);
}

export async function listNotes(paths: VaultPaths): Promise<VaultNoteSummary[]> {
	await syncVault(paths);
	return withVaultDatabase(paths, (db) => {
		const rows = db.prepare("SELECT * FROM notes ORDER BY updated DESC, created DESC, title COLLATE NOCASE").all() as Record<string, unknown>[];
		return rows.map((row) => {
			const tags = (db.prepare("SELECT tag FROM tags WHERE note_id=? ORDER BY tag").all(String(row.id)) as { tag: string }[]).map((item) => item.tag);
			const aliases = (db.prepare("SELECT alias FROM aliases WHERE note_id=? ORDER BY alias").all(String(row.id)) as { alias: string }[]).map((item) => item.alias);
			return summaryFromRow(row, tags, aliases);
		});
	}, true);
}

function summaryFromRow(row: Record<string, unknown>, tags: string[], aliases: string[]): VaultNoteSummary {
	return {
		id: String(row.id),
		title: String(row.title),
		path: String(row.path),
		status: String(row.status) as VaultNoteSummary["status"],
		type: String(row.type) as VaultNoteSummary["type"],
		...(typeof row.tier === "string" ? { tier: row.tier as VaultNoteSummary["tier"] } : {}),
		...(typeof row.content_type === "string" ? { contentType: row.content_type as VaultNoteSummary["contentType"] } : {}),
		...(typeof row.source === "string" ? { source: row.source } : {}),
		created: String(row.created),
		...(typeof row.updated === "string" ? { updated: row.updated } : {}),
		wordCount: Number(row.word_count ?? 0),
		tags,
		aliases,
		...(typeof row.quality_score === "number" ? { qualityScore: row.quality_score } : {}),
		...(typeof row.utility_score === "number" ? { utilityScore: row.utility_score } : {}),
		...(typeof row.authority_score === "number" ? { authorityScore: row.authority_score } : {}),
		...(typeof row.independence === "number" ? { independence: row.independence } : {}),
		...(typeof row.doi === "string" ? { doi: row.doi } : {}),
		...(typeof row.venue === "string" ? { venue: row.venue } : {}),
		...(typeof row.citation_count === "number" ? { citationCount: row.citation_count } : {}),
		...(typeof row.oa_url === "string" ? { oaUrl: row.oa_url } : {}),
		...(typeof row.oa_source === "string" ? { oaSource: row.oa_source } : {}),
		...(typeof row.oa_version === "string" ? { oaVersion: row.oa_version } : {}),
		...(typeof row.oa_license === "string" ? { oaLicense: row.oa_license } : {}),
		...(row.oa_recovery_kind === "substituted" || row.oa_recovery_kind === "rescued" ? { oaRecoveryKind: row.oa_recovery_kind } : {}),
		isRetracted: row.is_retracted === 1 || row.is_retracted === true,
	};
}

async function fileExists(path: string): Promise<boolean> {
	try { await readFile(path); return true; } catch (error) {
		return Boolean(error && typeof error === "object" && "code" in error && error.code === "EISDIR");
	}
}

export function notePathFromRow(paths: VaultPaths, path: string): string {
	return relative(paths.notesDir, resolveVaultNotePath(paths, path));
}

export function noteFileName(title: string): string {
	return basename(`${slugifyNoteTitle(title)}.md`);
}
