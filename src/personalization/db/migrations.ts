// Ordered, append-only migrations. Never edit an applied migration: its checksum is verified on open.
export interface Migration { id: string; sql: string }

export const MIGRATIONS: Migration[] = [
  {
    id: '001_phase1_feed',
    sql: `
CREATE TABLE source_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  handle TEXT NOT NULL,
  label TEXT,
  credential_ref TEXT,
  collect_enabled INTEGER NOT NULL DEFAULT 1,
  learn_enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','auth_required','challenge','disabled')),
  last_verified_at TEXT,
  UNIQUE (provider, handle)
);

CREATE TABLE collection_runs (
  id TEXT PRIMARY KEY,
  source_account_id TEXT NOT NULL REFERENCES source_accounts(id),
  collector TEXT NOT NULL,
  collector_version TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT CHECK (status IN ('success','partial','auth_required','challenge','rate_limited','unsupported','failed')),
  items_seen INTEGER NOT NULL DEFAULT 0,
  items_new INTEGER NOT NULL DEFAULT 0,
  checkpoint TEXT,
  error TEXT,
  coverage_note TEXT
);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'post',
  title TEXT,
  description TEXT,
  canonical_url TEXT,
  creator_item_id TEXT,
  published_at TEXT,
  published_precision TEXT NOT NULL DEFAULT 'unknown',
  duration_ms INTEGER,
  media_type TEXT,
  availability TEXT,
  author_json TEXT,
  hashtags_json TEXT,
  mentions_json TEXT,
  media_json TEXT,
  location_json TEXT,
  like_count INTEGER,
  comment_count INTEGER,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE item_ids (
  item_id TEXT NOT NULL REFERENCES items(id),
  provider TEXT NOT NULL,
  native_id TEXT NOT NULL,
  UNIQUE (provider, native_id)
);

CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_account_id TEXT NOT NULL REFERENCES source_accounts(id),
  collection_run_id TEXT REFERENCES collection_runs(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  action TEXT NOT NULL CHECK (action IN ('seen_in_feed','like','save','follow','play','skip','open')),
  feed_position INTEGER,
  sponsored INTEGER,
  suggested INTEGER,
  occurred_at TEXT NOT NULL,
  time_precision TEXT NOT NULL DEFAULT 'exact',
  purpose TEXT NOT NULL DEFAULT 'discovery',
  learn INTEGER NOT NULL DEFAULT 1,
  raw_ref TEXT,
  dedupe_key TEXT NOT NULL UNIQUE
);
CREATE INDEX observations_item ON observations(item_id);
`,
  },
  {
    // Instagram cursors grow ~700 chars per page; callers get the short run id instead.
    id: '002_next_checkpoint',
    sql: `ALTER TABLE collection_runs ADD COLUMN next_checkpoint TEXT;`,
  },
  {
    // Central import: wider action vocabulary, provenance columns, current-state rows, annotations, import audit.
    // observations is rebuilt because SQLite cannot alter a CHECK; ids and dedupe keys are preserved.
    id: '003_central_import',
    sql: `
CREATE TABLE import_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_db TEXT NOT NULL,
  source_file_sha256 TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  rows_read INTEGER NOT NULL DEFAULT 0,
  rows_added INTEGER NOT NULL DEFAULT 0,
  rows_skipped INTEGER NOT NULL DEFAULT 0,
  rows_rejected INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','failed')),
  detail_json TEXT
);

CREATE TABLE observations_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_account_id TEXT NOT NULL REFERENCES source_accounts(id),
  collection_run_id TEXT REFERENCES collection_runs(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  action TEXT NOT NULL CHECK (action IN ('seen_in_feed','like','save','follow','play','skip','open',
    'comment','share','post','search','review','not_interested','dislike','ad_view','ad_click')),
  feed_position INTEGER,
  sponsored INTEGER,
  suggested INTEGER,
  occurred_at TEXT NOT NULL,
  time_precision TEXT NOT NULL DEFAULT 'exact',
  purpose TEXT NOT NULL DEFAULT 'discovery',
  learn INTEGER NOT NULL DEFAULT 1,
  raw_ref TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  duration_ms INTEGER,
  detail_json TEXT,
  source_db TEXT,
  source_table TEXT,
  source_row_key TEXT,
  import_run_id TEXT REFERENCES import_runs(id)
);
INSERT INTO observations_new (id, source_account_id, collection_run_id, item_id, action, feed_position, sponsored, suggested,
  occurred_at, time_precision, purpose, learn, raw_ref, dedupe_key)
  SELECT id, source_account_id, collection_run_id, item_id, action, feed_position, sponsored, suggested,
  occurred_at, time_precision, purpose, learn, raw_ref, dedupe_key FROM observations;
DROP TABLE observations;
ALTER TABLE observations_new RENAME TO observations;
CREATE INDEX observations_item ON observations(item_id);
CREATE INDEX observations_import ON observations(import_run_id);
CREATE INDEX items_canonical_url ON items(canonical_url);

CREATE TABLE entity_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state_key TEXT NOT NULL UNIQUE,
  source_account_id TEXT NOT NULL REFERENCES source_accounts(id),
  item_id TEXT REFERENCES items(id),
  counterparty TEXT,
  relation TEXT NOT NULL,
  state TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  effective_at TEXT,
  import_run_id TEXT REFERENCES import_runs(id),
  provenance TEXT
);
CREATE INDEX entity_state_item ON entity_state(item_id);

CREATE TABLE annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES items(id),
  type TEXT NOT NULL CHECK (type IN ('topic','ocr','caption_summary','event_extraction')),
  value_json TEXT NOT NULL,
  confidence REAL,
  model_version TEXT,
  created_at TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,
  import_run_id TEXT REFERENCES import_runs(id),
  provenance TEXT
);
CREATE INDEX annotations_item ON annotations(item_id);
`,
  },
];
