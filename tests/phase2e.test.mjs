// Phase 2E: agent adapters, pagination/search, retention, goal encryption and
// the D1 free-plan query budget (50 statements per Worker invocation).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../controller/app.mjs";
import { createEngine, validateJobSpec } from "../controller/lib/engine.mjs";
import { agentList } from "../controller/lib/agents.mjs";
import { createGithub } from "../controller/lib/github.mjs";
import { createSqliteExecutor, createStore } from "../controller/lib/store.mjs";
import { openText, sealText } from "../controller/lib/secretbox.mjs";
import { startFakeGithub } from "./stubs/fake-github.mjs";

const FREE = ["opencode/deepseek-v4.1-flash-free"];
const MODEL = FREE[0];
const ADMIN = "oc24_admin_test_token_123456";

let seq = 0;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oc24-phase2e-"));
process.on("exit", () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function harness({ engine: engineOverrides = {}, app: appOverrides = {}, key = null, counting = false } = {}) {
  const fake = await startFakeGithub();
  const dir = fs.mkdtempSync(path.join(TMP, `e-${++seq}-`));
  const base = await createSqliteExecutor(path.join(dir, "controller.db"));
  const counter = { statements: 0 };
  const exec = counting
    ? {
        kind: "counting",
        async exec(sql) {
          counter.statements++;
          return base.exec(sql);
        },
        async run(sql, params) {
          counter.statements++;
          return base.run(sql, params);
        },
        async all(sql, params) {
          counter.statements++;
          return base.all(sql, params);
        },
        async get(sql, params) {
          counter.statements++;
          return base.get(sql, params);
        },
        async close() {
          return base.close();
        },
      }
    : base;
  const store = await createStore(exec).init();
  const github = createGithub({ token: "ghp_phase2e_not_real", repo: "owner/repo", apiBase: fake.url, fetchImpl: fetch });
  const engine = createEngine({
    store,
    github,
    config: {
      repo: "owner/repo",
      ref: "main",
      workflow: "agent-job.yml",
      freeModels: FREE,
      maxConcurrent: 2,
      maxDispatchPerDay: 20,
      maxJobsPerDay: 50,
      maxCostUsd: 0,
      leaseSec: 900,
      noRunGraceSec: 1800,
      tickLeaseSec: 60,
      goalKey: key,
      ...engineOverrides,
    },
  });
  const app = createApp({
    store,
    engine,
    assets: { index: "<!doctype html><title>dash</title>", appJs: "// app", styleCss: "/* css */" },
    config: {
      adminToken: ADMIN,
      repo: "owner/repo",
      ref: "main",
      workflow: "agent-job.yml",
      freeModels: FREE,
      maxJobsPerDay: 50,
      maxDispatchPerDay: 20,
      maxConcurrent: 2,
      maxCostUsd: 0,
      controllerUrl: null,
      githubConfigured: true,
      ...appOverrides,
    },
  });
  return { fake, dir, store, engine, app, github, counter };
}

async function call(app, urlPath, { method = "GET", body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const res = await app.handle(
    new Request(`http://localhost:8787${urlPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

async function login(app) {
  const res = await call(app, "/api/session", { method: "POST", body: { token: ADMIN } });
  assert.equal(res.status, 200, res.text);
  return res.headers.get("set-cookie").split(";")[0];
}

async function makeJob(engine, overrides = {}) {
  const result = await engine.createJob({ goal: "fix the flaky test in the runner", model: MODEL, ...overrides });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.job;
}

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

test("agents: unknown and not-yet-available agents fail closed before dispatch", () => {
  const unknown = validateJobSpec({ goal: "make it work", model: MODEL, agent: "nope" }, { freeModels: new Set(FREE) });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "agent-not-found");

  const planned = validateJobSpec({ goal: "make it work", model: MODEL, agent: "codex" }, { freeModels: new Set(FREE) });
  assert.equal(planned.ok, false);
  assert.equal(planned.code, "agent-unavailable");

  const ok = validateJobSpec({ goal: "make it work", model: MODEL }, { freeModels: new Set(FREE) });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.value.agent, "opencode");
  assert.equal(ok.value.workflow, "agent-job.yml");

  const badModel = validateJobSpec({ goal: "make it work", model: "openai/gpt-5" }, { freeModels: new Set(FREE) });
  assert.equal(badModel.code, "model-not-allowlisted");

  // The adapter's own limits win over whatever the API caller asked for.
  const slow = validateJobSpec({ goal: "make it work", model: MODEL, timeout_sec: 99999, max_attempts: 99 }, { freeModels: new Set(FREE) });
  assert.equal(slow.value.timeout_sec, 3600);
  assert.equal(slow.value.max_attempts, 3);
});

test("agents: only available agents advertise models", () => {
  const listed = agentList({ freeModels: FREE });
  const opencode = listed.find((a) => a.id === "opencode");
  assert.equal(opencode.available, true);
  assert.deepEqual(opencode.models, FREE);
  for (const planned of listed.filter((a) => a.id !== "opencode")) {
    assert.equal(planned.available, false);
    assert.deepEqual(planned.models, []);
    assert.ok(planned.reason);
  }
});

test("agents: the job stores its agent and both API paths expose it", async () => {
  const { app, engine } = await harness();
  const job = await makeJob(engine);
  assert.equal(job.agent, "opencode");
  const cookie = await login(app);
  const detail = await call(app, `/api/jobs/${job.id}`, { cookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.job.agent, "opencode");
  const list = await call(app, "/api/jobs", { cookie });
  assert.equal(list.json.jobs[0].agent, "opencode");
  const config = await call(app, "/api/config", { cookie });
  assert.equal(config.json.agents.find((a) => a.id === "opencode").available, true);
});

// ---------------------------------------------------------------------------
// pagination and search
// ---------------------------------------------------------------------------

test("list: pagination reports a stable total and has_more", async () => {
  const { app, engine } = await harness();
  for (let i = 1; i <= 5; i++) await makeJob(engine, { goal: `job number ${i}` });
  const cookie = await login(app);

  const first = await call(app, "/api/jobs?limit=2&offset=0", { cookie });
  assert.equal(first.status, 200);
  assert.equal(first.json.jobs.length, 2);
  assert.equal(first.json.total, 5);
  assert.equal(first.json.has_more, true);

  const last = await call(app, "/api/jobs?limit=2&offset=4", { cookie });
  assert.equal(last.json.jobs.length, 1);
  assert.equal(last.json.has_more, false);

  const filtered = await call(app, "/api/jobs?state=succeeded", { cookie });
  assert.equal(filtered.json.total, 0);
  assert.equal(filtered.json.jobs.length, 0);
});

test("list: search matches ids and goals, filters by state, and truncates long terms", async () => {
  const { app, engine } = await harness();
  const alpha = await makeJob(engine, { goal: "repair the flaky integration test" });
  await makeJob(engine, { goal: "write documentation for the dashboard" });
  const cookie = await login(app);

  const byGoal = await call(app, "/api/jobs?q=flaky", { cookie });
  assert.equal(byGoal.status, 200);
  assert.deepEqual(byGoal.json.jobs.map((j) => j.id), [alpha.id]);
  assert.equal(byGoal.json.total, 1);

  const byId = await call(app, `/api/jobs?q=${encodeURIComponent(alpha.id.slice(-8))}`, { cookie });
  assert.ok(byId.json.jobs.some((j) => j.id === alpha.id));

  const none = await call(app, "/api/jobs?q=definitely-not-there", { cookie });
  assert.equal(none.json.total, 0);

  // D1 rejects LIKE patterns over 50 bytes; the API must never forward one.
  const long = await call(app, `/api/jobs?q=${encodeURIComponent("あ".repeat(60))}`, { cookie });
  assert.equal(long.status, 200);
  assert.ok(new TextEncoder().encode(long.json.q).length <= 40);
});

// ---------------------------------------------------------------------------
// retention
// ---------------------------------------------------------------------------

test("retention: events older than the window are pruned, recent ones are kept", async () => {
  const { store, engine } = await harness({ engine: { eventRetentionDays: 30, maintenanceSec: 0 } });
  await store.appendEvent({ kind: "ancient", at: "2020-01-01T00:00:00Z" });
  await store.appendEvent({ kind: "recent" });
  const before = await store.eventStats();
  assert.ok(before.count >= 2);

  const at = new Date().toISOString();
  const out = await engine.maintenance({ at });
  assert.ok(out.pruned_events >= 1, JSON.stringify(out));
  const kinds = (await store.listEvents({ limit: 500 })).map((e) => e.kind);
  assert.ok(!kinds.includes("ancient"));
  assert.ok(kinds.includes("recent"));
});

test("retention: maintenance is throttled and can scrub goals of finished jobs", async () => {
  const { store, engine } = await harness({ engine: { eventRetentionDays: 7, goalRetentionDays: 1, maintenanceSec: 3600 } });
  const at = new Date().toISOString();
  const first = await engine.maintenance({ at });
  assert.equal(first.skipped, null);
  const second = await engine.maintenance({ at });
  assert.ok(second.skipped, "second run within maintenanceSec must be skipped");

  // A finished job older than a day loses its goal text; the job row stays.
  const job = await makeJob(engine, { goal: "a goal that should not live forever" });
  await store.updateJob(job.id, { state: "failed", finished_at: "2020-01-02T00:00:00Z" });
  await store.setMeta("last_maintenance_at", "2020-01-01T00:00:00Z");
  const later = new Date(Date.now() + 2 * 86400_000).toISOString();
  await engine.maintenance({ at: later });
  const row = await store.getJob(job.id);
  assert.equal(row.goal, "[pruned]");
  assert.equal(row.state, "failed");
});

// ---------------------------------------------------------------------------
// goal encryption at rest
// ---------------------------------------------------------------------------

test("goals: an encrypted store keeps the plaintext out of the database but serves it to a session", async () => {
  const key = "test-goal-key-0123456789abcdef";
  const { app, engine, store } = await harness({ key });
  const goal = "secrets: rotate the staging credential reference";
  const job = await makeJob(engine, { goal });

  const row = await store.getJob(job.id);
  assert.match(row.goal, /^enc1\./);
  assert.ok(!row.goal.includes("rotate the staging"));
  assert.ok(!row.goal.includes(goal));

  const cookie = await login(app);
  const detail = await call(app, `/api/jobs/${job.id}`, { cookie });
  assert.equal(detail.json.job.goal, goal);
  const list = await call(app, "/api/jobs", { cookie });
  assert.equal(list.json.jobs.find((j) => j.id === job.id).goal, goal);

  // The goal must not leak through the audit trail either.
  const events = await store.listEvents({ job_id: job.id, limit: 200 });
  assert.ok(events.length >= 1);
  for (const event of events) {
    assert.ok(!JSON.stringify(event).includes("rotate the staging"), `goal leaked in event ${event.kind}`);
  }
});

test("goals: a wrong or missing key fails closed without throwing", async () => {
  const sealed = await sealText("a-valid-key-0123456789", "top secret plan");
  assert.match(sealed, /^enc1\./);
  assert.equal(await openText("a-different-key-0123456789", sealed), "[encrypted: cannot decrypt with the configured OC24_GOAL_KEY]");
  assert.equal(await openText(null, sealed), "[encrypted: OC24_GOAL_KEY is not configured on this controller]");
  assert.equal(await openText("a-valid-key-0123456789", sealed), "top secret plan");
  // Text that merely looks like a prefix is not treated as ciphertext.
  assert.equal(await openText("a-valid-key-0123456789", "enc1.hello"), "enc1.hello");
});

// ---------------------------------------------------------------------------
// D1 free-plan budget
// ---------------------------------------------------------------------------

test("tick: stays inside the D1 free-plan 50-statement budget", async () => {
  const { engine, counter } = await harness({
    counting: true,
    engine: { maxPollsPerTick: 5, maxDispatchesPerTick: 1, noRunGraceSec: 1800 },
  });
  for (let i = 0; i < 3; i++) await makeJob(engine, { goal: `budget job ${i}` });

  counter.statements = 0;
  const out = await engine.tick();
  assert.equal(out.dispatched.length, 1);
  // 50 is the hard D1 limit per invocation; leave headroom for a second
  // dispatch/poll batch added later.
  assert.ok(counter.statements <= 45, `tick used ${counter.statements} statements`);
});

// ---------------------------------------------------------------------------
// migration
// ---------------------------------------------------------------------------

test("store: a Phase 2D database gains the agent column without losing jobs", async () => {
  const dir = fs.mkdtempSync(path.join(TMP, "migrate-"));
  const dbPath = path.join(dir, "old.db");

  const first = await createStore(await createSqliteExecutor(dbPath)).init();
  const job = await first.createJob({
    id: "job-old",
    created_at: "2026-01-01T00:00:00Z",
    state: "queued",
    goal: "old job",
    model: MODEL,
    timeout_sec: 1800,
    max_attempts: 1,
    repo: "owner/repo",
    ref: "main",
    workflow: "agent-job.yml",
  });
  assert.equal(job.agent, "opencode");

  // Rebuild the Phase 2D shape: no agent column, schema version 1.
  const raw = await createSqliteExecutor(dbPath);
  await raw.exec("ALTER TABLE jobs DROP COLUMN agent");
  await raw.run("UPDATE meta SET v = '1' WHERE k = 'schema'");
  await raw.close();

  const migrated = await createStore(await createSqliteExecutor(dbPath)).init();
  assert.equal(await migrated.getMeta("schema"), "2");
  const old = await migrated.getJob("job-old");
  assert.equal(old.goal, "old job");
  assert.equal(old.agent, "opencode");
});
