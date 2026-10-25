import { resolve, relative, isAbsolute, sep, join } from "node:path";
import { mkdir } from "node:fs/promises";

import type { VaultPaths } from "./types.js";

export const VAULT_DIRECTORY = "research/vault";

export function getVaultPaths(projectRoot = process.cwd()): VaultPaths {
	const root = resolve(projectRoot);
	const dir = resolve(root, VAULT_DIRECTORY);
	return {
		root,
		dir,
		notesDir: join(dir, "notes"),
		indexDir: join(dir, ".index"),
		database: join(dir, ".index", "feynman-vault.sqlite3"),
		temporaryDir: join(dir, "temp"),
		archiveDir: join(dir, "archive"),
		runsDir: join(root, "outputs", ".runs"),
	};
}

export function resolveVaultNotePath(paths: VaultPaths, relativePath: string): string {
	const normalized = relativePath.replaceAll("\\", "/");
	if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === ".")) {
		throw new Error("Vault note path must be a relative path without dot segments.");
	}
	const absolute = resolve(paths.notesDir, normalized);
	const rel = relative(paths.notesDir, absolute);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error("Vault note path escapes the vault notes directory.");
	}
	return absolute;
}

export async function ensureVaultDirectories(paths: VaultPaths): Promise<void> {
	await Promise.all([
		mkdir(paths.notesDir, { recursive: true }),
		mkdir(paths.indexDir, { recursive: true }),
		mkdir(paths.temporaryDir, { recursive: true }),
		mkdir(paths.archiveDir, { recursive: true }),
	]);
}
