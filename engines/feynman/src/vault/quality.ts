import type { VaultPaths } from "./types.js";
import { syncVault } from "./sync.js";
import { withVaultDatabase } from "./database.js";

export interface RankingWeights {
	tier: number;
	utility: number;
	authority: number;
	centrality: number;
	retractionFloor: number;
}

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
	tier: 0.35,
	utility: 0.2,
	authority: 0.25,
	centrality: 0.2,
	retractionFloor: 0.05,
};

const TIER_SCORES: Record<string, number> = {
	ground_truth: 1,
	institutional: 0.85,
	practitioner: 0.7,
	commentary: 0.4,
	unknown: 0.6,
};

export function computeQualityScore(input: {
	tier?: string;
	utilityScore?: number;
	authorityScore?: number;
	centralityScore?: number;
	isRetracted?: boolean;
}, weights = DEFAULT_RANKING_WEIGHTS): number | null {
	if (input.isRetracted) return weights.retractionFloor;
	const components: [number, number][] = [];
	if (input.tier && TIER_SCORES[input.tier] !== undefined) components.push([weights.tier, TIER_SCORES[input.tier]!]);
	if (input.utilityScore !== undefined && Number.isFinite(input.utilityScore)) components.push([weights.utility, clamp(input.utilityScore / 18)]);
	if (input.authorityScore !== undefined && Number.isFinite(input.authorityScore)) components.push([weights.authority, clamp(input.authorityScore)]);
	if (input.centralityScore !== undefined && Number.isFinite(input.centralityScore)) components.push([weights.centrality, clamp(input.centralityScore)]);
	const total = components.reduce((sum, [weight]) => sum + weight, 0);
	return total > 0 ? components.reduce((sum, [weight, value]) => sum + weight * value, 0) / total : null;
}

function clamp(value: number): number {
	return Math.min(1, Math.max(0, value));
}

export async function recomputeQualityScores(paths: VaultPaths, weights = DEFAULT_RANKING_WEIGHTS): Promise<number> {
	await syncVault(paths);
	return withVaultDatabase(paths, (db) => {
		const rows = db.prepare("SELECT id, tier, utility_score, authority_score, centrality_score, is_retracted FROM notes").all() as Record<string, unknown>[];
		const update = db.prepare("UPDATE notes SET quality_score=? WHERE id=?");
		for (const row of rows) {
			const score = computeQualityScore({
				tier: typeof row.tier === "string" ? row.tier : undefined,
				utilityScore: numberOrUndefined(row.utility_score),
				authorityScore: numberOrUndefined(row.authority_score),
				centralityScore: numberOrUndefined(row.centrality_score),
				isRetracted: row.is_retracted === 1 || row.is_retracted === true,
			}, weights);
			update.run(score, String(row.id));
		}
		return rows.length;
	});
}

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function pageRank(nodes: string[], edges: Array<[string, string]>, options: { damping?: number; maxIterations?: number; convergence?: number } = {}): Map<string, number> {
	if (!nodes.length) return new Map();
	const damping = options.damping ?? 0.85;
	const maxIterations = options.maxIterations ?? 50;
	const convergence = options.convergence ?? 1e-6;
	const nodeSet = new Set(nodes);
	const outgoing = new Map(nodes.map((id) => [id, new Set<string>()]));
	for (const [source, target] of edges) {
		if (source !== target && nodeSet.has(source) && nodeSet.has(target)) outgoing.get(source)?.add(target);
	}
	const incoming = new Map(nodes.map((id) => [id, [] as string[]]));
	for (const [source, targets] of outgoing) for (const target of targets) incoming.get(target)?.push(source);
	let ranks = new Map(nodes.map((id) => [id, 1 / nodes.length]));
	const base = (1 - damping) / nodes.length;
	for (let iteration = 0; iteration < maxIterations; iteration += 1) {
		let dangling = 0;
		for (const [id, targets] of outgoing) if (!targets.size) dangling += ranks.get(id) ?? 0;
		const next = new Map<string, number>();
		for (const id of nodes) {
			const inbound = (incoming.get(id) ?? []).reduce((sum, source) => sum + (ranks.get(source) ?? 0) / (outgoing.get(source)?.size || 1), 0);
			next.set(id, base + damping * (inbound + dangling / nodes.length));
		}
		const delta = nodes.reduce((sum, id) => sum + Math.abs((next.get(id) ?? 0) - (ranks.get(id) ?? 0)), 0);
		ranks = next;
		if (delta < convergence) break;
	}
	return ranks;
}

export async function recomputeVaultCentrality(paths: VaultPaths): Promise<number> {
	await syncVault(paths);
	return withVaultDatabase(paths, (db) => {
		const nodes = (db.prepare("SELECT id FROM notes WHERE COALESCE(summary, '') NOT LIKE 'Resolver-minted stub:%'").all() as { id: string }[]).map((row) => row.id);
		const edges = (db.prepare("SELECT source_id, target_id FROM links WHERE target_id IS NOT NULL").all() as { source_id: string; target_id: string }[]).map((row) => [row.source_id, row.target_id] as [string, string]);
		const scores = pageRank(nodes, edges);
		const maximum = Math.max(0, ...scores.values());
		const update = db.prepare("UPDATE notes SET centrality_score=? WHERE id=?");
		for (const [id, score] of scores) update.run(maximum > 0 ? score / maximum : 0, id);
		return scores.size;
	});
}

interface IndependenceNote {
	id: string;
	source: string;
	title: string;
	created: string;
	body: string;
	content_hash: string;
}

export function canonicalSourceUrl(value: string): string {
	try {
		const url = new URL(value.trim());
		const host = url.hostname.toLowerCase().replace(/^www\./, "");
		const query = [...url.searchParams.entries()]
			.filter(([key]) => !/^(utm_|fbclid|gclid|ref$|source$)/i.test(key))
			.sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
		url.protocol = "https:";
		url.hostname = host;
		url.pathname = url.pathname.replace(/\/$/, "");
		url.search = new URLSearchParams(query).toString();
		url.hash = "";
		return url.toString();
	} catch {
		return value.trim().toLowerCase();
	}
}

function textShingles(text: string, size = 3): Set<string> {
	const words = text.toLocaleLowerCase().split(/\s+/).filter(Boolean);
	if (words.length < size) return words.length ? new Set([words.join(" ")]) : new Set();
	const result = new Set<string>();
	for (let index = 0; index <= words.length - size; index += 1) result.add(words.slice(index, index + size).join(" "));
	return result;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (!a.size || !b.size) return 0;
	let common = 0;
	for (const item of a) if (b.has(item)) common += 1;
	return common / (a.size + b.size - common);
}

function wireSignature(body: string): string | undefined {
	const head = body.slice(0, 1500).toLowerCase();
	const marker = ["prnewswire", "pr newswire", "business wire", "businesswire", "globe newswire", "globenewswire", "(reuters)", "(ap)", "associated press", "accesswire", "newsfile corp"].find((item) => head.includes(item));
	if (!marker) return undefined;
	return `${marker}|${(head.match(/[a-z0-9]{4,}/g) ?? []).slice(0, 10).join(" ")}`;
}

export async function recomputeSourceIndependence(paths: VaultPaths, threshold = 0.7): Promise<{ scored: number; clusters: Array<{ root: string; members: string[]; size: number; kind: string }> }> {
	await syncVault(paths);
	return withVaultDatabase(paths, (db) => {
		const rows = db.prepare(`SELECT n.id,n.source,n.title,n.created,n.content_hash,nc.body_plain AS body
			FROM notes n JOIN note_content nc ON nc.note_id=n.id WHERE n.source IS NOT NULL AND n.type!='index'`).all() as unknown as IndependenceNote[];
		const parents = new Map(rows.map((row) => [row.id, row.id]));
		const pairKinds = new Map<string, Set<string>>();
		const find = (id: string): string => {
			const parent = parents.get(id) ?? id;
			if (parent !== id) parents.set(id, find(parent));
			return parents.get(id) ?? id;
		};
		const union = (a: string, b: string, kind: string): void => {
			const rootA = find(a); const rootB = find(b);
			if (rootA !== rootB) parents.set(rootB, rootA);
			const key = [a, b].sort().join("\0");
			const kinds = pairKinds.get(key) ?? new Set<string>();
			kinds.add(kind); pairKinds.set(key, kinds);
		};
		const groupBy = (keyOf: (row: IndependenceNote) => string | undefined, kind: string): void => {
			const groups = new Map<string, string[]>();
			for (const row of rows) {
				const key = keyOf(row);
				if (key) groups.set(key, [...(groups.get(key) ?? []), row.id]);
			}
			for (const ids of groups.values()) for (let index = 1; index < ids.length; index += 1) union(ids[0]!, ids[index]!, kind);
		};
		groupBy((row) => canonicalSourceUrl(row.source), "url");
		groupBy((row) => row.content_hash, "body");
		groupBy((row) => wireSignature(row.body), "wire");
		const shingles = new Map(rows.map((row) => [row.id, textShingles(row.body)]));
		for (let a = 0; a < rows.length; a += 1) {
			for (let b = a + 1; b < rows.length; b += 1) {
				const left = rows[a]!; const right = rows[b]!;
				if (find(left.id) !== find(right.id) && jaccard(shingles.get(left.id)!, shingles.get(right.id)!) >= threshold) union(left.id, right.id, "near-duplicate");
			}
		}
		const grouped = new Map<string, IndependenceNote[]>();
		for (const row of rows) grouped.set(find(row.id), [...(grouped.get(find(row.id)) ?? []), row]);
		const update = db.prepare("UPDATE notes SET independence=? WHERE id=?");
		const clusters: Array<{ root: string; members: string[]; size: number; kind: string }> = [];
		for (const members of grouped.values()) {
			members.sort((a, b) => a.created.localeCompare(b.created));
			const root = members[0]!;
			const share = 1 / members.length;
			members.forEach((row, index) => update.run(index === 0 ? 1 : share, row.id));
			if (members.length < 2) continue;
			const kinds = new Set<string>();
			for (let i = 0; i < members.length; i += 1) for (let j = i + 1; j < members.length; j += 1) {
				for (const kind of pairKinds.get([members[i]!.id, members[j]!.id].sort().join("\0")) ?? []) kinds.add(kind);
			}
			clusters.push({ root: root.id, members: members.slice(1).map((row) => row.id), size: members.length, kind: [...kinds].sort().join("+") || "mixed" });
		}
		return { scored: rows.length, clusters };
	});
}

