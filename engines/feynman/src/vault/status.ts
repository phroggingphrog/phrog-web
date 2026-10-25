import { stat } from "node:fs/promises";

import type { VaultPaths } from "./types.js";
import { withVaultDatabase } from "./database.js";

export interface VaultStatus {
	initialized: boolean;
	root: string;
	notes: number;
	sources: number;
	claims: number;
	links: number;
	byStatus: Record<string, number>;
	databaseBytes: number;
}

export async function getVaultStatus(paths: VaultPaths): Promise<VaultStatus> {
	try {
		const info = await stat(paths.database);
		const counts = withVaultDatabase(paths, (db) => {
			const noteCount = Number((db.prepare("SELECT COUNT(*) AS count FROM notes").get() as { count: number }).count);
			const sourceCount = Number((db.prepare("SELECT COUNT(*) AS count FROM sources WHERE note_id IS NOT NULL").get() as { count: number }).count);
			const claimCount = Number((db.prepare("SELECT COUNT(*) AS count FROM claims").get() as { count: number }).count);
			const linkCount = Number((db.prepare("SELECT COUNT(*) AS count FROM links WHERE target_id IS NOT NULL").get() as { count: number }).count);
			const statusRows = db.prepare("SELECT status, COUNT(*) AS count FROM notes GROUP BY status").all() as { status: string; count: number }[];
			return { noteCount, sourceCount, claimCount, linkCount, byStatus: Object.fromEntries(statusRows.map((row) => [row.status, Number(row.count)])) };
		}, true);
		return { initialized: true, root: paths.root, notes: counts.noteCount, sources: counts.sourceCount, claims: counts.claimCount, links: counts.linkCount, byStatus: counts.byStatus, databaseBytes: info.size };
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return { initialized: false, root: paths.root, notes: 0, sources: 0, claims: 0, links: 0, byStatus: {}, databaseBytes: 0 };
		}
		throw error;
	}
}
