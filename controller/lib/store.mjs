// Store: one SQL schema, two executors.
//
//   createStore(exec, { now })                      - the shared logic
//   createSqliteExecutor(path)                      - local dev, CI and tests
//   createD1Executor(db)                            - Cloudflare D1 (same SQLite dialect)
//
// Every method is async so the synchronous node:sqlite executor and the
// asynchronous D1 executor are interchangeable. Keep the SQL portable: no
// window functions, no RETURNING, one statement per call.
import { dayKey } from "./util.mjs";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS jobs (
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
   )`,
  `CREATE TABLE IF NOT EXISTS attempts (
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
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     job_id TEXT,
     attempt_id TEXT,
     kind TEXT NOT NULL,
     message TEXT,
     data TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS counters (
     day TEXT NOT NULL,
     name TEXT NOT NULL,
     value INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (day, name)
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL,
     ip TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_job ON attempts (job_id, n)`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_state ON attempts (state)`,
  `CREATE INDEX IF NOT EXISTS idx_events_job ON events (job_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs (state, created_at)`,
];

// Numbered, idempotent migrations for databases created by an older version.
// New databases already have every column, so each ALTER is allowed to fail
// with "duplicate column name" and is otherwise fatal.
const MIGRATIONS = [
  {
    version: 2,
    statements: [`ALTER TABLE jobs ADD COLUMN agent TEXT NOT NULL DEFAULT 'opencode'`],
  },
];

const JOB_COLUMNS = new Set([
  "updated_at", "state", "cancel_requested", "attempt_count", "cost_usd", "tokens_total",
  "run_id", "run_url", "artifact_name", "verification", "last_error", "finished_at",
  "approved_at", "approved_by",
]);

const ATTEMPT_COLUMNS = new Set([
  "state", "updated_at", "dispatched_at", "lease_expires_at", "heartbeat_at", "run_id",
  "run_url", "conclusion", "cost_usd", "tokens_total", "artifact_name", "verification",
  "metrics", "error",
]);

function likePattern(value) {
  return `%${String(value).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// One WHERE builder for list and count so a page and its total always agree.
function jobWhere({ state = null, states = null, q = null, before = null } = {}) {
  const where = [];
  const params = [];
  if (states?.length) {
    where.push(`state IN (${states.map(() => "?").join(", ")})`);
    params.push(...states);
  } else if (state) {
    where.push(`state = ?`);
    params.push(state);
  }
  if (q) {
    // D1 caps LIKE patterns at 50 bytes; the API truncates q before it gets here.
    where.push(`(id LIKE ? ESCAPE '\\' OR goal LIKE ? ESCAPE '\\')`);
    params.push(likePattern(q), likePattern(q));
  }
  if (before) {
    where.push(`created_at < ?`);
    params.push(before);
  }
  return { sql: where.length ? ` WHERE ${where.join(" AND ")}` : "", params };
}

function setClause(patch, allowed) {
  const keys = Object.keys(patch).filter((k) => allowed.has(k));
  if (!keys.length) return null;
  return { keys, sql: keys.map((k) => `${k} = ?`).join(", "), params: keys.map((k) => patch[k]) };
}

export function createStore(exec, { now = () => new Date().toISOString() } = {}) {
  const store = {
    async init() {
      for (const sql of SCHEMA) await exec.exec(sql);
      let version = Number((await exec.get(`SELECT v FROM meta WHERE k = 'schema'`))?.v ?? 0);
      if (!version) {
        await exec.run(`INSERT INTO meta (k, v) VALUES ('schema', ?)`, ["1"]);
        version = 1;
      }
      for (const migration of MIGRATIONS) {
        if (migration.version <= version) continue;
        for (const sql of migration.statements) {
          try {
            await exec.exec(sql);
          } catch (e) {
            if (!/duplicate column name|already exists/i.test(String(e?.message ?? e))) throw e;
          }
        }
        await exec.run(`INSERT INTO meta (k, v) VALUES ('schema', ?) ON CONFLICT (k) DO UPDATE SET v = ?`, [
          String(migration.version),
          String(migration.version),
        ]);
        version = migration.version;
      }
      return store;
    },

    async createJob(job) {
      await exec.run(
        `INSERT INTO jobs (id, created_at, updated_at, state, goal, verify_cmd, model, timeout_sec,
           max_attempts, repo, ref, workflow, agent, allow_external, attempt_count, cost_usd, tokens_total, cancel_requested)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
        [
          job.id, job.created_at, job.created_at, job.state, job.goal, job.verify_cmd ?? null, job.model,
          job.timeout_sec, job.max_attempts, job.repo, job.ref, job.workflow, job.agent ?? "opencode",
          job.allow_external ? 1 : 0,
        ],
      );
      return store.getJob(job.id);
    },

    async getJob(id) {
      return (await exec.get(`SELECT * FROM jobs WHERE id = ?`, [id])) ?? null;
    },

    async listJobs({ state = null, limit = 50, offset = 0, states = null, q = null, before = null } = {}) {
      const where = jobWhere({ state, states, q, before });
      return exec.all(
        `SELECT * FROM jobs${where.sql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
    },

    async countJobs({ states = null, since = null, state = null, q = null, before = null } = {}) {
      const where = jobWhere({ state, states, q, before });
      const params = [...where.params];
      let sql = where.sql;
      if (since) {
        sql += sql ? " AND created_at >= ?" : " WHERE created_at >= ?";
        params.push(since);
      }
      const row = await exec.get(`SELECT COUNT(*) AS n FROM jobs${sql}`, params);
      return Number(row?.n ?? 0);
    },

    async updateJob(id, patch) {
      const set = setClause({ updated_at: now(), ...patch }, JOB_COLUMNS);
      if (!set) return store.getJob(id);
      await exec.run(`UPDATE jobs SET ${set.sql} WHERE id = ?`, [...set.params, id]);
      return store.getJob(id);
    },

    async createAttempt(attempt) {
      await exec.run(
        `INSERT INTO attempts (id, job_id, n, marker, token_hash, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [attempt.id, attempt.job_id, attempt.n, attempt.marker, attempt.token_hash, attempt.state, attempt.created_at, attempt.created_at],
      );
      return store.getAttempt(attempt.id);
    },

    async getAttempt(id) {
      return (await exec.get(`SELECT * FROM attempts WHERE id = ?`, [id])) ?? null;
    },

    async getAttemptByMarker(marker) {
      return (await exec.get(`SELECT * FROM attempts WHERE marker = ?`, [marker])) ?? null;
    },

    async listAttempts(jobId) {
      return exec.all(`SELECT * FROM attempts WHERE job_id = ? ORDER BY n ASC`, [jobId]);
    },

    async listAttemptsByState(states) {
      if (!states?.length) return [];
      return exec.all(
        `SELECT * FROM attempts WHERE state IN (${states.map(() => "?").join(", ")}) ORDER BY created_at ASC`,
        states,
      );
    },

    async updateAttempt(id, patch) {
      const set = setClause({ updated_at: now(), ...patch }, ATTEMPT_COLUMNS);
      if (!set) return store.getAttempt(id);
      await exec.run(`UPDATE attempts SET ${set.sql} WHERE id = ?`, [...set.params, id]);
      return store.getAttempt(id);
    },

    async deleteAttempt(id) {
      await exec.run(`DELETE FROM attempts WHERE id = ?`, [id]);
    },

    async countActiveAttempts() {
      const row = await exec.get(`SELECT COUNT(*) AS n FROM attempts WHERE state IN ('dispatching', 'running')`);
      return Number(row?.n ?? 0);
    },

    async getMeta(k) {
      const row = await exec.get(`SELECT v FROM meta WHERE k = ?`, [k]);
      return row?.v ?? null;
    },

    async setMeta(k, v) {
      await exec.run(
        `INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = ?`,
        [k, String(v), String(v)],
      );
      return String(v);
    },

    async appendEvent({ job_id = null, attempt_id = null, kind, message = null, data = null, at = now() }) {
      await exec.run(`INSERT INTO events (at, job_id, attempt_id, kind, message, data) VALUES (?, ?, ?, ?, ?, ?)`, [
        at, job_id, attempt_id, kind, message, data ? JSON.stringify(data) : null,
      ]);
    },

    async listEvents({ job_id = null, since_seq = 0, limit = 200 } = {}) {
      if (job_id) {
        return exec.all(`SELECT * FROM events WHERE job_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`, [job_id, since_seq, limit]);
      }
      return exec.all(`SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?`, [since_seq, limit]);
    },

    async eventStats() {
      const row = await exec.get(`SELECT COUNT(*) AS n, MIN(at) AS oldest, MAX(at) AS newest FROM events`);
      return { count: Number(row?.n ?? 0), oldest: row?.oldest ?? null, newest: row?.newest ?? null };
    },

    // Retention: delete in bounded batches. D1 asks large DELETEs to be chunked
    // (a single statement touching hundreds of thousands of rows hits limits).
    async pruneEvents({ olderThan, batch = 500, batches = 4 } = {}) {
      let total = 0;
      for (let i = 0; i < batches; i++) {
        const r = await exec.run(
          `DELETE FROM events WHERE seq IN (SELECT seq FROM events WHERE at < ? LIMIT ?)`,
          [olderThan, batch],
        );
        total += r.changes;
        if (r.changes < batch) break;
      }
      return total;
    },

    // Goals are the only free text in the store; optional pruning keeps them out
    // of long-lived databases once the job is finished.
    async pruneGoals({ olderThan, batch = 200 } = {}) {
      const r = await exec.run(
        `UPDATE jobs SET goal = '[pruned]'
         WHERE id IN (SELECT id FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ? AND goal <> '[pruned]' LIMIT ?)`,
        [olderThan, batch],
      );
      return r.changes;
    },

    async bumpCounter(name, delta = 1, day = dayKey(now())) {
      await exec.run(
        `INSERT INTO counters (day, name, value) VALUES (?, ?, ?)
         ON CONFLICT (day, name) DO UPDATE SET value = value + ?`,
        [day, name, delta, delta],
      );
      return store.getCounter(name, day);
    },

    async getCounter(name, day = dayKey(now())) {
      const row = await exec.get(`SELECT value FROM counters WHERE day = ? AND name = ?`, [day, name]);
      return Number(row?.value ?? 0);
    },

    async setCounter(name, value, day = dayKey(now())) {
      await exec.run(
        `INSERT INTO counters (day, name, value) VALUES (?, ?, ?)
         ON CONFLICT (day, name) DO UPDATE SET value = ?`,
        [day, name, value, value],
      );
      return value;
    },

    async createSession(session) {
      await exec.run(`INSERT INTO sessions (id, created_at, expires_at, last_seen_at, ip) VALUES (?, ?, ?, ?, ?)`, [
        session.id, session.created_at, session.expires_at, session.created_at, session.ip ?? null,
      ]);
      return session;
    },

    async getSession(id) {
      return (await exec.get(`SELECT * FROM sessions WHERE id = ?`, [id])) ?? null;
    },

    async touchSession(id, at = now()) {
      await exec.run(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`, [at, id]);
    },

    async deleteSession(id) {
      await exec.run(`DELETE FROM sessions WHERE id = ?`, [id]);
    },

    async deleteExpiredSessions(at = now()) {
      const r = await exec.run(`DELETE FROM sessions WHERE expires_at < ?`, [at]);
      return r.changes;
    },

    async stats(at = now()) {
      const byState = await exec.all(`SELECT state, COUNT(*) AS n FROM jobs GROUP BY state`);
      const running = await exec.get(`SELECT COUNT(*) AS n FROM attempts WHERE state IN ('dispatching', 'running')`);
      return {
        jobsByState: Object.fromEntries(byState.map((r) => [r.state, Number(r.n)])),
        activeAttempts: Number(running?.n ?? 0),
        dispatchesToday: await store.getCounter("dispatch", dayKey(at)),
        jobsToday: await store.getCounter("job", dayKey(at)),
      };
    },
  };
  return store;
}

// node:sqlite executor (Node >= 22.5). Synchronous under the hood, async API.
export async function createSqliteExecutor(path) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  return {
    kind: "sqlite",
    async exec(sql) {
      db.exec(sql);
    },
    async run(sql, params = []) {
      const r = db.prepare(sql).run(...params);
      return { changes: Number(r.changes ?? 0) };
    },
    async all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    async get(sql, params = []) {
      return db.prepare(sql).get(...params) ?? null;
    },
    async close() {
      db.close();
    },
  };
}

// Cloudflare D1 executor: same SQL, only the call shape differs.
export function createD1Executor(d1) {
  return {
    kind: "d1",
    async exec(sql) {
      // D1's exec() splits its input on newlines and runs each line as its own
      // statement, so a formatted multi-line CREATE TABLE arrives as an
      // "incomplete input" error (live bug found on the first deploy). Split on
      // real statement boundaries, then flatten each statement to one line.
      const statements = String(sql)
        .split(/;\s*(?:\n|$)/)
        .map((part) => part.replace(/\s*\n\s*/g, " ").trim())
        .filter(Boolean);
      for (const statement of statements) await d1.exec(statement);
    },
    async run(sql, params = []) {
      const r = await d1.prepare(sql).bind(...params).run();
      return { changes: Number(r?.meta?.changes ?? 0) };
    },
    async all(sql, params = []) {
      const r = await d1.prepare(sql).bind(...params).all();
      return r?.results ?? [];
    },
    async get(sql, params = []) {
      return (await d1.prepare(sql).bind(...params).first()) ?? null;
    },
    async close() {},
  };
}
