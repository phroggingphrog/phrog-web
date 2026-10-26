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
  {
    // Ranked discovery: events, runs, deliveries, owner feedback, explicit rules, derived preferences and their stored summary.
    id: '005_discover_feedback',
    sql: `
CREATE TABLE event_details (
  item_id TEXT PRIMARY KEY REFERENCES items(id),
  starts_at TEXT,
  ends_at TEXT,
  timezone TEXT,
  time_precision TEXT NOT NULL DEFAULT 'unknown' CHECK (time_precision IN ('minute','day','unknown')),
  venue_text TEXT,
  venue_item_id TEXT REFERENCES items(id),
  distance_km REAL,
  price_min REAL,
  price_max REAL,
  currency TEXT,
  booking_url TEXT,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('scheduled','cancelled','sold_out','unknown')),
  last_checked_at TEXT
);
CREATE INDEX event_details_starts ON event_details(starts_at);

CREATE TABLE discovery_runs (
  id TEXT PRIMARY KEY,
  client TEXT,
  intent TEXT,
  constraints_json TEXT,
  ranker_version TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT,
  failed_sources_json TEXT,
  stats_json TEXT
);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  discovery_run_id TEXT NOT NULL REFERENCES discovery_runs(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  position INTEGER NOT NULL,
  reason TEXT,
  returned_at TEXT NOT NULL,
  displayed_at TEXT
);
CREATE INDEX deliveries_run ON deliveries(discovery_run_id);
CREATE INDEX deliveries_item ON deliveries(item_id);

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  delivery_id TEXT REFERENCES deliveries(id),
  type TEXT NOT NULL CHECK (type IN ('like','dislike','save','not_now','too_far','too_expensive','want_to_go')),
  scope TEXT NOT NULL CHECK (scope IN ('this_time','item','creator','topic','venue')),
  reason TEXT,
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX feedback_item ON feedback(item_id);

CREATE TABLE preference_rules (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  rule TEXT NOT NULL CHECK (rule IN ('prefer','avoid','exclude','radius','budget')),
  value TEXT,
  valid_until TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE preferences (
  subject_type TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  horizon TEXT NOT NULL CHECK (horizon IN ('long','recent')),
  score REAL NOT NULL,
  evidence_count INTEGER NOT NULL,
  distinct_days INTEGER NOT NULL,
  computed_at TEXT NOT NULL,
  version TEXT NOT NULL,
  PRIMARY KEY (subject_type, subject_key, horizon)
);

CREATE TABLE preference_summary (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version TEXT NOT NULL,
  text TEXT NOT NULL,
  computed_at TEXT NOT NULL
);
`,
  },
  {
    // Statistical preference model: Beta posteriors per subject and a record of each fit.
    id: '006_stats_model',
    sql: `
ALTER TABLE preferences ADD COLUMN alpha REAL;
ALTER TABLE preferences ADD COLUMN beta REAL;
ALTER TABLE preferences ADD COLUMN mean REAL;
ALTER TABLE preferences ADD COLUMN ci_low REAL;
ALTER TABLE preferences ADD COLUMN ci_high REAL;
ALTER TABLE preferences ADD COLUMN n_eff REAL;
ALTER TABLE preferences ADD COLUMN model_version TEXT;
CREATE INDEX item_ids_item ON item_ids(item_id);

CREATE TABLE preference_model_runs (
  id TEXT PRIMARY KEY,
  model_version TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  inputs_cutoff TEXT,
  config_json TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  priors_json TEXT NOT NULL,
  runtime_ms INTEGER
);
`,
  },
];
