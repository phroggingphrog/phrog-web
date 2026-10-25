import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { VaultPaths } from "./types.js";
import { addClaim, searchClaims } from "./claims.js";
import { backlinks, searchVault } from "./search.js";
import { checkReportCitations } from "./citations.js";
import { exportVaultMarkdown, importVaultMarkdown } from "./transfer.js";
import { createNote, createVault, getNote, listNotes, updateNote } from "./notes.js";
import { getVaultStatus } from "./status.js";
import { recomputeQualityScores, recomputeSourceIndependence, recomputeVaultCentrality } from "./quality.js";
import { syncVault } from "./sync.js";

export type VaultCliValues = Record<string, string | boolean | undefined>;

function splitList(value: string | boolean | undefined): string[] | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function numberOption(value: string | boolean | undefined): number | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`Expected a number, got '${value}'.`);
	return parsed;
}

function output(value: unknown, json: boolean): void {
	if (json) console.log(JSON.stringify(value, null, 2));
	else if (typeof value === "string") console.log(value);
	else if (Array.isArray(value)) console.log(value.map((entry) => JSON.stringify(entry)).join("\n"));
	else console.log(JSON.stringify(value, null, 2));
}

function usage(): never {
	throw new Error([
		"Usage: feynman vault <init|sync|status|search|list|read|note|backlinks|claim|quality|cite-check|import|export>",
		"Examples:",
		"  feynman vault init",
		"  feynman vault search \"causal inference\" --limit 10 --tag methods --json",
		"  feynman vault note create --title \"Source title\" --source https://example.org --body \"Evidence text\"",
		"  feynman vault read <note-id> --json",
	].join("\n"));
}

export async function runVaultCommand(args: string[], paths: VaultPaths, values: VaultCliValues = {}): Promise<void> {
	const [action, ...rest] = args;
	const json = values.json === true;
	if (!action || action === "help" || values.help === true) usage();

	if (action === "init") { output(await createVault(paths), json); return; }
	if (action === "sync") { output(await syncVault(paths), json); return; }
	if (action === "import") { if (!rest[0]) usage(); output(await importVaultMarkdown(paths, rest[0]!), json); return; }
	if (action === "export") { if (!rest[0]) usage(); output(await exportVaultMarkdown(paths, rest[0]!), json); return; }
	if (action === "status") { output(await getVaultStatus(paths), json); return; }
	if (action === "list") { output(await listNotes(paths), json); return; }
	if (action === "search") {
		const query = rest.join(" ").trim();
		if (!query) usage();
		output(await searchVault(paths, {
			query,
			limit: numberOption(values.limit),
			tags: splitList(values.tag ?? values.tags),
			status: typeof values.status === "string" ? values.status : undefined,
			type: typeof values.type === "string" ? values.type : undefined,
			tier: typeof values.tier === "string" ? values.tier : undefined,
			includeArchived: values["include-archived"] === true,
			ranked: values.ranked === true,
		}), json);
		return;
	}
	if (action === "read") { if (!rest[0]) usage(); output(await getNote(paths, rest[0]!), json); return; }
	if (action === "backlinks") { if (!rest[0]) usage(); output(await backlinks(paths, rest[0]!), json); return; }
	if (action === "note") {
		const [operation, ...noteArgs] = rest;
		if (operation === "create") {
			if (typeof values.title !== "string" || typeof values.body !== "string") usage();
			output(await createNote(paths, {
				title: values.title, body: values.body,
				id: typeof values.id === "string" ? values.id : undefined,
				source: typeof values.source === "string" ? values.source : undefined,
				tags: splitList(values.tag ?? values.tags),
				status: typeof values.status === "string" ? values.status : undefined,
				type: typeof values.type === "string" ? values.type : undefined,
				tier: typeof values.tier === "string" ? values.tier : undefined,
				contentType: typeof values["content-type"] === "string" ? values["content-type"] : undefined,
				summary: typeof values.summary === "string" ? values.summary : undefined,
				doi: typeof values.doi === "string" ? values.doi : undefined,
				venue: typeof values.venue === "string" ? values.venue : undefined,
				citationCount: numberOption(values["citation-count"]),
				utilityScore: numberOption(values["utility-score"]),
				authorityScore: numberOption(values["authority-score"]),
				sourceDomain: typeof values["source-domain"] === "string" ? values["source-domain"] : undefined,
				fetchedAt: typeof values["fetched-at"] === "string" ? values["fetched-at"] : undefined,
				fetchProvider: typeof values["fetch-provider"] === "string" ? values["fetch-provider"] : undefined,
				oaUrl: typeof values["oa-url"] === "string" ? values["oa-url"] : undefined,
				oaSource: typeof values["oa-source"] === "string" ? values["oa-source"] : undefined,
				oaVersion: typeof values["oa-version"] === "string" ? values["oa-version"] : undefined,
				oaLicense: typeof values["oa-license"] === "string" ? values["oa-license"] : undefined,
				oaRecoveryKind: typeof values["oa-recovery-kind"] === "string" ? values["oa-recovery-kind"] as "substituted" | "rescued" : undefined,
				isRetracted: values.retracted === true,
			}), json);
			return;
		}
		if (operation === "update") {
			if (!noteArgs[0]) usage();
			output(await updateNote(paths, noteArgs[0]!, {
				title: typeof values.title === "string" ? values.title : undefined,
				body: typeof values.body === "string" ? values.body : undefined,
				status: typeof values.status === "string" ? values.status : undefined,
				tags: splitList(values.tag ?? values.tags),
				summary: typeof values.summary === "string" ? values.summary : undefined,
			}), json);
			return;
		}
		usage();
	}
	if (action === "claim") {
		const [operation, noteId, ...claimWords] = rest;
		if (operation === "add") {
			if (!noteId || !claimWords.length) usage();
			output(await addClaim(paths, noteId, {
				claim: claimWords.join(" "),
				quotedSupport: typeof values["quoted-support"] === "string" ? values["quoted-support"] : undefined,
				confidence: typeof values.confidence === "string" ? values.confidence : undefined,
				evidenceType: typeof values["evidence-type"] === "string" ? values["evidence-type"] : undefined,
				stanceTarget: typeof values["stance-target"] === "string" ? values["stance-target"] : undefined,
				stance: typeof values.stance === "string" ? values.stance : undefined,
				runId: typeof values["run-id"] === "string" ? values["run-id"] : undefined,
			}), json);
			return;
		}
		if (operation === "search") {
			const query = [noteId, ...claimWords].filter(Boolean).join(" ");
			if (!query) usage();
			output(await searchClaims(paths, { query, limit: numberOption(values.limit), runId: typeof values["run-id"] === "string" ? values["run-id"] : undefined }), json);
			return;
		}
		usage();
	}
	if (action === "quality") {
		const [operation] = rest;
		if (operation === "rank") output({ updated: await recomputeQualityScores(paths) }, json);
		else if (operation === "independence") output(await recomputeSourceIndependence(paths), json);
		else if (operation === "graph") output({ updated: await recomputeVaultCentrality(paths) }, json);
		else usage();
		return;
	}
	if (action === "cite-check") {
		if (typeof values.report !== "string") usage();
		output(await checkReportCitations(paths, await readFile(resolve(paths.root, values.report), "utf8")), json);
		return;
	}
	usage();
}
