import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	addClaim,
	backlinks,
	checkReportCitations,
	createNote,
	createVault,
	getNote,
	getVaultPaths,
	getVaultStatus,
	recomputeQualityScores,
	recomputeSourceIndependence,
	recomputeVaultCentrality,
	exportVaultMarkdown,
	importVaultMarkdown,
	searchClaims,
	searchVault,
	syncVault,
	updateNote,
} from "../../src/vault/index.js";

function formatText(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function boundedChars(value: number | undefined, fallback = 20_000): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(1_000, Math.min(60_000, Math.floor(value!)));
}

export function registerVaultTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "feynman_vault_status",
		label: "Research Vault Status",
		description: "Show whether the Markdown source vault is initialized and report indexed notes, sources, claims, links, and note lifecycle counts.",
		promptSnippet: "Check the local research vault state before searching or saving source notes.",
		promptGuidelines: ["The vault is a persistent local research corpus. Its Markdown files are canonical; SQLite is a rebuildable search index."],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const result = await getVaultStatus(getVaultPaths(ctx.cwd));
			return { content: [{ type: "text", text: formatText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "feynman_vault_init",
		label: "Initialize Research Vault",
		description: "Create the local Markdown source-vault structure and initialize its SQLite full-text index. Existing Markdown notes are indexed without rewriting them.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const paths = getVaultPaths(ctx.cwd);
			const result = await withFileMutationQueue(paths.dir, () => createVault(paths));
			return { content: [{ type: "text", text: formatText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "feynman_vault_search",
		label: "Research Vault Search",
		description: "Search the Markdown research vault using SQLite full-text search. Supports tag, lifecycle status, note type, and source-tier filters.",
		promptSnippet: "Reuse evidence already saved in the local research vault before fetching duplicate sources.",
		promptGuidelines: ["Vault search results are indexed note matches, not proof that their contents support a claim; read cited notes before relying on them."],
		parameters: Type.Object({
			query: Type.String({ description: "Words or phrase to search for." }),
			limit: Type.Optional(Type.Number({ description: "Maximum results, 1 to 100. Defaults to 10." })),
			tags: Type.Optional(Type.Array(Type.String(), { description: "Every supplied tag must match." })),
			status: Type.Optional(Type.String({ description: "Lifecycle status filter: draft, review, evergreen, stale, deprecated, archive." })),
			type: Type.Optional(Type.String({ description: "Note type filter: note, raw, index, moc, interim, source-analysis." })),
			tier: Type.Optional(Type.String({ description: "Evidence tier filter: ground_truth, institutional, practitioner, commentary, unknown." })),
			includeArchived: Type.Optional(Type.Boolean({ description: "Include archive notes. Defaults to false." })),
			ranked: Type.Optional(Type.Boolean({ description: "Multiply full-text relevance by the stored source-quality score after quality recomputation." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await searchVault(getVaultPaths(ctx.cwd), params);
			return { content: [{ type: "text", text: formatText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "feynman_vault_read",
		label: "Research Vault Read",
		description: "Read one source or research note by its stable note id, returning its frontmatter, provenance, tags, aliases, and body.",
		promptSnippet: "Read vault source text and provenance before citing or synthesizing an existing note.",
		parameters: Type.Object({
			id: Type.String({ description: "Stable note id returned by feynman_vault_search." }),
			maxChars: Type.Optional(Type.Number({ description: "Maximum note body characters to return, 1,000 to 60,000. Defaults to 20,000." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const note = await getNote(getVaultPaths(ctx.cwd), params.id);
			const maxChars = boundedChars(params.maxChars);
			const result = { ...note, body: note.body.slice(0, maxChars), truncated: note.body.length > maxChars, bodyChars: note.body.length };
			return { content: [{ type: "text", text: formatText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "feynman_vault_sync",
		label: "Research Vault Sync",
		description: "Rebuild the SQLite search index from canonical Markdown notes, refreshing tags, aliases, wiki links, sources, and claims.",
		promptSnippet: "Refresh the local research vault index after files change outside Feynman.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const paths = getVaultPaths(ctx.cwd);
			const result = await withFileMutationQueue(paths.dir, () => syncVault(paths));
			return { content: [{ type: "text", text: formatText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "feynman_vault_import",
		label: "Import Markdown Vault",
		description: "Explicitly import a directory of Markdown notes into the current project's source vault. Existing note ids and paths are never overwritten.",
		parameters: Type.Object({ sourceDirectory: Type.String() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const paths = getVaultPaths(ctx.cwd);
			const result = await withFileMutationQueue(paths.dir, () => importVaultMarkdown(paths, params.sourceDirectory));
			return { content: [{ type: "text", text: formatText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "feynman_vault_export",
		label: "Export Markdown Vault",
		description: "Export canonical Markdown notes to a new directory. The derived SQLite index is not exported.",
		parameters: Type.Object({ destinationDirectory: Type.String() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await exportVaultMarkdown(getVaultPaths(ctx.cwd), params.destinationDirectory);
			return { content: [{ type: "text", text: formatText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "feynman_vault_create_note",
		label: "Save Research Note",
		description: "Save source-backed evidence as a Markdown note in the local research vault with source URL, tags, evidence tier, and scholarly metadata.",
		promptSnippet: "Save reusable source evidence to the Markdown research vault with provenance and a concise summary.",
		promptGuidelines: ["Save the source text and its URL as provenance. Never present a source note as verified truth just because it is stored."],
		parameters: Type.Object({
			title: Type.String({ description: "Human-readable note title." }),
			body: Type.String({ description: "Markdown body containing the captured evidence and any source-specific caveats." }),
			id: Type.Optional(Type.String({ description: "Optional stable id; otherwise derived from the title." })),
			source: Type.Optional(Type.String({ description: "Original source URL." })),
			tags: Type.Optional(Type.Array(Type.String())),
			aliases: Type.Optional(Type.Array(Type.String())),
			tier: Type.Optional(Type.String({ description: "ground_truth, institutional, practitioner, commentary, or unknown." })),
			contentType: Type.Optional(Type.String({ description: "paper, docs, article, blog, forum, dataset, policy, code, book, transcript, review, or unknown." })),
			summary: Type.Optional(Type.String()),
			doi: Type.Optional(Type.String()),
			venue: Type.Optional(Type.String()),
			citationCount: Type.Optional(Type.Number()),
			utilityScore: Type.Optional(Type.Number()),
			authorityScore: Type.Optional(Type.Number()),
			sourceDomain: Type.Optional(Type.String()),
			fetchedAt: Type.Optional(Type.String()),
			fetchProvider: Type.Optional(Type.String()),
			oaUrl: Type.Optional(Type.String()),
			oaSource: Type.Optional(Type.String()),
			oaVersion: Type.Optional(Type.String()),
			oaLicense: Type.Optional(Type.String()),
			oaRecoveryKind: Type.Optional(Type.Union([Type.Literal("substituted"), Type.Literal("rescued")])),
			isRetracted: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const paths = getVaultPaths(ctx.cwd);
			const result = await withFileMutationQueue(paths.dir, () => createNote(paths, params));
			return { content: [{ type: "text", text: formatText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "feynman_vault_update_note",
		label: "Update Research Note",
		description: "Update a vault note's Markdown body or frontmatter fields while keeping Markdown as the canonical content.",
		parameters: Type.Object({
			id: Type.String(),
			title: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()),
			status: Type.Optional(Type.String()),
			tags: Type.Optional(Type.Array(Type.String())),
			aliases: Type.Optional(Type.Array(Type.String())),
			summary: Type.Optional(Type.String()),
			metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { id, ...patch } = params;
			const paths = getVaultPaths(ctx.cwd);
			const result = await withFileMutationQueue(paths.dir, () => updateNote(paths, id, patch));
			return { content: [{ type: "text", text: formatText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "feynman_vault_backlinks",
		label: "Research Vault Backlinks",
		description: "List notes that link to a vault note using [[wiki-links]].",
		parameters: Type.Object({ id: Type.String({ description: "Target note id." }) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await backlinks(getVaultPaths(ctx.cwd), params.id);
			return { content: [{ type: "text", text: formatText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "feynman_vault_claim_add",
		label: "Record Evidence Claim",
		description: "Record a source-backed claim under a vault note's Claims section so citations can be checked against saved evidence.",
		parameters: Type.Object({
			noteId: Type.String(),
			claim: Type.String(),
			quotedSupport: Type.Optional(Type.String()),
			confidence: Type.Optional(Type.String()),
			evidenceType: Type.Optional(Type.String()),
			stanceTarget: Type.Optional(Type.String()),
			stance: Type.Optional(Type.String()),
			runId: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { noteId, ...claim } = params;
			const paths = getVaultPaths(ctx.cwd);
			const result = await withFileMutationQueue(paths.dir, () => addClaim(paths, noteId, claim));
			return { content: [{ type: "text", text: formatText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "feynman_vault_claim_search",
		label: "Research Claim Search",
		description: "Search claims saved with source notes, optionally limited to one research run.",
		parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()), runId: Type.Optional(Type.String()) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await searchClaims(getVaultPaths(ctx.cwd), params);
			return { content: [{ type: "text", text: formatText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "feynman_vault_cite_check",
		label: "Citation Evidence Check",
		description: "Mechanically check report citations against saved vault sources and claims. Returns dangling citations, mechanically supported pairs, and claims that need an agent's source-text review; it does not certify truth.",
		parameters: Type.Object({ report: Type.String({ description: "Complete Markdown report text to check." }) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await checkReportCitations(getVaultPaths(ctx.cwd), params.report);
			return { content: [{ type: "text", text: formatText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "feynman_vault_recompute_quality",
		label: "Recompute Source Quality",
		description: "Recompute source independence, wiki-link graph centrality, and the composite quality score across the local vault.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const paths = getVaultPaths(ctx.cwd);
			const result = await withFileMutationQueue(paths.dir, async () => {
				const independence = await recomputeSourceIndependence(paths);
				const centrality = await recomputeVaultCentrality(paths);
				const quality = await recomputeQualityScores(paths);
				return { independence, centrality, quality };
			});
			return { content: [{ type: "text", text: formatText(result) }], details: result };
		},
	});
}
