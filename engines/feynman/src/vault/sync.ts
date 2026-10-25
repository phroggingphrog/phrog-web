import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { VaultPaths } from "./types.js";
import { extractClaims, extractWikiLinks, parseMarkdownNote, stripMarkdown, type NoteClaimRecord } from "./frontmatter.js";
import { ensureVaultDirectories } from "./paths.js";
import { withVaultDatabase } from "./database.js";

interface IndexedFile {
	relativePath: string;
	absPath: string;
	markdown: string;
	modifiedAt: number;
	hash: string;
	parsed: ReturnType<typeof parseMarkdownNote>;
	plainText: string;
	tagsText: string;
	aliasesText: string;
	claims: NoteClaimRecord[];
}

export interface VaultSyncSummary {
	added: number;
	updated: number;
	deleted: number;
	unchanged: number;
	linksIndexed: number;
	claimsIndexed: number;
}

async function markdownFiles(directory: string): Promise<string[]> {
	const result: string[] = [];
	const visit = async (current: string): Promise<void> => {
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch (error) {
			if (isMissing(error)) return;
			throw error;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const full = `${current}/${entry.name}`;
			if (entry.isDirectory()) await visit(full);
			else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") result.push(full);
		}
	};
	await visit(directory);
	return result.sort((a, b) => a.localeCompare(b));
}

function isMissing(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function dateString(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
	return undefined;
}

function writeArray(db: DatabaseSync, table: "tags" | "aliases", noteId: string, values: string[]): void {
	const column = table === "tags" ? "tag" : "alias";
	db.prepare(`DELETE FROM ${table} WHERE note_id = ?`).run(noteId);
	const insert = db.prepare(`INSERT OR IGNORE INTO ${table}(note_id, ${column}) VALUES (?, ?)`);
	for (const value of values) insert.run(noteId, value);
}

function resolveLinkTarget(db: DatabaseSync, target: string): string | null {
	const byId = db.prepare("SELECT id FROM notes WHERE id = ? COLLATE NOCASE").get(target) as { id?: string } | undefined;
	if (byId?.id) return byId.id;
	const byTitle = db.prepare("SELECT id FROM notes WHERE title = ? COLLATE NOCASE LIMIT 1").get(target) as { id?: string } | undefined;
	if (byTitle?.id) return byTitle.id;
	const byAlias = db.prepare("SELECT note_id AS id FROM aliases WHERE alias = ? COLLATE NOCASE LIMIT 1").get(target) as { id?: string } | undefined;
	return byAlias?.id ?? null;
}

function indexFiles(db: DatabaseSync, files: IndexedFile[]): VaultSyncSummary {
	const existing = db.prepare("SELECT id, path, content_hash FROM notes").all() as { id: string; path: string; content_hash: string }[];
	const oldById = new Map(existing.map((row) => [row.id, row]));
	const oldByPath = new Map(existing.map((row) => [row.path, row]));
	const oldIds = new Set(existing.map((row) => row.id));
	const incomingIds = new Set(files.map((file) => file.parsed.frontmatter.id));
	if (incomingIds.size !== files.length) throw new Error("Vault contains duplicate note ids; fix frontmatter before syncing.");

	const summary: VaultSyncSummary = { added: 0, updated: 0, deleted: 0, unchanged: 0, linksIndexed: 0, claimsIndexed: 0 };
	const now = new Date().toISOString();
	db.exec("BEGIN IMMEDIATE");
	try {
		for (const file of files) {
			const meta = file.parsed.frontmatter;
			const pathOwner = oldByPath.get(file.relativePath);
			if (pathOwner && pathOwner.id !== meta.id) {
				db.prepare("DELETE FROM notes_fts WHERE id = ?").run(pathOwner.id);
				db.prepare("DELETE FROM claims_fts WHERE claim_id IN (SELECT CAST(id AS TEXT) FROM claims WHERE note_id = ?)").run(pathOwner.id);
				db.prepare("DELETE FROM notes WHERE id = ?").run(pathOwner.id);
				oldIds.delete(pathOwner.id);
				summary.deleted += 1;
			}
			const previous = oldById.get(meta.id);
			const changed = !previous || previous.path !== file.relativePath || previous.content_hash !== file.hash;
			if (!changed) summary.unchanged += 1;
			else if (!previous) summary.added += 1;
			else summary.updated += 1;

			db.prepare(`
				INSERT INTO notes(
					id, title, path, status, type, tier, content_type, source, parent, deprecated,
					reviewed, expires, word_count, summary, created, updated, file_mtime, content_hash, synced_at,
					doi, utility_score, authority_score, citation_count, venue, is_retracted, oa_url, oa_source, oa_version, oa_license, oa_recovery_kind
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					title=excluded.title, path=excluded.path, status=excluded.status, type=excluded.type,
					tier=excluded.tier, content_type=excluded.content_type, source=excluded.source, parent=excluded.parent,
					deprecated=excluded.deprecated, reviewed=excluded.reviewed, expires=excluded.expires,
					word_count=excluded.word_count, summary=excluded.summary, created=excluded.created, updated=excluded.updated,
					file_mtime=excluded.file_mtime, content_hash=excluded.content_hash, synced_at=excluded.synced_at,
					doi=excluded.doi, utility_score=excluded.utility_score, authority_score=excluded.authority_score,
					citation_count=excluded.citation_count,
					venue=excluded.venue, is_retracted=excluded.is_retracted, oa_url=excluded.oa_url,
					oa_source=excluded.oa_source, oa_version=excluded.oa_version, oa_license=excluded.oa_license,
					oa_recovery_kind=excluded.oa_recovery_kind
			`).run(
				meta.id, meta.title, file.relativePath, meta.status, meta.type, meta.tier ?? null, meta.content_type ?? null,
				meta.source ?? null, meta.parent ?? null, meta.deprecated ? 1 : 0, dateString(meta.reviewed) ?? null,
				dateString(meta.expires) ?? null, meta.word_count ?? file.plainText.split(/\s+/).filter(Boolean).length,
				meta.summary ?? null, dateString(meta.created) ?? now, dateString(meta.updated) ?? null, file.modifiedAt,
				file.hash, now, meta.doi ?? null, meta.utility_score ?? null, meta.authority_score ?? null, meta.citation_count ?? null, meta.venue ?? null,
				typeof meta.is_retracted === "boolean" ? (meta.is_retracted ? 1 : 0) : null, meta.oa_url ?? null,
				meta.oa_source ?? null, meta.oa_version ?? null, meta.oa_license ?? null, meta.oa_recovery_kind ?? null,
			);

			db.prepare("INSERT OR REPLACE INTO note_content(note_id, body, body_plain) VALUES (?, ?, ?)").run(meta.id, file.parsed.body, file.plainText);
			writeArray(db, "tags", meta.id, meta.tags);
			writeArray(db, "aliases", meta.id, meta.aliases);
			db.prepare("DELETE FROM notes_fts WHERE id = ?").run(meta.id);
			db.prepare("INSERT INTO notes_fts(id, title, body_plain, tags, aliases) VALUES (?, ?, ?, ?, ?)")
				.run(meta.id, meta.title, file.plainText, file.tagsText, file.aliasesText);

			if (meta.source) {
				let domain: string | null = null;
				try { domain = new URL(meta.source).hostname.replace(/^www\./, ""); } catch {}
				db.prepare(`INSERT INTO sources(url, note_id, domain, fetched_at, provider, content_hash, status)
					VALUES (?, ?, ?, ?, ?, ?, 'active')
					ON CONFLICT(url) DO UPDATE SET note_id=excluded.note_id, domain=excluded.domain,
					fetched_at=excluded.fetched_at, provider=excluded.provider, content_hash=excluded.content_hash, status='active'`)
					.run(meta.source, meta.id, meta.source_domain ?? domain, dateString(meta.fetched_at) ?? null, meta.fetch_provider ?? null, file.hash);
			}
			db.prepare("DELETE FROM sources WHERE note_id = ? AND url != ?").run(meta.id, meta.source ?? "");

			const oldClaims = db.prepare("SELECT id FROM claims WHERE note_id = ? AND origin='markdown'").all(meta.id) as { id: number }[];
			for (const oldClaim of oldClaims) db.prepare("DELETE FROM claims_fts WHERE claim_id = ?").run(String(oldClaim.id));
			db.prepare("DELETE FROM claims WHERE note_id = ? AND origin='markdown'").run(meta.id);
			for (const claim of file.claims) {
				const claimHash = createHash("sha256").update(claim.claim.toLocaleLowerCase().replace(/\s+/g, " ").trim()).digest("hex");
				const numbers = claim.numbers === undefined ? null : JSON.stringify(claim.numbers);
				const inserted = db.prepare(`INSERT OR IGNORE INTO claims(
					note_id,claim,claim_hash,quoted_support,numbers,confidence,evidence_type,stance_target,stance,run_id,origin,ingested_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'markdown', ?)`)
					.run(meta.id, claim.claim, claimHash, claim.quotedSupport ?? null, numbers, claim.confidence ?? null,
						claim.evidenceType ?? null, claim.stanceTarget ?? null, claim.stance ?? null, claim.runId ?? null, now);
				const stored = db.prepare("SELECT id FROM claims WHERE note_id = ? AND claim_hash = ?").get(meta.id, claimHash) as { id?: number } | undefined;
				if (stored?.id !== undefined) {
					db.prepare("INSERT OR REPLACE INTO claims_fts(claim_id, claim, quoted_support) VALUES (?, ?, ?)")
						.run(String(stored.id), claim.claim, claim.quotedSupport ?? "");
					if (Number(inserted.changes) > 0) summary.claimsIndexed += 1;
				}
			}
		}

		for (const file of files) {
			const noteId = file.parsed.frontmatter.id;
			db.prepare("DELETE FROM links WHERE source_id = ?").run(noteId);
			for (const link of extractWikiLinks(file.parsed.body)) {
				db.prepare("INSERT OR REPLACE INTO links(source_id, target_ref, target_id, line_number, context) VALUES (?, ?, ?, ?, ?)")
					.run(noteId, link.target, resolveLinkTarget(db, link.target), link.line, link.context);
				summary.linksIndexed += 1;
			}
		}

		for (const id of oldIds) {
			if (incomingIds.has(id)) continue;
			db.prepare("DELETE FROM notes_fts WHERE id = ?").run(id);
			db.prepare("DELETE FROM claims_fts WHERE claim_id IN (SELECT CAST(id AS TEXT) FROM claims WHERE note_id = ?)").run(id);
			db.prepare("DELETE FROM notes WHERE id = ?").run(id);
			summary.deleted += 1;
		}
		db.exec("COMMIT");
		return summary;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

export async function syncVault(paths: VaultPaths): Promise<VaultSyncSummary> {
	await ensureVaultDirectories(paths);
	const absolutePaths = await markdownFiles(paths.notesDir);
	const files: IndexedFile[] = [];
	const ids = new Map<string, string>();
	for (const absPath of absolutePaths) {
		const markdown = await readFile(absPath, "utf8");
		const relativePath = relative(paths.notesDir, absPath).replace(/\\/g, "/");
		const parsed = parseMarkdownNote(markdown, relativePath);
		const previous = ids.get(parsed.frontmatter.id);
		if (previous) throw new Error(`Duplicate vault note id '${parsed.frontmatter.id}' in '${previous}' and '${relativePath}'.`);
		ids.set(parsed.frontmatter.id, relativePath);
		const info = await stat(absPath);
		const plainText = stripMarkdown(parsed.body);
		files.push({
			relativePath,
			absPath,
			markdown,
			modifiedAt: info.mtimeMs,
			hash: createHash("sha256").update(markdown).digest("hex"),
			parsed,
			plainText,
			tagsText: parsed.frontmatter.tags.join(" "),
			aliasesText: parsed.frontmatter.aliases.join(" "),
			claims: extractClaims(parsed.frontmatter, parsed.body),
		});
	}
	return withVaultDatabase(paths, (db) => indexFiles(db, files));
}
