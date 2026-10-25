import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { access, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
	getResearchRun,
	getResumeStep,
	recordResearchEvent,
	selectRunTier,
	setResearchRunStatus,
	setResearchStep,
	setRunArtifacts,
	checkReportCitations,
	type ResearchRunStatus,
	type ResearchStepStatus,
	getVaultPaths,
} from "../../src/vault/index.js";

function result(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

export function registerResearchRunTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "feynman_research_run_status",
		label: "Research Run Status",
		description: "Read the durable Hyperresearch-style run manifest, completed stages, artifacts, and resume point.",
		parameters: Type.Object({ runId: Type.String() }),
		async execute(_id, { runId }, _signal, _onUpdate, ctx) {
			const manifest = await getResearchRun(getVaultPaths(ctx.cwd), runId);
			return result({ ...manifest, resumeStep: getResumeStep(manifest) });
		},
	});

	pi.registerTool({
		name: "feynman_research_run_step",
		label: "Record Research Stage",
		description: "Record a staged research transition and checkpoint so interrupted work can resume accurately.",
		parameters: Type.Object({
			runId: Type.String(), step: Type.String(), status: Type.Union([
				Type.Literal("pending"), Type.Literal("running"), Type.Literal("done"), Type.Literal("skipped"), Type.Literal("failed"),
			]), checkpoint: Type.Optional(Type.String()), message: Type.Optional(Type.String()),
		}),
		async execute(_id, { runId, step, status, checkpoint, message }, _signal, _onUpdate, ctx) {
			const paths = getVaultPaths(ctx.cwd);
			return withFileMutationQueue(paths.dir, async () => result(await setResearchStep(paths, runId, step, status as ResearchStepStatus, { checkpoint, message })));
		},
	});

	pi.registerTool({
		name: "feynman_research_run_tier",
		label: "Set Research Tier",
		description: "Select the run's light, full, or dissertation stage route and update its manifest snapshot.",
		parameters: Type.Object({ runId: Type.String(), tier: Type.Union([Type.Literal("light"), Type.Literal("full"), Type.Literal("dissertation")]) }),
		async execute(_id, { runId, tier }, _signal, _onUpdate, ctx) {
			const paths = getVaultPaths(ctx.cwd);
			return withFileMutationQueue(paths.dir, async () => result(await selectRunTier(paths, runId, tier)));
		},
	});

	pi.registerTool({
		name: "feynman_research_run_finish",
		label: "Finish Research Run",
		description: "Record the final run state, report and provenance paths, and an auditable finish event.",
		parameters: Type.Object({
			runId: Type.String(), status: Type.Union([Type.Literal("done"), Type.Literal("blocked"), Type.Literal("failed")]),
			report: Type.Optional(Type.String()), provenance: Type.Optional(Type.String()), message: Type.Optional(Type.String()),
		}),
		async execute(_id, { runId, status, report, provenance, message }, _signal, _onUpdate, ctx) {
			const paths = getVaultPaths(ctx.cwd);
			return withFileMutationQueue(paths.dir, async () => {
				const current = await getResearchRun(paths, runId);
				if (status === "done") {
					const unfinished = current.stepOrder.filter((step) => !["done", "skipped"].includes(current.steps[step]?.status ?? "pending"));
					if (unfinished.length) throw new Error(`Cannot finish run with unfinished stages: ${unfinished.join(", ")}.`);
					if (!report || !provenance) throw new Error("A completed run requires report and provenance paths.");
					const safePath = (value: string): string => {
						const full = resolve(paths.root, value);
						const rel = relative(paths.root, full);
						if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Run artifact path must stay inside the research workspace.");
						return full;
					};
					const reportPath = safePath(report);
					const provenancePath = safePath(provenance);
					await Promise.all([access(reportPath), access(provenancePath)]);
					const reportText = await readFile(reportPath, "utf8");
					const citations = await checkReportCitations(paths, reportText);
					if (citations.dangling > 0) throw new Error(`Cannot finish run: ${citations.dangling} citations do not resolve to saved evidence notes.`);
				}
				await setRunArtifacts(paths, runId, { report, provenance });
				await setResearchRunStatus(paths, runId, status as ResearchRunStatus, status === "blocked" ? message : undefined,
					status === "failed" ? message : undefined);
				await recordResearchEvent(paths, runId, { type: "run-finished", status, message });
				return result(await getResearchRun(paths, runId));
			});
		},
	});
}
