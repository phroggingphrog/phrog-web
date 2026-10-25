import { createHash } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";
import type { VaultClaim, VaultPaths } from "./types.js";
import { syncVault } from "./sync.js";
import { withVaultDatabase } from "./database.js";
import { getNote, updateNote } from "./notes.js";

export interface AddClaimInput {
	claim: string;
	quotedSupport?: string;
	confidence?: string;
	evidenceType?: string;
	stanceTarget?: string;
	stance?: string;
	runId?: string;
}

export interface ClaimSearchOptions {
	query: string;
	limit?: number;
	runId?: string;
}

export async function addClaim(paths: VaultPaths, noteId: string, input: AddClaimInput): Promise<VaultClaim> {
	const claim = input.claim.trim();
	if (claim.length < 8) throw new Error("A claim must contain at least eight characters.");
	const note = await getNote(paths, noteId);
	const lines = note.body.split(/\r?\n/);
	const headingIndex = lines.findIndex((line) => /^#{1,3}\s+(?:Claims|Key Claims)\s*$/i.test(line.trim()));
	let body: string;
	if (headingIndex >= 0) {
		let sectionEnd = lines.length;
		for (let index = headingIndex + 1; index < lines.length; index += 1) {
			if (/^#{1,3}\s+/.test(lines[index]?.trim() ?? "")) { sectionEnd = index; break; }
		}
		const section = lines.slice(headingIndex + 1, sectionEnd);
		if (!section.some((line) => line.replace(/^\s*[-*+]\s+/, "").trim().toLowerCase() === claim.toLowerCase())) {
			section.push(`- ${claim}`);
		}
		body = [...lines.slice(0, headingIndex + 1), ...section, ...lines.slice(sectionEnd)].join("\n");
	} else {
		body = `${note.body.trimEnd()}\n\n## Claims\n\n- ${claim}\n`;
	}
	const existingClaims = Array.isArray(note.frontmatter.claims) ? note.frontmatter.claims : [];
	const existingIndex = existingClaims.findIndex((value) => {
		if (typeof value === "string") return value.toLowerCase().replace(/\s+/g, " ").trim() === claim.toLowerCase().replace(/\s+/g, " ").trim();
		return Boolean(value && typeof value === "object" && !Array.isArray(value) && "claim" in value && typeof value.claim === "string" && value.claim.toLowerCase().replace(/\s+/g, " ").trim() === claim.toLowerCase().replace(/\s+/g, " ").trim());
	});
	const normalizedClaim = {
		claim,
		...(input.quotedSupport ? { quotedSupport: input.quotedSupport } : {}),
		...(input.confidence ? { confidence: input.confidence } : {}),
		...(input.evidenceType ? { evidenceType: input.evidenceType } : {}),
		...(input.stanceTarget ? { stanceTarget: input.stanceTarget } : {}),
		...(input.stance ? { stance: input.stance } : {}),
		...(input.runId ? { runId: input.runId } : {}),
	};
	const nextClaims = [...existingClaims];
	if (existingIndex >= 0) {
		const previous = nextClaims[existingIndex];
		nextClaims[existingIndex] = { ...(typeof previous === "object" && previous !== null ? previous : {}), ...normalizedClaim };
	} else nextClaims.push(normalizedClaim);
	await updateNote(paths, noteId, { body, metadata: { claims: nextClaims } });
	await syncVault(paths);
	const hash = createHash("sha256").update(claim.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex");
	return withVaultDatabase(paths, (db) => {
		const row = db.prepare("SELECT * FROM claims WHERE note_id = ? AND claim_hash = ?").get(noteId, hash) as Record<string, unknown> | undefined;
		if (!row) throw new Error("Could not store the claim in the vault index.");
		return claimFromRow(row);
	});
}

export async function searchClaims(paths: VaultPaths, options: ClaimSearchOptions): Promise<VaultClaim[]> {
	const tokens = options.query.trim().match(/[\p{L}\p{N}_]+/gu) ?? [];
	if (!tokens.length) throw new Error("Claim search query must contain letters or numbers.");
	const expression = [...new Set(tokens)].slice(0, 24).map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
	await syncVault(paths);
	const where = ["claims_fts MATCH ?"];
	const params: (string | number)[] = [expression];
	if (options.runId) { where.push("c.run_id = ?"); params.push(options.runId); }
	params.push(Math.max(1, Math.min(100, Math.floor(options.limit ?? 20))));
	return withVaultDatabase(paths, (db) => {
		const rows = db.prepare(`SELECT c.* FROM claims_fts JOIN claims c ON c.id=CAST(claims_fts.claim_id AS INTEGER)
			WHERE ${where.join(" AND ")} ORDER BY bm25(claims_fts) LIMIT ?`).all(...params) as Record<string, unknown>[];
		return rows.map(claimFromRow);
	});
}

function claimFromRow(row: Record<string, unknown>): VaultClaim {
	let numbers: unknown;
	if (typeof row.numbers === "string") {
		try { numbers = JSON.parse(row.numbers); } catch { numbers = row.numbers; }
	}
	return {
		id: Number(row.id), noteId: String(row.note_id), claim: String(row.claim),
		...(typeof row.quoted_support === "string" ? { quotedSupport: row.quoted_support } : {}),
		...(numbers !== undefined ? { numbers } : {}),
		...(typeof row.confidence === "string" ? { confidence: row.confidence } : {}),
		...(typeof row.evidence_type === "string" ? { evidenceType: row.evidence_type } : {}),
		...(typeof row.stance_target === "string" ? { stanceTarget: row.stance_target } : {}),
		...(typeof row.stance === "string" ? { stance: row.stance } : {}),
		...(typeof row.run_id === "string" ? { runId: row.run_id } : {}),
		createdAt: String(row.ingested_at),
	};
}

export function indexClaimFields(db: DatabaseSync, noteId: string, claim: string, extra: { quotedSupport?: string; runId?: string } = {}): void {
	const hash = createHash("sha256").update(claim.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex");
	const result = db.prepare(`INSERT OR IGNORE INTO claims(note_id, claim, claim_hash, quoted_support, run_id, origin, ingested_at)
		VALUES (?, ?, ?, ?, ?, 'run', ?)`)
		.run(noteId, claim, hash, extra.quotedSupport ?? null, extra.runId ?? null, new Date().toISOString());
	const row = db.prepare("SELECT id FROM claims WHERE note_id = ? AND claim_hash = ?").get(noteId, hash) as { id?: number } | undefined;
	if (row?.id !== undefined && Number(result.changes) > 0) {
		db.prepare("INSERT INTO claims_fts(claim_id, claim, quoted_support) VALUES (?, ?, ?)").run(String(row.id), claim, extra.quotedSupport ?? "");
	}
}
