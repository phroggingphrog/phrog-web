import type { VaultPaths, VaultNoteSummary, VaultSearchResult } from "./types.js";
import { syncVault } from "./sync.js";
import { withVaultDatabase } from "./database.js";

export interface VaultSearchOptions {
	query: string;
	limit?: number;
	tags?: string[];
	status?: string;
	type?: string;
	tier?: string;
	includeArchived?: boolean;
	ranked?: boolean;
}

function ftsExpression(query: string): string {
	const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
	const unique = [...new Set(tokens.map((token) => token.trim()).filter(Boolean))].slice(0, 24);
	if (!unique.length) throw new Error("Vault search query must include letters or numbers.");
	return unique.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

export async function searchVault(paths: VaultPaths, options: VaultSearchOptions): Promise<VaultSearchResult[]> {
	const query = options.query.trim();
	if (!query) throw new Error("Vault search query cannot be empty.");
	const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 10)));
	await syncVault(paths);
	const where: string[] = ["notes_fts MATCH ?"];
	const params: (string | number)[] = [ftsExpression(query)];
	if (!options.includeArchived) where.push("n.status != 'archive'");
	if (options.status) { where.push("n.status = ?"); params.push(options.status); }
	if (options.type) { where.push("n.type = ?"); params.push(options.type); }
	if (options.tier) { where.push("n.tier = ?"); params.push(options.tier); }
	for (const tag of options.tags ?? []) {
		where.push("EXISTS (SELECT 1 FROM tags t WHERE t.note_id=n.id AND t.tag = ?)");
		params.push(tag);
	}
	params.push(limit);
	const ordering = options.ranked
		? "(0.5 + COALESCE(n.quality_score, 0.5)) * (-rank) DESC, rank ASC"
		: "rank ASC";
	return withVaultDatabase(paths, (db) => {
		const rows = db.prepare(`
			SELECT n.*, snippet(notes_fts, 2, '<mark>', '</mark>', ' … ', 22) AS snippet,
				bm25(notes_fts, 0.0, 3.0, 1.0, 0.4, 0.4) AS rank
			FROM notes_fts JOIN notes n ON n.id=notes_fts.id
			WHERE ${where.join(" AND ")}
			ORDER BY ${ordering}, n.title COLLATE NOCASE ASC
			LIMIT ?
		`).all(...params) as Record<string, unknown>[];
		return rows.map((row) => {
			const id = String(row.id);
			const tags = (db.prepare("SELECT tag FROM tags WHERE note_id=? ORDER BY tag").all(id) as { tag: string }[]).map((item) => item.tag);
			const aliases = (db.prepare("SELECT alias FROM aliases WHERE note_id=? ORDER BY alias").all(id) as { alias: string }[]).map((item) => item.alias);
			return {
				...summaryFromRow(row, tags, aliases),
				snippet: String(row.snippet ?? ""),
				score: Math.max(0, -Number(row.rank ?? 0)),
			};
		});
	});
}

export async function backlinks(paths: VaultPaths, id: string): Promise<VaultNoteSummary[]> {
	await syncVault(paths);
	return withVaultDatabase(paths, (db) => {
		const rows = db.prepare(`
			SELECT DISTINCT n.* FROM links l JOIN notes n ON n.id=l.source_id WHERE l.target_id=? ORDER BY n.title COLLATE NOCASE
		`).all(id) as Record<string, unknown>[];
		return rows.map((row) => {
			const noteId = String(row.id);
			const tags = (db.prepare("SELECT tag FROM tags WHERE note_id=? ORDER BY tag").all(noteId) as { tag: string }[]).map((item) => item.tag);
			const aliases = (db.prepare("SELECT alias FROM aliases WHERE note_id=? ORDER BY alias").all(noteId) as { alias: string }[]).map((item) => item.alias);
			return summaryFromRow(row, tags, aliases);
		});
	});
}

function summaryFromRow(row: Record<string, unknown>, tags: string[], aliases: string[]): VaultNoteSummary {
	return {
		id: String(row.id), title: String(row.title), path: String(row.path),
		status: String(row.status) as VaultNoteSummary["status"],
		type: String(row.type) as VaultNoteSummary["type"],
		...(typeof row.tier === "string" ? { tier: row.tier as VaultNoteSummary["tier"] } : {}),
		...(typeof row.content_type === "string" ? { contentType: row.content_type as VaultNoteSummary["contentType"] } : {}),
		...(typeof row.source === "string" ? { source: row.source } : {}), created: String(row.created),
		...(typeof row.updated === "string" ? { updated: row.updated } : {}), wordCount: Number(row.word_count ?? 0), tags, aliases,
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
