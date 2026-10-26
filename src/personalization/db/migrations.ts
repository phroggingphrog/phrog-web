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
];
