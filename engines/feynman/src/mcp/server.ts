import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { access, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import * as z from "zod/v4";

import { addClaim, createNote, getNote, getVaultStatus, searchClaims, searchVault } from "../vault/index.js";
import {
	createResearchRun,
	getResearchRun,
	getResumeStep,
	listResearchRuns,
	setResearchRunStatus,
	setResearchStep,
	setRunArtifacts,
} from "../vault/runs.js";
import { getRunDir } from "../vault/runs.js";
import type { ResearchTier } from "../vault/profiles.js";
import { getVaultPaths, ensureVaultDirectories } from "../vault/paths.js";
import type { VaultPaths } from "../vault/types.js";

const WORKFLOWS = ["deepresearch", "lit", "compare", "review", "audit", "summarize", "recipe", "draft"] as const;
const PROFILES = ["full", "premier"] as const;
const TIERS = ["pending", "light", "full", "dissertation"] as const;
const MAX_WAIT_MS = 240_000;
const MAX_DELIVERABLE_CHARS = 60_000;
const MAX_PROVENANCE_CHARS = 8_000;

interface JobRecord {
	id: string;
	runId: string;
	workflow: (typeof WORKFLOWS)[number];
	pid: number;
	startedAt: string;
	startedAtMs: number;
	logPath: string;
	exitCode?: number | null;
	finishedAt?: string;
	error?: string;
}

function textResult(value: string): { content: [{ type: "text"; text: string }] } {
	return { content: [{ type: "text", text: value }] };
}

function runFile(paths: VaultPaths, jobId: string): string {
	return join(getRunDir(paths, jobId), "mcp-job.json");
}

async function saveJob(paths: VaultPaths, job: JobRecord): Promise<void> {
	const destination = runFile(paths, job.id);
	const temporary = `${destination}.tmp-${process.pid}`;
	await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, destination);
}

async function readJob(paths: VaultPaths, jobId: string): Promise<JobRecord> {
	try {
		return JSON.parse(await readFile(runFile(paths, jobId), "utf8")) as JobRecord;
	} catch (error) {
		if (isCode(error, "ENOENT")) throw new Error(`Feynman research job '${jobId}' was not found.`);
		throw error;
	}
}

function isCode(error: unknown, code: string): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isCode(error, "EPERM");
	}
}

function resultText(fields: Record<string, string | number | boolean | undefined>, body?: string, provenance?: string, outputTail?: string): string {
	const header = Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => `${key.toUpperCase()}: ${value}`).join("\n");
	return [
		header,
		body ? `\n===== DELIVERABLE (complete markdown, return it as-is) =====\n${body}` : "",
		provenance ? `\n===== PROVENANCE =====\n${provenance}` : "",
		outputTail ? `\n===== FEYNMAN OUTPUT (no deliverable file found) =====\n${outputTail}` : "",
	].filter(Boolean).join("\n");
}

async function latestDeliverable(paths: VaultPaths, sinceMs: number): Promise<string | undefined> {
	const candidates: string[] = [];
	for (const directory of [join(paths.root, "outputs"), join(paths.root, "papers")]) {
		for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
			if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.endsWith(".provenance.md")) continue;
			const path = join(directory, entry.name);
			const info = await stat(path).catch(() => undefined);
			if (info && info.mtimeMs >= sinceMs) candidates.push(path);
		}
	}
	return candidates.sort((a, b) => b.localeCompare(a))[0];
}

async function finishJob(paths: VaultPaths, job: JobRecord, exitCode: number | null, error?: string): Promise<JobRecord> {
	job.exitCode = exitCode;
	job.finishedAt = new Date().toISOString();
	if (error) job.error = error;
	await saveJob(paths, job);
	const report = await latestDeliverable(paths, job.startedAtMs);
	let manifest = await getResearchRun(paths, job.runId);
	if (job.workflow !== "deepresearch") {
		for (const step of manifest.stepOrder) {
			if (!["done", "skipped"].includes(manifest.steps[step]?.status ?? "pending")) {
				manifest = await setResearchStep(paths, job.runId, step, "skipped", { message: `Not used by the ${job.workflow} workflow.` });
			}
		}
	}
	const provenanceExists = report ? await access(report.replace(/\.md$/i, ".provenance.md")).then(() => true).catch(() => false) : false;
	const stagesComplete = manifest.stepOrder.every((step) => ["done", "skipped"].includes(manifest.steps[step]?.status ?? "pending"));
	const hasRequiredArtifacts = report && (job.workflow !== "deepresearch" || provenanceExists && (stagesComplete || manifest.status === "blocked"));
	const status = hasRequiredArtifacts && exitCode === 0
		? manifest.status === "blocked" ? "blocked" : "done"
		: "failed";
	await setResearchRunStatus(paths, job.runId, status, status === "blocked" ? manifest.blockedOn : undefined,
		status === "failed" ? error ?? `Feynman exited without a complete staged report and provenance (exit status ${exitCode ?? "unknown"}).` : undefined);
	if (report && (status === "done" || status === "blocked")) {
		const provenance = report.replace(/\.md$/i, ".provenance.md");
		await setRunArtifacts(paths, job.runId, {
			report: report.slice(paths.root.length + 1),
			...(provenanceExists ? { provenance: provenance.slice(paths.root.length + 1) } : {}),
		});
	}
	await releaseLock(paths, job.id);
	return job;
}

const LOCK_FILE = ".mcp-research.lock";

async function acquireLock(paths: VaultPaths, jobId: string): Promise<void> {
	await mkdir(paths.runsDir, { recursive: true });
	const lockPath = join(paths.runsDir, LOCK_FILE);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const lock = await open(lockPath, "wx", 0o600);
			await lock.writeFile(`${JSON.stringify({ pid: process.pid, jobId })}\n`);
			await lock.close();
			return;
		} catch (error) {
			if (!isCode(error, "EEXIST")) throw error;
			const prior = await readFile(lockPath, "utf8").then((value) => JSON.parse(value) as { pid?: number; jobId?: string }).catch(() => undefined);
			if (prior?.pid && processAlive(prior.pid)) throw new Error(`Feynman is busy with research job '${prior.jobId ?? "unknown"}'.`);
			await rm(lockPath, { force: true });
		}
	}
	throw new Error("Could not acquire the Feynman research lock.");
}

async function releaseLock(paths: VaultPaths, jobId: string): Promise<void> {
	const lockPath = join(paths.runsDir, LOCK_FILE);
	const current = await readFile(lockPath, "utf8").then((value) => JSON.parse(value) as { jobId?: string }).catch(() => undefined);
	if (current?.jobId === jobId) await rm(lockPath, { force: true });
}

async function persistChildLock(paths: VaultPaths, jobId: string, pid: number): Promise<void> {
	await writeFile(join(paths.runsDir, LOCK_FILE), `${JSON.stringify({ pid, jobId })}\n`, { mode: 0o600 });
}

async function launchJob(paths: VaultPaths, input: {
	workflow: (typeof WORKFLOWS)[number];
	topic: string;
	profile?: (typeof PROFILES)[number];
	tier?: ResearchTier;
	budgetUsd?: number;
	register?: string;
	inferenceDepth?: string;
	domainNotes?: string;
	resumeRunId?: string;
}): Promise<JobRecord> {
	const manifest = input.resumeRunId
		? await getResearchRun(paths, input.resumeRunId)
		: await createResearchRun(paths, {
			query: input.topic, profile: input.profile ?? "full", tier: input.tier ?? "pending", budgetUsd: input.budgetUsd,
			register: input.register, inferenceDepth: input.inferenceDepth, domainNotes: input.domainNotes,
		});
	await acquireLock(paths, manifest.id);
	const startedAt = new Date().toISOString();
	const startedAtMs = Date.now();
	const logPath = join(getRunDir(paths, manifest.id), "feynman-cli.log");
	const log = await open(logPath, "a", 0o600);
	const resumeStep = input.resumeRunId ? getResumeStep(manifest) : undefined;
	const launchTopic = [
		input.topic,
		"\n\nThis request comes from another agent; the research plan is pre-approved. Continue through the final report without asking a person to approve the plan. Record degraded or blocked checks in the report and provenance.",
		`Feynman durable research run id: ${manifest.id}. Scale profile: ${manifest.profile}. Requested tier: ${manifest.tier}. Register: ${manifest.register ?? "auto"}. Inference depth: ${manifest.inferenceDepth ?? "standard"}. Domain notes: ${manifest.domainNotes ?? "none"}. Save staged artifacts under outputs/.runs/${manifest.id}/ and use the feynman_research_run_* tools to record checkpoints.`,
		...(input.resumeRunId ? [`Resume the existing run from its first unfinished stage (${resumeStep ?? "finalize"}). Read its existing plan, manifest, and stage artifacts first. Do not restart completed stages.`] : []),
	].join("\n");
	const cli = process.env.FEYNMAN_CLI ?? "feynman";
	const child = spawn(cli, [input.workflow, launchTopic], {
		cwd: paths.root,
		env: process.env,
		stdio: ["ignore", log.fd, log.fd],
		detached: true,
	});
	await log.close();
	const job: JobRecord = { id: manifest.id, runId: manifest.id, workflow: input.workflow, pid: child.pid ?? -1, startedAt, startedAtMs, logPath };
	if (child.pid === undefined) {
		await releaseLock(paths, manifest.id);
		throw new Error("Could not start the Feynman CLI process.");
	}
	await persistChildLock(paths, manifest.id, child.pid);
	await saveJob(paths, job);
	await setResearchRunStatus(paths, manifest.id, "running");
	child.once("error", (error) => { void finishJob(paths, job, null, error.message); });
	child.once("exit", (code, signal) => { void finishJob(paths, job, code, signal ? `Feynman CLI exited after ${signal}.` : undefined); });
	child.unref();
	return job;
}

async function jobStatus(paths: VaultPaths, jobId: string, waitMs = 0): Promise<string> {
	const job = await readJob(paths, jobId);
	const deadline = Date.now() + Math.min(MAX_WAIT_MS, Math.max(0, waitMs));
	while (processAlive(job.pid) && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
	if (processAlive(job.pid)) {
		const manifest = await getResearchRun(paths, job.runId);
		return resultText({ status: "running", job_id: job.id, run_id: job.runId, workflow: job.workflow,
			elapsed_s: Math.round((Date.now() - job.startedAtMs) / 1000), latest_file: manifest.artifacts.report ?? getResumeStep(manifest) });
	}
	const priorManifest = await getResearchRun(paths, job.runId);
	const updated = job.exitCode === undefined && ["done", "blocked"].includes(priorManifest.status)
		? job
		: job.exitCode === undefined
			? await finishJob(paths, job, null, "Feynman process ended before the server recorded its exit.")
			: job;
	const manifest = await getResearchRun(paths, updated.runId);
	if (["done", "blocked"].includes(manifest.status) && manifest.artifacts.report) {
		const reportPath = resolve(paths.root, manifest.artifacts.report);
		const content = await readFile(reportPath, "utf8").catch(() => "");
		const provenancePath = manifest.artifacts.provenance ? resolve(paths.root, manifest.artifacts.provenance) : reportPath.replace(/\.md$/i, ".provenance.md");
		const provenance = await readFile(provenancePath, "utf8").catch(() => "");
		return resultText({ status: manifest.status, job_id: updated.id, run_id: updated.runId, workflow: updated.workflow,
			path: reportPath, seconds: Math.round((Date.now() - updated.startedAtMs) / 1000),
			truncated: content.length > MAX_DELIVERABLE_CHARS }, content.slice(0, MAX_DELIVERABLE_CHARS), provenance.slice(0, MAX_PROVENANCE_CHARS));
	}
	const outputTail = await readFile(updated.logPath, "utf8").catch(() => "");
	return resultText({ status: manifest.status === "failed" ? "failed" : manifest.status, job_id: updated.id, run_id: updated.runId,
		workflow: updated.workflow, error: manifest.error }, undefined, undefined, outputTail.slice(-8_000));
}

function createFeynmanMcp(paths: VaultPaths): McpServer {
	const server = new McpServer({ name: "feynman", version: "1.0.0" });
	server.registerTool("feynman_research", {
		description: "Start a long Feynman research workflow. Returns or waits up to four minutes for a job id and cited report. Use feynman_result with the returned job id to continue polling.",
		inputSchema: {
			workflow: z.enum(WORKFLOWS),
			topic: z.string().trim().min(1).max(4_000),
			profile: z.enum(PROFILES).optional(),
			tier: z.enum(TIERS).optional(),
			budgetUsd: z.number().positive().optional(),
			register: z.enum(["teach", "survey", "analyze", "advocate"]).optional(),
			inferenceDepth: z.enum(["surface", "standard", "deep"]).optional(),
			domainNotes: z.string().max(2_000).optional(),
		},
	}, async ({ workflow, topic, profile, tier, budgetUsd, register, inferenceDepth, domainNotes }) => {
		try {
			const job = await launchJob(paths, { workflow, topic, profile, tier, budgetUsd, register, inferenceDepth, domainNotes });
			return textResult(await jobStatus(paths, job.id, MAX_WAIT_MS));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.startsWith("Feynman is busy with research job")) return textResult(resultText({ status: "busy", error: message, next: "retry feynman_research after the active run finishes" }));
			throw error;
		}
	});
	server.registerTool("feynman_resume", {
		description: "Resume an interrupted Feynman research run from its first unfinished recorded stage.",
		inputSchema: { runId: z.string().min(3).max(120) },
	}, async ({ runId }) => {
		const manifest = await getResearchRun(paths, runId);
		if (["done", "aborted"].includes(manifest.status)) throw new Error(`Run '${runId}' is ${manifest.status} and cannot be resumed.`);
		const job = await launchJob(paths, { workflow: "deepresearch", topic: manifest.query, resumeRunId: runId });
		return textResult(await jobStatus(paths, job.id, MAX_WAIT_MS));
	});
	server.registerTool("feynman_result", {
		description: "Check or continue waiting for a Feynman research job; completed results include the cited report and provenance.",
		inputSchema: { job_id: z.string().min(3).max(120) },
	}, async ({ job_id }) => textResult(await jobStatus(paths, job_id, MAX_WAIT_MS)));
	server.registerTool("feynman_research_status", {
		description: "Get durable status for a research run, including completed stages and its first resumable stage.",
		inputSchema: { runId: z.string().min(3).max(120) },
	}, async ({ runId }) => {
		const manifest = await getResearchRun(paths, runId);
		return textResult(JSON.stringify({ ...manifest, resumeStep: getResumeStep(manifest) }, null, 2));
	});
	server.registerTool("feynman_vault_status", {
		description: "Show counts and status for the Feynman Markdown research vault and its SQLite index.",
		inputSchema: {},
	}, async () => textResult(JSON.stringify(await getVaultStatus(paths), null, 2)));
	server.registerTool("feynman_vault_search", {
		description: "Search indexed research notes, source provenance, and claims in Feynman's local vault.",
		inputSchema: { query: z.string().trim().min(1).max(1_000), limit: z.number().int().min(1).max(100).optional(), tags: z.array(z.string()).optional(), ranked: z.boolean().optional() },
	}, async ({ query, limit, tags, ranked }) => textResult(JSON.stringify(await searchVault(paths, { query, limit, tags, ranked }), null, 2)));
	server.registerTool("feynman_vault_read", {
		description: "Read the complete Markdown source note and provenance metadata for a vault note id.",
		inputSchema: { id: z.string().min(1).max(200) },
	}, async ({ id }) => textResult(JSON.stringify(await getNote(paths, id), null, 2)));
	server.registerTool("feynman_vault_create_note", {
		description: "Store source-backed evidence as a canonical Markdown note in Feynman's reusable research vault.",
		inputSchema: {
			title: z.string().trim().min(1).max(500), body: z.string().min(1), source: z.string().url().optional(),
			tags: z.array(z.string()).optional(), tier: z.enum(["ground_truth", "institutional", "practitioner", "commentary", "unknown"]).optional(),
			contentType: z.enum(["paper", "docs", "article", "blog", "forum", "dataset", "policy", "code", "book", "transcript", "review", "unknown"]).optional(),
			summary: z.string().optional(), doi: z.string().optional(), venue: z.string().optional(),
			citationCount: z.number().int().nonnegative().optional(), utilityScore: z.number().min(0).max(18).optional(),
			authorityScore: z.number().min(0).max(1).optional(), isRetracted: z.boolean().optional(),
			sourceDomain: z.string().optional(), fetchedAt: z.string().optional(), fetchProvider: z.string().optional(),
			oaUrl: z.string().url().optional(), oaSource: z.string().optional(), oaVersion: z.string().optional(),
			oaLicense: z.string().optional(), oaRecoveryKind: z.enum(["substituted", "rescued"]).optional(),
		},
	}, async (input) => textResult(JSON.stringify(await withFileMutationQueue(paths.dir, () => createNote(paths, input)), null, 2)));
	server.registerTool("feynman_vault_add_claim", {
		description: "Attach a source-grounded claim and its quoted support to an existing vault note.",
		inputSchema: {
			noteId: z.string(), claim: z.string().trim().min(1), quotedSupport: z.string().optional(),
			confidence: z.string().optional(), evidenceType: z.string().optional(), stanceTarget: z.string().optional(),
			stance: z.string().optional(), runId: z.string().optional(),
		},
	}, async ({ noteId, ...claim }) => textResult(JSON.stringify(await withFileMutationQueue(paths.dir, () => addClaim(paths, noteId, claim)), null, 2)));
	server.registerTool("feynman_vault_claim_search", {
		description: "Search source-backed claims saved in the research vault, optionally limited to one run.",
		inputSchema: { query: z.string().trim().min(1).max(1_000), limit: z.number().int().min(1).max(100).optional(), runId: z.string().optional() },
	}, async ({ query, limit, runId }) => textResult(JSON.stringify(await searchClaims(paths, { query, limit, runId }), null, 2)));
	server.registerTool("feynman_research_runs", {
		description: "List recent durable Feynman research runs.",
		inputSchema: { limit: z.number().int().min(1).max(100).optional() },
	}, async ({ limit }) => textResult(JSON.stringify(await listResearchRuns(paths, limit), null, 2)));
	server.registerTool("feynman_research_run_step", {
		description: "Record a Hyperresearch pipeline stage transition and its durable checkpoint.",
		inputSchema: {
			runId: z.string().min(3).max(120), step: z.string().min(1).max(20),
			status: z.enum(["pending", "running", "done", "skipped", "failed"]),
			checkpoint: z.string().optional(), message: z.string().optional(),
		},
	}, async ({ runId, step, status, checkpoint, message }) => textResult(JSON.stringify(await setResearchStep(paths, runId, step, status, { checkpoint, message }), null, 2)));
	return server;
}

export async function runFeynmanMcpServer(options: { host?: string; port?: number; workspace?: string } = {}): Promise<void> {
	const host = options.host ?? process.env.FEYNMAN_MCP_HOST ?? "127.0.0.1";
	const port = options.port ?? Number(process.env.FEYNMAN_MCP_PORT ?? 8910);
	const workspace = resolve(options.workspace ?? process.env.FEYNMAN_MCP_WORKSPACE ?? process.cwd());
	const paths = getVaultPaths(workspace);
	await ensureVaultDirectories(paths);
	const activeServers = new Set<McpServer>();
	const httpServer = createServer(async (request: IncomingMessage, response: ServerResponse) => {
		const pathname = new URL(request.url ?? "/", `http://${host}`).pathname;
		if (pathname !== "/mcp") {
			response.writeHead(404).end("Not found");
			return;
		}
		const mcp = createFeynmanMcp(paths);
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		activeServers.add(mcp);
		try {
			await mcp.connect(transport);
			await transport.handleRequest(request, response);
		} finally {
			activeServers.delete(mcp);
			await mcp.close();
		}
	});
	await new Promise<void>((resolveListen, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(port, host, resolveListen);
	});
	process.stdout.write(`Feynman MCP listening at http://${host}:${port}/mcp for ${workspace}\n`);
	const close = (): void => {
		httpServer.close();
		for (const mcp of activeServers) void mcp.close();
	};
	process.once("SIGINT", close);
	process.once("SIGTERM", close);
}
