import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { VaultPaths } from "./types.js";

export const VAULT_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	path TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL DEFAULT 'draft',
	type TEXT NOT NULL DEFAULT 'note',
	tier TEXT,
	content_type TEXT,
	source TEXT,
	parent TEXT,
	deprecated INTEGER NOT NULL DEFAULT 0,
	reviewed TEXT,
	expires TEXT,
	word_count INTEGER NOT NULL DEFAULT 0,
	summary TEXT,
	created TEXT NOT NULL,
	updated TEXT,
	file_mtime REAL NOT NULL,
	content_hash TEXT NOT NULL,
	synced_at TEXT NOT NULL,
	doi TEXT,
	utility_score REAL,
	authority_score REAL,
	centrality_score REAL,
	independence REAL,
	citation_count INTEGER,
	venue TEXT,
	is_retracted INTEGER,
	quality_score REAL,
	oa_url TEXT,
	oa_source TEXT,
	oa_version TEXT,
	oa_license TEXT,
	oa_recovery_kind TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status);
CREATE INDEX IF NOT EXISTS idx_notes_type ON notes(type);
CREATE INDEX IF NOT EXISTS idx_notes_parent ON notes(parent);
CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created);
CREATE INDEX IF NOT EXISTS idx_notes_tier ON notes(tier);
CREATE INDEX IF NOT EXISTS idx_notes_doi ON notes(doi);
CREATE INDEX IF NOT EXISTS idx_notes_quality ON notes(quality_score);
CREATE TABLE IF NOT EXISTS note_content (
	note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
	body TEXT NOT NULL,
	body_plain TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tags (
	note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
	tag TEXT NOT NULL,
	PRIMARY KEY (note_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE TABLE IF NOT EXISTS aliases (
	note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
	alias TEXT NOT NULL,
	PRIMARY KEY (note_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_aliases_alias ON aliases(alias COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS links (
	source_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
	target_ref TEXT NOT NULL,
	target_id TEXT,
	line_number INTEGER NOT NULL DEFAULT 0,
	context TEXT,
	PRIMARY KEY (source_id, target_ref, line_number)
);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_id);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_id);
CREATE TABLE IF NOT EXISTS sources (
	url TEXT PRIMARY KEY,
	note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
	domain TEXT,
	fetched_at TEXT,
	provider TEXT,
	content_hash TEXT,
	status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_sources_domain ON sources(domain);
CREATE INDEX IF NOT EXISTS idx_sources_note ON sources(note_id);
CREATE TABLE IF NOT EXISTS claims (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
	claim TEXT NOT NULL,
	claim_hash TEXT NOT NULL,
	quoted_support TEXT,
	numbers TEXT,
	confidence TEXT,
	evidence_type TEXT,
	stance_target TEXT,
	stance TEXT,
	run_id TEXT,
		origin TEXT NOT NULL DEFAULT 'markdown',
	ingested_at TEXT NOT NULL,
	UNIQUE(note_id, claim_hash)
);
CREATE INDEX IF NOT EXISTS idx_claims_note ON claims(note_id);
CREATE INDEX IF NOT EXISTS idx_claims_run_id ON claims(run_id);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(id UNINDEXED, title, body_plain, tags, aliases, tokenize='porter unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts USING fts5(claim_id UNINDEXED, claim, quoted_support, tokenize='porter unicode61');
CREATE TABLE IF NOT EXISTS research_runs (
	id TEXT PRIMARY KEY,
	query TEXT NOT NULL,
	profile TEXT NOT NULL,
	tier TEXT NOT NULL,
	status TEXT NOT NULL,
	current_step TEXT,
	blocked_on TEXT,
	budget_usd REAL,
	spend_usd REAL NOT NULL DEFAULT 0,
	started_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	finished_at TEXT,
	error TEXT,
	manifest_path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_runs_updated ON research_runs(updated_at);
CREATE TABLE IF NOT EXISTS run_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
	step TEXT,
	type TEXT NOT NULL,
	status TEXT,
	message TEXT,
	data_json TEXT,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);
`;

export function openVaultDatabase(paths: VaultPaths, readOnly = false): DatabaseSync {
	if (!readOnly) mkdirSync(dirname(paths.database), { recursive: true });
	const db = new DatabaseSync(paths.database, { readOnly });
	db.exec("PRAGMA foreign_keys=ON;");
	if (!readOnly) {
		db.exec("PRAGMA journal_mode=WAL;");
		const currentVersion = Number((db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0);
		if (currentVersion > VAULT_SCHEMA_VERSION) {
			db.close();
			throw new Error(`Vault database schema ${currentVersion} is newer than this Feynman build supports (${VAULT_SCHEMA_VERSION}).`);
		}
		for (let version = currentVersion + 1; version <= VAULT_SCHEMA_VERSION; version += 1) {
			db.exec("BEGIN IMMEDIATE");
			try {
				if (version === 1) db.exec(SCHEMA);
				db.prepare("INSERT OR REPLACE INTO _meta(key, value) VALUES ('schema_version', ?)").run(String(version));
				db.exec(`PRAGMA user_version=${version};`);
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				db.close();
				throw error;
			}
		}
	}
	return db;
}

export function withVaultDatabase<T>(paths: VaultPaths, operation: (db: DatabaseSync) => T, readOnly = false): T {
	const db = openVaultDatabase(paths, readOnly);
	try {
		return operation(db);
	} finally {
		db.close();
	}
}
