import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { parseMarkdownNote } from "./frontmatter.js";
import { ensureVaultDirectories, resolveVaultNotePath } from "./paths.js";
import { listNotes } from "./notes.js";
import { syncVault } from "./sync.js";
import type { VaultPaths } from "./types.js";

async function markdownFiles(directory: string): Promise<string[]> {
	const found: string[] = [];
	const visit = async (current: string): Promise<void> => {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			const path = resolve(current, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) found.push(path);
		}
	};
	await visit(directory);
	return found.sort((a, b) => a.localeCompare(b));
}

function inside(parent: string, candidate: string): boolean {
	const rel = relative(parent, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

export async function importVaultMarkdown(paths: VaultPaths, sourceDirectory: string): Promise<{ imported: number; paths: string[] }> {
	const sourceRoot = resolve(sourceDirectory);
	const sourceInfo = await stat(sourceRoot).catch(() => undefined);
	if (!sourceInfo?.isDirectory()) throw new Error(`Vault import source '${sourceDirectory}' is not a directory.`);
	if (inside(paths.notesDir, sourceRoot) || inside(sourceRoot, paths.notesDir)) {
		throw new Error("Vault import source and destination must be separate directories.");
	}
	await ensureVaultDirectories(paths);
	const incoming = await markdownFiles(sourceRoot);
	if (!incoming.length) return { imported: 0, paths: [] };
	const existing = await listNotes(paths);
	const ids = new Set(existing.map((note) => note.id));
	const targets = new Set<string>();
	const planned: Array<{ source: string; target: string }> = [];
	for (const source of incoming) {
		const relativePath = relative(sourceRoot, source).replace(/\\/g, "/");
		const parsed = parseMarkdownNote(await readFile(source, "utf8"), relativePath);
		if (ids.has(parsed.frontmatter.id)) throw new Error(`Vault import would duplicate note id '${parsed.frontmatter.id}'.`);
		ids.add(parsed.frontmatter.id);
		const target = resolveVaultNotePath(paths, relativePath);
		if (targets.has(target)) throw new Error(`Vault import contains duplicate path '${relativePath}'.`);
		targets.add(target);
		planned.push({ source, target });
	}
	for (const item of planned) {
		try { await stat(item.target); throw new Error(`Vault import would overwrite '${relative(paths.notesDir, item.target)}'.`); }
		catch (error) { if (error instanceof Error && !("code" in error)) throw error; if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
	}
	const copied: string[] = [];
	try {
		for (const item of planned) {
			await mkdir(dirname(item.target), { recursive: true });
			await copyFile(item.source, item.target, 1);
			copied.push(item.target);
		}
		await syncVault(paths);
	} catch (error) {
		await Promise.all(copied.map((path) => rm(path, { force: true })));
		throw error;
	}
	return { imported: copied.length, paths: copied.map((path) => relative(paths.notesDir, path).replace(/\\/g, "/")) };
}

export async function exportVaultMarkdown(paths: VaultPaths, destinationDirectory: string): Promise<{ exported: number; directory: string }> {
	const destination = resolve(destinationDirectory);
	if (inside(paths.notesDir, destination) || inside(destination, paths.notesDir)) {
		throw new Error("Vault export destination and source must be separate directories.");
	}
	const files = await markdownFiles(paths.notesDir).catch((error) => {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	});
	await mkdir(dirname(destination), { recursive: true });
	await mkdir(destination);
	try {
		for (const source of files) {
			const target = resolve(destination, relative(paths.notesDir, source));
			await mkdir(dirname(target), { recursive: true });
			await copyFile(source, target, 1);
		}
	} catch (error) {
		await rm(destination, { recursive: true, force: true });
		throw error;
	}
	return { exported: files.length, directory: destination };
}
