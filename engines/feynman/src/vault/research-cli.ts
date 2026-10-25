import { spawn } from "node:child_process";
import {
	addResearchSpend,
	createResearchRun,
	getResearchRun,
	getResumeStep,
	listResearchRuns,
	recordResearchEvent,
	readRunEvents,
	selectRunTier,
	setResearchRunStatus,
	setResearchStep,
	setRunArtifacts,
	type ResearchRunStatus,
	type ResearchStepStatus,
} from "./runs.js";
import type { VaultPaths } from "./types.js";

export type ResearchCliValues = Record<string, string | boolean | undefined>;

function jsonOutput(value: unknown, json: boolean): void {
	if (json) console.log(JSON.stringify(value, null, 2));
	else console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function number(value: string | boolean | undefined): number | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`Expected a number, got '${value}'.`);
	return parsed;
}

function usage(): never {
	throw new Error([
		"Usage: feynman research run <init|list|status|resume|step|set-status|spend|event|events|tier|artifacts>",
		"Examples:",
		"  feynman research run init \"How does method X compare with method Y?\" --profile full --json",
		"  feynman research run step <run-id> 1 --status running",
		"  feynman research run resume <run-id> --json",
	].join("\n"));
}

export async function runResearchCli(args: string[], paths: VaultPaths, values: ResearchCliValues = {}): Promise<void> {
	const json = values.json === true;
	if (args[0] !== "run") usage();
	const [operation, ...rest] = args.slice(1);
	if (!operation || operation === "help") usage();
	if (operation === "init") {
		const query = rest.join(" ").trim();
		if (!query) usage();
		const tierValue = typeof values.tier === "string" ? values.tier : "pending";
		if (!(["pending", "light", "full", "dissertation"] as string[]).includes(tierValue)) throw new Error(`Invalid tier '${tierValue}'.`);
		const result = await createResearchRun(paths, {
			query,
			profile: typeof values.profile === "string" ? values.profile : "full",
			tier: tierValue as "pending" | "light" | "full" | "dissertation",
			budgetUsd: number(values.budget),
			register: typeof values.register === "string" ? values.register : undefined,
			inferenceDepth: typeof values["inference-depth"] === "string" ? values["inference-depth"] : undefined,
			domainNotes: typeof values["domain-notes"] === "string" ? values["domain-notes"] : undefined,
		});
		jsonOutput(result, json);
		return;
	}
	if (operation === "list") { jsonOutput(await listResearchRuns(paths, number(values.limit) ?? 20), json); return; }
	if (operation === "status") { if (!rest[0]) usage(); jsonOutput(await getResearchRun(paths, rest[0]!), json); return; }
	if (operation === "resume") {
		if (!rest[0]) usage();
		const manifest = await getResearchRun(paths, rest[0]!);
		if (["done", "aborted"].includes(manifest.status)) throw new Error(`Run '${manifest.id}' is ${manifest.status} and cannot be resumed.`);
		const resumeStep = getResumeStep(manifest);
		await setResearchRunStatus(paths, manifest.id, "running");
		const prompt = [
			manifest.query,
			`\n\nThis request comes from another agent; the research plan is pre-approved. The plan for this existing run was already approved. Feynman durable research run id: ${manifest.id}. Scale profile: ${manifest.profile}. Requested tier: ${manifest.tier}. Register: ${manifest.register ?? "auto"}. Inference depth: ${manifest.inferenceDepth ?? "standard"}. Domain notes: ${manifest.domainNotes ?? "none"}. Resume from the first unfinished stage (${resumeStep ?? "finalize"}); read the manifest and existing artifacts first. Do not restart completed stages.`,
		].join("\n");
		const child = spawn(process.env.FEYNMAN_CLI ?? "feynman", ["deepresearch", prompt], { cwd: paths.root, stdio: "inherit", env: process.env });
		await new Promise<void>((resolvePromise, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) => {
				if (signal) { process.exitCode = 1; console.error(`Feynman resume ended with ${signal}.`); }
				else process.exitCode = code ?? 0;
				resolvePromise();
			});
		});
		return;
	}
	if (operation === "step") {
		const [runId, step] = rest;
		if (!runId || !step || typeof values.status !== "string") usage();
		const status = values.status as ResearchStepStatus;
		jsonOutput(await setResearchStep(paths, runId, step, status, {
			checkpoint: typeof values.checkpoint === "string" ? values.checkpoint : undefined,
			message: typeof values.message === "string" ? values.message : undefined,
		}), json);
		return;
	}
	if (operation === "set-status") {
		const runId = rest[0];
		if (!runId || typeof values.status !== "string") usage();
		jsonOutput(await setResearchRunStatus(paths, runId, values.status as ResearchRunStatus,
			typeof values.blocked === "string" ? values.blocked : undefined,
			typeof values.error === "string" ? values.error : undefined), json);
		return;
	}
	if (operation === "spend") {
		const runId = rest[0]; if (!runId) usage();
		jsonOutput(await addResearchSpend(paths, runId, {
			estimatedUsd: number(values["estimated-usd"]),
			sourcesFetched: number(values["sources-fetched"]),
			notesWritten: number(values["notes-written"]),
			agentsSpawned: number(values["agents-spawned"]),
		}), json);
		return;
	}
	if (operation === "event") {
		const [runId, type] = rest;
		if (!runId || !type) usage();
		jsonOutput(await recordResearchEvent(paths, runId, {
			type,
			step: typeof values.step === "string" ? values.step : undefined,
			status: typeof values.status === "string" ? values.status : undefined,
			message: typeof values.message === "string" ? values.message : undefined,
		}), json);
		return;
	}
	if (operation === "events") {
		const runId = rest[0]; if (!runId) usage();
		jsonOutput(await readRunEvents(paths, runId, number(values.limit) ?? 100), json);
		return;
	}
	if (operation === "tier") {
		const [runId, tier] = rest;
		if (!runId || !tier) usage();
		jsonOutput(await selectRunTier(paths, runId, tier as "light" | "full" | "dissertation"), json);
		return;
	}
	if (operation === "artifacts") {
		const runId = rest[0]; if (!runId) usage();
		jsonOutput(await setRunArtifacts(paths, runId, {
			report: typeof values.report === "string" ? values.report : undefined,
			provenance: typeof values.provenance === "string" ? values.provenance : undefined,
		}), json);
		return;
	}
	usage();
}
