import { createHash } from "node:crypto";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { CONTENT_TYPES, NOTE_STATUSES, NOTE_TYPES, SOURCE_TIERS, type NoteFrontmatter, type ParsedNote } from "./types.js";

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
	if (typeof value === "string" && value.trim()) return [value.trim()];
	return [];
}

function enumValue<T extends readonly string[]>(value: unknown, values: T, fallback: T[number]): T[number] {
	return typeof value === "string" && values.includes(value as T[number]) ? value as T[number] : fallback;
}

export function slugifyNoteTitle(title: string): string {
	const normalized = title.normalize("NFC").toLocaleLowerCase().trim();
	let slug = normalized.replace(/[^\p{L}\p{N}_\s-]/gu, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
	if (!slug) slug = `note-${createHash("sha256").update(title).digest("hex").slice(0, 8)}`;
	if (slug.length > 80) slug = slug.slice(0, 80).replace(/-+$/g, "");
	while (Buffer.byteLength(slug, "utf8") > 200) slug = [...slug].slice(0, -1).join("");
	return slug;
}

function normalizeFrontmatter(input: unknown, fallbackTitle: string): NoteFrontmatter {
	const value = asRecord(input);
	const title = typeof value.title === "string" && value.title.trim() ? value.title.trim() : fallbackTitle;
	const tags = strings(value.tags);
	const aliases = strings(value.aliases);
	const optionalStrings = ["updated", "source", "source_domain", "fetched_at", "fetch_provider", "parent", "reviewed", "expires", "summary", "doi", "venue", "oa_url", "oa_source", "oa_version", "oa_license"] as const;
	const result: Record<string, unknown> = {
		...value,
		title,
		id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : slugifyNoteTitle(title),
		tags,
		aliases,
		created: typeof value.created === "string" ? value.created : new Date().toISOString(),
		status: enumValue(value.status, NOTE_STATUSES, "draft"),
		type: enumValue(value.type, NOTE_TYPES, "note"),
		deprecated: value.deprecated === true,
	};
	for (const key of optionalStrings) {
		if (typeof value[key] !== "string" || !value[key]?.trim()) delete result[key];
	}
	if (typeof value.tier === "string" && SOURCE_TIERS.includes(value.tier as (typeof SOURCE_TIERS)[number])) result.tier = value.tier;
	else delete result.tier;
	if (typeof value.content_type === "string" && CONTENT_TYPES.includes(value.content_type as (typeof CONTENT_TYPES)[number])) result.content_type = value.content_type;
	else delete result.content_type;
	for (const key of ["word_count", "citation_count", "utility_score", "authority_score"] as const) {
		if (typeof value[key] !== "number" || !Number.isFinite(value[key])) delete result[key];
	}
	if (typeof value.is_retracted !== "boolean") delete result.is_retracted;
	if (value.oa_recovery_kind !== "substituted" && value.oa_recovery_kind !== "rescued") delete result.oa_recovery_kind;
	return result as NoteFrontmatter;
}

export function parseMarkdownNote(markdown: string, relativePath: string): ParsedNote {
	const match = markdown.match(FRONTMATTER_RE);
	let rawFrontmatter: unknown = {};
	let body = markdown;
	if (match) {
		rawFrontmatter = parseYaml(match[1] ?? "") ?? {};
		body = markdown.slice(match[0].length);
	}
	const titleFromBody = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
	const titleFromPath = relativePath.replace(/\\/g, "/").split("/").pop()?.replace(/\.md$/i, "") ?? "Untitled";
	const frontmatter = normalizeFrontmatter(rawFrontmatter, titleFromBody || titleFromPath);
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(frontmatter.id)) {
		throw new Error(`Invalid vault note id '${frontmatter.id}' in ${relativePath}.`);
	}
	return { frontmatter, body: body.trimStart(), path: relativePath.replace(/\\/g, "/") };
}

export function renderMarkdownNote(frontmatter: Record<string, unknown> & { title: string; id?: string }, body: string): string {
	const metadata = normalizeFrontmatter(frontmatter, frontmatter.title);
	return `---\n${stringifyYaml(metadata, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.trim()}\n`;
}

export function stripMarkdown(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
		.replace(/<[^>]+>/g, " ")
		.replace(/[>#*_~|]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export interface WikiLink {
	target: string;
	line: number;
	context: string;
}

export interface NoteClaimRecord {
	claim: string;
	quotedSupport?: string;
	numbers?: unknown;
	confidence?: string;
	evidenceType?: string;
	stanceTarget?: string;
	stance?: string;
	runId?: string;
}

export function extractWikiLinks(body: string): WikiLink[] {
	const links: WikiLink[] = [];
	const lines = body.split(/\r?\n/);
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex] ?? "";
		for (const match of line.matchAll(WIKI_LINK_RE)) {
			const target = (match[1] ?? "").split("|")[0]?.trim();
			if (target) links.push({ target, line: lineIndex + 1, context: line.trim().slice(0, 500) });
		}
	}
	return links;
}

export function extractClaimLines(body: string): string[] {
	const lines = body.split(/\r?\n/);
	const start = lines.findIndex((line) => /^#{1,3}\s+(?:Claims|Key Claims)\s*$/i.test(line.trim()));
	if (start < 0) return [];
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) {
		if (/^#{1,3}\s+/.test(lines[index]?.trim() ?? "")) { end = index; break; }
	}
	return lines.slice(start + 1, end)
		.map((line) => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "").trim())
		.filter((line) => line.length >= 8);
}

export function extractClaims(frontmatter: NoteFrontmatter, body: string): NoteClaimRecord[] {
	const output: NoteClaimRecord[] = [];
	for (const raw of Array.isArray(frontmatter.claims) ? frontmatter.claims : []) {
		if (typeof raw === "string" && raw.trim()) { output.push({ claim: raw.trim() }); continue; }
		const value = asRecord(raw);
		if (typeof value.claim !== "string" || value.claim.trim().length < 8) continue;
		output.push({
			claim: value.claim.trim(),
			...(typeof value.quotedSupport === "string" ? { quotedSupport: value.quotedSupport } : {}),
			...(value.numbers !== undefined ? { numbers: value.numbers } : {}),
			...(typeof value.confidence === "string" ? { confidence: value.confidence } : {}),
			...(typeof value.evidenceType === "string" ? { evidenceType: value.evidenceType } : {}),
			...(typeof value.stanceTarget === "string" ? { stanceTarget: value.stanceTarget } : {}),
			...(typeof value.stance === "string" ? { stance: value.stance } : {}),
			...(typeof value.runId === "string" ? { runId: value.runId } : {}),
		});
	}
	for (const claim of extractClaimLines(body)) output.push({ claim });
	const seen = new Set<string>();
	return output.filter((item) => {
		const key = item.claim.toLocaleLowerCase().replace(/\s+/g, " ").trim();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
