import { randomBytes } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";

import type { VaultPaths } from "./types.js";
import { withVaultDatabase } from "./database.js";
import { slugifyNoteTitle } from "./frontmatter.js";
import { resolveScaleProfile, resolveResearchTier, type ResearchTier, type ScaleProfileName, type ScaleProfile } from "./profiles.js";

export const RUN_STATUSES = ["queued", "running", "paused", "blocked", "done", "failed", "aborted"] as const;
export const STEP_STATUSES = ["pending", "running", "done", "skipped", "failed"] as const;
export type ResearchRunStatus = (typeof RUN_STATUSES)[number];
export type ResearchStepStatus = (typeof STEP_STATUSES)[number];

export interface RunStep {
	status: ResearchStepStatus;
	startedAt?: string;
	finishedAt?: string;
	checkpoint?: string;
	message?: string;
}

export interface RunEvent {
	at: string;
	type: string;
	step?: string;
	status?: string;
	message?: string;
	data?: Record<string, unknown>;
}

export interface ResearchRunManifest {
	manifestVersion: number;
	id: string;
	query: string;
	profile: ScaleProfileName;
	tier: ResearchTier;
	status: ResearchRunStatus;
	steps: Record<string, RunStep>;
	stepOrder: string[];
	currentStep?: string;
	blockedOn?: string;
	budgetUsd?: number;
	spend: { estimatedUsd: number; sourcesFetched: number; notesWritten: number; agentsSpawned: number };
	startedAt: string;
	updatedAt: string;
	finishedAt?: string;
	artifacts: { report?: string; provenance?: string };
	profileSnapshot: ScaleProfile;
	register?: string;
	inferenceDepth?: string;
	domainNotes?: string;
	error?: string;
}

export interface CreateRunInput {
	query: string;
	profile?: string;
	tier?: ResearchTier;
	budgetUsd?: number;
	register?: string;
	inferenceDepth?: string;
	domainNotes?: string;
}

const MANIFEST_NAME = "run.json";
const EVENTS_NAME = "events.jsonl";
const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{2,119}$/;

export function validateRunId(id: string): string {
	if (!RUN_ID_RE.test(id)) throw new Error(`Invalid research run id '${id}'.`);
	return id;
}

export function getRunDir(paths: VaultPaths, runId: string): string {
	const id = validateRunId(runId);
	const directory = resolve(paths.runsDir, id);
	const relativePath = relative(paths.runsDir, directory);
	if (relativePath.startsWith("..")) throw new Error("Research run id escapes the run directory.");
	return directory;
}

async function atomicWrite(path: string, value: string): Promise<void> {
	const temp = `${path}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
	await writeFile(temp, value, "utf8");
	await rename(temp, path);
}

async function runLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
	const lockPath = join(directory, ".run.lock");
	await mkdir(directory, { recursive: true });
	for (let attempt = 0; attempt < 80; attempt += 1) {
		let lock;
		try {
			lock = await open(lockPath, "wx");
			await lock.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
			return await operation();
		} catch (error) {
			if (!isExists(error)) throw error;
			try {
				const info = await stat(lockPath);
				if (Date.now() - info.mtimeMs > 30_000) { await rm(lockPath, { force: true }); continue; }
			} catch {}
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 125));
		} finally {
			if (lock) {
				await lock.close().catch(() => {});
				await rm(lockPath, { force: true }).catch(() => {});
			}
		}
	}
	throw new Error(`Timed out waiting for run lock in ${directory}.`);
}

function isExists(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function now(): string { return new Date().toISOString(); }

function manifestPath(paths: VaultPaths, runId: string): string {
	return join(getRunDir(paths, runId), MANIFEST_NAME);
}

async function loadManifest(paths: VaultPaths, runId: string): Promise<ResearchRunManifest> {
	try {
		return JSON.parse(await readFile(manifestPath(paths, runId), "utf8")) as ResearchRunManifest;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") throw new Error(`Research run '${runId}' was not found.`);
		throw error;
	}
}

function saveIndex(paths: VaultPaths, manifest: ResearchRunManifest): void {
	withVaultDatabase(paths, (db) => {
		db.prepare(`INSERT INTO research_runs(id,query,profile,tier,status,current_step,blocked_on,budget_usd,spend_usd,started_at,updated_at,finished_at,error,manifest_path)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET query=excluded.query,profile=excluded.profile,tier=excluded.tier,status=excluded.status,
			current_step=excluded.current_step,blocked_on=excluded.blocked_on,budget_usd=excluded.budget_usd,spend_usd=excluded.spend_usd,
			updated_at=excluded.updated_at,finished_at=excluded.finished_at,error=excluded.error,manifest_path=excluded.manifest_path`)
			.run(manifest.id, manifest.query, manifest.profile, manifest.tier, manifest.status, manifest.currentStep ?? null,
				manifest.blockedOn ?? null, manifest.budgetUsd ?? null, manifest.spend.estimatedUsd, manifest.startedAt,
				manifest.updatedAt, manifest.finishedAt ?? null, manifest.error ?? null, manifestPath(paths, manifest.id));
	});
}

async function appendEvent(paths: VaultPaths, manifest: ResearchRunManifest, event: Omit<RunEvent, "at">): Promise<RunEvent> {
	const fullEvent: RunEvent = { at: now(), ...event };
	await appendFile(join(getRunDir(paths, manifest.id), EVENTS_NAME), `${JSON.stringify(fullEvent)}\n`, "utf8");
	withVaultDatabase(paths, (db) => {
		db.prepare("INSERT INTO run_events(run_id,step,type,status,message,data_json,created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run(manifest.id, fullEvent.step ?? null, fullEvent.type, fullEvent.status ?? null, fullEvent.message ?? null,
				fullEvent.data ? JSON.stringify(fullEvent.data) : null, fullEvent.at);
	});
	return fullEvent;
}

export async function createResearchRun(paths: VaultPaths, input: CreateRunInput): Promise<ResearchRunManifest> {
	const query = input.query.trim();
	if (!query) throw new Error("Research run query cannot be empty.");
	const profile = resolveScaleProfile(input.profile);
	const tier = input.tier ?? "pending";
	if (!(["pending", "light", "full", "dissertation"] as const).includes(tier)) throw new Error(`Invalid research tier '${tier}'.`);
	if (input.budgetUsd !== undefined && (!Number.isFinite(input.budgetUsd) || input.budgetUsd <= 0)) throw new Error("Research run budget must be greater than zero.");
	await mkdir(paths.runsDir, { recursive: true });
	const slug = slugifyNoteTitle(query).toLowerCase().replace(/[^a-z0-9-]/g, "").split("-").filter(Boolean).slice(0, 5).join("-") || "research";
	let runId: string;
	let directory: string;
	do {
		runId = `${slug}-${randomBytes(3).toString("hex")}`;
		directory = getRunDir(paths, runId);
		try { await mkdir(directory); break; }
		catch (error) { if (!isExists(error)) throw error; }
	} while (true);
	await mkdir(join(directory, "temp"), { recursive: true });
	await atomicWrite(join(directory, "query.md"), query.endsWith("\n") ? query : `${query}\n`);
	const startedAt = now();
	const manifest: ResearchRunManifest = {
		manifestVersion: 1,
		id: runId,
		query,
		profile: profile.name,
		tier,
		status: "queued",
		steps: Object.fromEntries(profile.steps.map((step) => [step, { status: "pending" as const }])),
		stepOrder: [...profile.steps],
		budgetUsd: input.budgetUsd,
		spend: { estimatedUsd: 0, sourcesFetched: 0, notesWritten: 0, agentsSpawned: 0 },
		startedAt,
		updatedAt: startedAt,
		artifacts: {},
		profileSnapshot: profile,
		...(input.register ? { register: input.register } : {}),
		...(input.inferenceDepth ? { inferenceDepth: input.inferenceDepth } : {}),
		...(input.domainNotes ? { domainNotes: input.domainNotes } : {}),
	};
	await atomicWrite(join(directory, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
	saveIndex(paths, manifest);
	await appendEvent(paths, manifest, { type: "run-created", status: "queued", message: "Run manifest initialized." });
	return manifest;
}

export async function getResearchRun(paths: VaultPaths, runId: string): Promise<ResearchRunManifest> {
	return loadManifest(paths, validateRunId(runId));
}

export async function listResearchRuns(paths: VaultPaths, limit = 20): Promise<ResearchRunManifest[]> {
	const rows = withVaultDatabase(paths, (db) => {
		const rows = db.prepare("SELECT id FROM research_runs ORDER BY updated_at DESC LIMIT ?").all(Math.max(1, Math.min(100, Math.floor(limit)))) as { id: string }[];
		return rows;
	});
	return Promise.all(rows.map((row) => loadManifest(paths, row.id)));
}

export async function setResearchRunStatus(paths: VaultPaths, runId: string, status: ResearchRunStatus, blockedOn?: string, error?: string): Promise<ResearchRunManifest> {
	if (!RUN_STATUSES.includes(status)) throw new Error(`Invalid run status '${status}'.`);
	const directory = getRunDir(paths, runId);
	return runLock(directory, async () => {
		const manifest = await loadManifest(paths, runId);
		manifest.status = status;
		manifest.blockedOn = status === "blocked" ? blockedOn ?? "unspecified" : undefined;
		manifest.error = error;
		manifest.updatedAt = now();
		if (["done", "failed", "aborted"].includes(status)) manifest.finishedAt = manifest.updatedAt;
		else manifest.finishedAt = undefined;
		await atomicWrite(manifestPath(paths, runId), `${JSON.stringify(manifest, null, 2)}\n`);
		saveIndex(paths, manifest);
		await appendEvent(paths, manifest, { type: "run-status", status, message: blockedOn ?? error });
		return manifest;
	});
}

export async function setResearchStep(paths: VaultPaths, runId: string, step: string, status: ResearchStepStatus, details: { checkpoint?: string; message?: string } = {}): Promise<ResearchRunManifest> {
	if (!STEP_STATUSES.includes(status)) throw new Error(`Invalid research step status '${status}'.`);
	const directory = getRunDir(paths, runId);
	return runLock(directory, async () => {
		const manifest = await loadManifest(paths, runId);
		if (!manifest.stepOrder.includes(step)) throw new Error(`Step '${step}' is not part of run '${runId}'.`);
		const entry = manifest.steps[step] ?? { status: "pending" as const };
		entry.status = status;
		if (status === "running" && !entry.startedAt) entry.startedAt = now();
		if (["done", "skipped", "failed"].includes(status)) entry.finishedAt = now();
		if (details.checkpoint) entry.checkpoint = details.checkpoint;
		if (details.message) entry.message = details.message;
		manifest.steps[step] = entry;
		manifest.currentStep = status === "done" || status === "skipped" ? nextPendingStep(manifest, step) : step;
		manifest.status = status === "failed" ? "failed" : status === "running" ? "running" : manifest.status;
		manifest.updatedAt = now();
		await atomicWrite(manifestPath(paths, runId), `${JSON.stringify(manifest, null, 2)}\n`);
		saveIndex(paths, manifest);
		await appendEvent(paths, manifest, { type: "step", step, status, message: details.message, data: details.checkpoint ? { checkpoint: details.checkpoint } : undefined });
		return manifest;
	});
}

function nextPendingStep(manifest: ResearchRunManifest, after: string): string | undefined {
	const index = manifest.stepOrder.indexOf(after);
	for (const step of manifest.stepOrder.slice(index + 1)) {
		if (!["done", "skipped"].includes(manifest.steps[step]?.status ?? "pending")) return step;
	}
	return undefined;
}

export function getResumeStep(manifest: ResearchRunManifest): string | undefined {
	return manifest.stepOrder.find((step) => !["done", "skipped"].includes(manifest.steps[step]?.status ?? "pending"));
}

export async function addResearchSpend(paths: VaultPaths, runId: string, delta: { estimatedUsd?: number; sourcesFetched?: number; notesWritten?: number; agentsSpawned?: number }): Promise<ResearchRunManifest> {
	const directory = getRunDir(paths, runId);
	return runLock(directory, async () => {
		const manifest = await loadManifest(paths, runId);
		manifest.spend.estimatedUsd = Math.round((manifest.spend.estimatedUsd + (delta.estimatedUsd ?? 0)) * 10_000) / 10_000;
		manifest.spend.sourcesFetched += delta.sourcesFetched ?? 0;
		manifest.spend.notesWritten += delta.notesWritten ?? 0;
		manifest.spend.agentsSpawned += delta.agentsSpawned ?? 0;
		if (manifest.budgetUsd !== undefined && manifest.spend.estimatedUsd >= manifest.budgetUsd && manifest.status === "running") {
			manifest.status = "blocked";
			manifest.blockedOn = "budget";
		}
		manifest.updatedAt = now();
		await atomicWrite(manifestPath(paths, runId), `${JSON.stringify(manifest, null, 2)}\n`);
		saveIndex(paths, manifest);
		await appendEvent(paths, manifest, { type: "spend", status: manifest.status, data: { ...delta, total: manifest.spend } });
		return manifest;
	});
}

export async function recordResearchEvent(paths: VaultPaths, runId: string, event: Omit<RunEvent, "at">): Promise<RunEvent> {
	const directory = getRunDir(paths, runId);
	return runLock(directory, async () => {
		const manifest = await loadManifest(paths, runId);
		manifest.updatedAt = now();
		await atomicWrite(manifestPath(paths, runId), `${JSON.stringify(manifest, null, 2)}\n`);
		saveIndex(paths, manifest);
		return appendEvent(paths, manifest, event);
	});
}

export async function selectRunTier(paths: VaultPaths, runId: string, tier: Exclude<ResearchTier, "pending">): Promise<ResearchRunManifest> {
	if (!(["light", "full", "dissertation"] as const).includes(tier)) throw new Error(`Invalid research tier '${tier}'.`);
	const directory = getRunDir(paths, runId);
	return runLock(directory, async () => {
		const manifest = await loadManifest(paths, runId);
		const profile = resolveResearchTier(tier, resolveScaleProfile(manifest.profile));
		manifest.tier = tier;
		manifest.profileSnapshot = profile;
		manifest.stepOrder = [...profile.steps];
		manifest.steps = Object.fromEntries(profile.steps.map((step) => [step, manifest.steps[step] ?? { status: "pending" as const }]));
		manifest.currentStep = getResumeStep(manifest);
		manifest.updatedAt = now();
		await atomicWrite(manifestPath(paths, runId), `${JSON.stringify(manifest, null, 2)}\n`);
		saveIndex(paths, manifest);
		await appendEvent(paths, manifest, { type: "tier-selected", status: tier, data: { profile: manifest.profile } });
		return manifest;
	});
}

export async function setRunArtifacts(paths: VaultPaths, runId: string, artifacts: { report?: string; provenance?: string }): Promise<ResearchRunManifest> {
	const directory = getRunDir(paths, runId);
	return runLock(directory, async () => {
		const manifest = await loadManifest(paths, runId);
		manifest.artifacts = { ...manifest.artifacts, ...artifacts };
		manifest.updatedAt = now();
		await atomicWrite(manifestPath(paths, runId), `${JSON.stringify(manifest, null, 2)}\n`);
		saveIndex(paths, manifest);
		await appendEvent(paths, manifest, { type: "artifacts-updated", data: artifacts });
		return manifest;
	});
}

export async function readRunEvents(paths: VaultPaths, runId: string, limit = 100): Promise<RunEvent[]> {
	const path = join(getRunDir(paths, runId), EVENTS_NAME);
	const contents = await readFile(path, "utf8").catch((error) => {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
		throw error;
	});
	return contents.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Math.min(1000, limit))).flatMap((line) => {
		try { return [JSON.parse(line) as RunEvent]; } catch { return []; }
	});
}
