-- OpenCode 24/7 controller schema, exactly what controller/lib/store.mjs creates.
--
--   wrangler d1 execute oc24-controller --file migrations/0001_schema.sql --local
--   wrangler d1 execute oc24-controller --file migrations/0001_schema.sql --remote
--
-- The controller also creates its own schema on first use, so applying this file
-- is optional; it exists so a D1 database can be inspected and prepared ahead of
-- a deploy without running the Worker.
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  state TEXT NOT NULL,
  goal TEXT NOT NULL,
  verify_cmd TEXT,
  model TEXT NOT NULL,
  timeout_sec INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  repo TEXT NOT NULL,
  ref TEXT NOT NULL,
  workflow TEXT NOT NULL,
  agent TEXT NOT NULL DEFAULT 'opencode',
  allow_external INTEGER NOT NULL DEFAULT 0,
  approved_at TEXT,
  approved_by TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  tokens_total INTEGER NOT NULL DEFAULT 0,
  run_id TEXT,
  run_url TEXT,
  artifact_name TEXT,
  verification TEXT,
  last_error TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  marker TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  dispatched_at TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  run_id TEXT,
  run_url TEXT,
  conclusion TEXT,
  cost_usd REAL,
  tokens_total INTEGER,
  artifact_name TEXT,
  verification TEXT,
  metrics TEXT,
  error TEXT,
  UNIQUE (job_id, n)
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  job_id TEXT,
  attempt_id TEXT,
  kind TEXT NOT NULL,
  message TEXT,
  data TEXT
);
CREATE TABLE IF NOT EXISTS counters (
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_job ON attempts (job_id, n);
CREATE INDEX IF NOT EXISTS idx_attempts_state ON attempts (state);
CREATE INDEX IF NOT EXISTS idx_events_job ON events (job_id, seq);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs (state, created_at);
