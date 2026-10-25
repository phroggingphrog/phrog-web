import type { DatabaseSync } from "node:sqlite";
import type { VaultPaths } from "./types.js";
import { syncVault } from "./sync.js";
import { withVaultDatabase } from "./database.js";
import { canonicalSourceUrl } from "./quality.js";

const NUMBERED_CITE_RE = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g;
const SOURCES_ENTRY_RE = /^\s*\[(\d{1,3})\]\s+(.+)$/;
const NUMBER_RE = /\d[\d,]*\.?\d*%?/g;
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z\u4e00-\u9fff])|\n+/;
const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;
const STRONG_MARKERS = ["%", "$", "billion", "million", "increase", "decrease", "grew", "fell"];

export interface CitationPair {
	sentence: string;
	noteId: string | null;
	numbers: string[];
	strong: boolean;
	verdict: "dangling" | "supported-mechanical" | "needs-review";
}

export interface CitationCheckResult {
	total: number;
	supportedMechanical: number;
	dangling: number;
	needsReview: number;
	pairs: CitationPair[];
}

function normalize(text: string): string {
	return text.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function resolveSourceSection(report: string, db: DatabaseSync): Map<string, string | null> {
	const mapping = new Map<string, string | null>();
	let inSources = false;
	for (const line of report.split(/\r?\n/)) {
		if (/^##\s+(?:Sources|References)\b/i.test(line)) { inSources = true; continue; }
		if (inSources && /^##\s+/.test(line)) break;
		if (!inSources) continue;
		const match = line.match(SOURCES_ENTRY_RE);
		if (!match) continue;
		const number = match[1]!;
		const text = match[2]!;
		let noteId: string | null = null;
		const url = text.match(/https?:\/\/\S+/)?.[0]?.replace(/[.,)]+$/, "");
		if (url) {
			const canonical = canonicalSourceUrl(url);
			const row = db.prepare("SELECT note_id FROM sources WHERE url=? OR url=? LIMIT 1").get(url, canonical) as { note_id?: string | null } | undefined;
			noteId = row?.note_id ?? null;
			if (!noteId) {
				const source = (db.prepare("SELECT id FROM notes WHERE source=? LIMIT 1").all(url) as { id: string }[])[0];
				noteId = source?.id ?? null;
			}
		}
		if (!noteId) {
			const title = text.split(/https?:\/\//)[0]?.trim().replace(/[.\s–—-]+$/, "");
			if (title) {
				const row = db.prepare("SELECT id FROM notes WHERE title=? COLLATE NOCASE LIMIT 1").get(title) as { id?: string } | undefined;
				noteId = row?.id ?? null;
			}
		}
		mapping.set(number, noteId);
	}
	return mapping;
}

function extractPairs(report: string, db: DatabaseSync): CitationPair[] {
	const sources = resolveSourceSection(report, db);
	const known = new Set((db.prepare("SELECT id FROM notes").all() as { id: string }[]).map((row) => row.id));
	const body = report.split(/^##\s+(?:Sources|References)\b/im, 1)[0] ?? report;
	const pairs: CitationPair[] = [];
	for (const sentence of body.split(SENTENCE_SPLIT_RE).map((part) => part.trim()).filter(Boolean)) {
		const cited: Array<string | null> = [];
		for (const match of sentence.matchAll(NUMBERED_CITE_RE)) {
			for (const number of (match[1] ?? "").split(/\s*,\s*/)) if (sources.has(number)) cited.push(sources.get(number) ?? null);
		}
		for (const match of sentence.matchAll(WIKI_LINK_RE)) {
			const target = (match[1] ?? "").split("|")[0]?.trim();
			if (target) cited.push(known.has(target) ? target : null);
		}
		for (const noteId of cited) {
			pairs.push({
				sentence,
				noteId,
				numbers: [...sentence.matchAll(NUMBER_RE)].map((match) => match[0]),
				strong: STRONG_MARKERS.some((marker) => sentence.toLocaleLowerCase().includes(marker)) || NUMBER_RE.test(sentence),
				verdict: noteId ? "needs-review" : "dangling",
			});
			NUMBER_RE.lastIndex = 0;
		}
	}
	return pairs;
}

function mechanicalTriage(pairs: CitationPair[], db: DatabaseSync): CitationCheckResult {
	let supportedMechanical = 0;
	let dangling = 0;
	const claimsCache = new Map<string, string>();
	for (const pair of pairs) {
		if (!pair.noteId) { pair.verdict = "dangling"; dangling += 1; continue; }
		let blob = claimsCache.get(pair.noteId);
		if (blob === undefined) {
			const rows = db.prepare("SELECT claim, quoted_support, numbers FROM claims WHERE note_id=?").all(pair.noteId) as Record<string, unknown>[];
			blob = normalize(rows.map((row) => [row.claim, row.quoted_support, row.numbers].filter(Boolean).join(" ")).join(" "));
			claimsCache.set(pair.noteId, blob);
		}
		const normalizedBlob = blob.replaceAll(",", "");
		const numbers = pair.numbers.filter((number) => number.replaceAll(",", "").length >= 2);
		let matched = false;
		if (numbers.length) matched = numbers.every((number) => normalizedBlob.includes(number.replaceAll(",", "")));
		else if (blob) {
			const words = normalize(pair.sentence).split(" ");
			for (let index = 0; index <= words.length - 6; index += 1) {
				if (blob.includes(words.slice(index, index + 6).join(" "))) { matched = true; break; }
			}
		}
		if (matched) { pair.verdict = "supported-mechanical"; supportedMechanical += 1; }
		else pair.verdict = "needs-review";
	}
	const needsReview = pairs.filter((pair) => pair.verdict === "needs-review").length;
	return { total: pairs.length, supportedMechanical, dangling, needsReview, pairs };
}

export async function checkReportCitations(paths: VaultPaths, reportText: string): Promise<CitationCheckResult> {
	await syncVault(paths);
	return withVaultDatabase(paths, (db) => mechanicalTriage(extractPairs(reportText, db), db), true);
}

export function sampleCitationsForReview(pairs: CitationPair[], sampleRate = 0.6): CitationPair[] {
	const rate = Math.min(1, Math.max(0, sampleRate));
	let weakSeen = 0;
	const selected: CitationPair[] = [];
	for (const pair of pairs) {
		if (pair.verdict !== "needs-review") continue;
		if (pair.strong) { selected.push(pair); continue; }
		weakSeen += 1;
		if (Math.floor(weakSeen * rate) > Math.floor((weakSeen - 1) * rate)) selected.push(pair);
	}
	return selected;
}
