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
    // Jev scores, rendered post cards and the decisions agents (Hermes) make about posts. Self-contained: references only phase 1 tables.
    id: '004_jev_decisions',
    sql: `
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  item_id TEXT REFERENCES items(id),
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX artifacts_item ON artifacts(item_id, kind);

CREATE TABLE predictions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  collection_run_id TEXT REFERENCES collection_runs(id),
  scorer TEXT NOT NULL,
  model_version TEXT NOT NULL,
  preference_summary_version TEXT NOT NULL,
  p_match REAL NOT NULL,
  p_engage REAL,
  confidence REAL,
  cost_usd REAL,
  calibrated INTEGER NOT NULL DEFAULT 0,
  passed_filter INTEGER,
  filter_reason TEXT,
  screenshot_ref TEXT REFERENCES artifacts(id),
  created_at TEXT NOT NULL
);
CREATE INDEX predictions_item ON predictions(item_id, preference_summary_version);
CREATE INDEX predictions_created ON predictions(created_at);

CREATE TABLE agent_decisions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  collection_run_id TEXT REFERENCES collection_runs(id),
  prediction_id TEXT REFERENCES predictions(id),
  client TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('interesting','not_interesting','send_to_owner','save_event')),
  reason TEXT,
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX agent_decisions_item ON agent_decisions(item_id);
`,
  },
];
