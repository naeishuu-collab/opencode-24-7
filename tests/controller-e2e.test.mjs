// End-to-end tests: the controller runs as a real child process, talks HTTP to
// a fake GitHub API and is driven over its own HTTP API (session cookie, job
// creation, ticks, dashboard). Restart recovery is proven by hard-killing the
// process and reopening the same database file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "../controller/lib/engine.mjs";
import { createGithub } from "../controller/lib/github.mjs";
import { createD1Executor, createStore } from "../controller/lib/store.mjs";
import { makeArtifactZip } from "./helpers/artifacts.mjs";
import { startFakeGithub } from "./stubs/fake-github.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ADMIN = "oc24_e2e_admin_token_abcdef";
const MODEL = "opencode/deepseek-v4.1-flash-free";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oc24-e2e-"));
const children = new Set();
process.on("exit", () => {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startController({ dbPath, githubApi, env = {} }) {
  const child = spawn(process.execPath, ["controller/server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      OC24_ADMIN_TOKEN: ADMIN,
      OC24_REPO: "owner/repo",
      OC24_GITHUB_TOKEN: "ghp_e2e_test_token_not_real",
      OC24_GITHUB_API: githubApi,
      OC24_DB_PATH: dbPath,
      OC24_PORT: "0",
      OC24_HOST: "127.0.0.1",
      OC24_TICK: "0", // tests drive the loop explicitly unless they opt in
      OC24_TICK_SECONDS: "5",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`controller did not start; stdout=${stdout} stderr=${stderr}`)), 30000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.listening) {
            clearTimeout(timer);
            resolve(parsed.url);
            return;
          }
        } catch {
          /* keep reading */
        }
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`controller exited early with ${code}; stderr=${stderr}`));
    });
  });
  return {
    child,
    url,
    stderr: () => stderr,
    stop: () =>
      new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill();
      }),
    kill: () => child.kill(),
  };
}

function client(baseUrl) {
  let cookie = null;
  const api = {
    cookie: () => cookie,
    async request(pathname, { method = "GET", body, headers = {} } = {}) {
      const res = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
      const session = setCookie.find((c) => c.startsWith("oc24_session="));
      if (session) cookie = session.split(";")[0];
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, text, json, headers: res.headers };
    },
    async login(token = ADMIN) {
      return api.request("/api/session", { method: "POST", body: { token } });
    },
    tick: () => api.request("/api/tick", { method: "POST", body: {} }),
    job: (id) => api.request(`/api/jobs/${id}`),
    async createJob(body) {
      return api.request("/api/jobs", { method: "POST", body });
    },
    async waitForJob(id, predicate, { timeoutMs = 20000, intervalMs = 250 } = {}) {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        const res = await api.request(`/api/jobs/${id}`);
        last = res.json?.job ?? null;
        if (last && predicate(last)) return last;
        await sleep(intervalMs);
      }
      throw new Error(`job ${id} did not reach the expected state; last=${JSON.stringify(last)}`);
    },
  };
  return api;
}

// ---------------------------------------------------------------------------

test("the server refuses to start without an admin token", async () => {
  const child = spawn(process.execPath, ["controller/server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, OC24_ADMIN_TOKEN: "", OC24_DB_PATH: path.join(TMP, "no-token.db") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => {
    stderr += c;
  });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 1);
  assert.match(stderr, /OC24_ADMIN_TOKEN is required/);
});

test("--print-config reports the effective settings without ever printing a token", async () => {
  const child = spawn(process.execPath, ["controller/server.mjs", "--print-config"], {
    cwd: ROOT,
    env: { ...process.env, OC24_ADMIN_TOKEN: ADMIN, OC24_GITHUB_TOKEN: "ghp_secret_value_should_not_print" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    stdout += c;
  });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 0);
  const config = JSON.parse(stdout);
  assert.equal(config.admin_token, "configured");
  assert.equal(config.github_token, "configured");
  assert.doesNotMatch(stdout, /ghp_secret_value_should_not_print/);
  assert.doesNotMatch(stdout, new RegExp(ADMIN));
});

test("full loop over HTTP: login, create, dispatch, verify the artifact, succeed", async () => {
  const fake = await startFakeGithub();
  const dbPath = path.join(TMP, "e2e-happy.db");
  const controller = await startController({ dbPath, githubApi: fake.url });
  try {
    const api = client(controller.url);

    const unauth = await api.request("/api/jobs");
    assert.equal(unauth.status, 401);
    assert.equal((await api.login("wrong-token")).status, 401);
    assert.equal((await api.login()).status, 200);
    assert.match(api.cookie(), /^oc24_session=[a-f0-9]{32,64}$/);

    const dash = await api.request("/");
    assert.equal(dash.status, 200);
    assert.match(dash.headers.get("content-security-policy"), /default-src 'none'/);
    const script = await api.request("/app.js");
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type"), /javascript/);

    const created = await api.createJob({ goal: "add a regression test for the tick lock", model: MODEL, verify_cmd: "npm test" });
    assert.equal(created.status, 201, created.text);
    const id = created.json.job.id;

    const tick = await api.tick();
    assert.equal(tick.status, 200);
    assert.equal(tick.json.dispatched.length, 1, tick.text);

    const inputs = fake.lastDispatchInputs();
    assert.equal(inputs.model, MODEL);
    assert.match(inputs.job_marker, /^oc24-job-/);
    assert.equal(inputs.prompt, "add a regression test for the tick lock");

    const [runId] = fake.runIds();
    fake.setRunStatus(runId, "in_progress");
    await api.tick();
    assert.equal((await api.job(id)).json.job.state, "running");

    fake.attachArtifact(runId, makeArtifactZip());
    fake.completeRun(runId, "success");
    await api.tick();

    const done = await api.job(id);
    assert.equal(done.json.job.state, "succeeded", done.text);
    assert.equal(done.json.job.cost_usd, 0);
    assert.equal(done.json.job.tokens_total, 150);
    assert.equal(done.json.job.verification.ok, true);
    assert.match(done.json.job.run_url, /\/runs\//);
    const attempt = done.json.attempts[0];
    assert.equal(attempt.state, "succeeded");
    assert.equal(attempt.metrics.source, "artifact-verified");
    assert.match(attempt.metrics.diff, /diff --git/);
    assert.ok(done.json.events.some((e) => e.kind === "job-succeeded"));

    const stats = await api.request("/api/stats");
    assert.equal(stats.json.jobsByState.succeeded, 1);
    assert.equal(stats.json.dispatchesToday, 1);
    assert.equal(stats.json.github_token, "configured");
  } finally {
    await controller.stop();
    await fake.close();
  }
});

test("the controller finishes a job on its own tick loop, without any manual call", async () => {
  const fake = await startFakeGithub();
  const dbPath = path.join(TMP, "e2e-autotick.db");
  const controller = await startController({ dbPath, githubApi: fake.url, env: { OC24_TICK: "1", OC24_TICK_SECONDS: "5" } });
  try {
    const api = client(controller.url);
    await api.login();
    const created = await api.createJob({ goal: "prove the tick loop works alone", model: MODEL });
    const id = created.json.job.id;

    // No tick request here: the server's own interval must dispatch it.
    const running = await api.waitForJob(id, (job) => job.state === "running" || job.state === "unknown", { timeoutMs: 30000 });
    assert.equal(running.state, "running", `run state was ${running.state}: ${running.last_error ?? ""}`);

    const [runId] = fake.runIds();
    fake.attachArtifact(runId, makeArtifactZip());
    fake.completeRun(runId, "success");
    const done = await api.waitForJob(id, (job) => ["succeeded", "failed", "unknown"].includes(job.state), { timeoutMs: 30000 });
    assert.equal(done.state, "succeeded");
  } finally {
    await controller.stop();
    await fake.close();
  }
});

test("restart recovery: a hard-killed controller resumes the job from the database", async () => {
  const fake = await startFakeGithub();
  const dbPath = path.join(TMP, "e2e-restart.db");
  const first = await startController({ dbPath, githubApi: fake.url });
  let id;
  try {
    const api = client(first.url);
    await api.login();
    const created = await api.createJob({ goal: "survive a controller crash", model: MODEL });
    id = created.json.job.id;
    await api.tick();
    assert.equal((await api.job(id)).json.job.state, "running");
    await api.tick(); // links the run to the attempt before the crash
    assert.ok((await api.job(id)).json.attempts[0].run_id, "the run link must exist before the restart");
  } finally {
    first.kill(); // no graceful shutdown: the database must be enough
    await new Promise((resolve) => first.child.once("exit", resolve));
  }

  const second = await startController({ dbPath, githubApi: fake.url });
  try {
    const api = client(second.url);
    await api.login();
    const resumed = await api.job(id);
    assert.equal(resumed.json.job.state, "running", "the job must survive a restart");
    assert.equal(resumed.json.attempts.length, 1);
    assert.ok(resumed.json.attempts[0].run_id, "the run link must be persisted");

    const [runId] = fake.runIds();
    fake.attachArtifact(runId, makeArtifactZip());
    fake.completeRun(runId, "success");
    await api.tick();
    const done = await api.job(id);
    assert.equal(done.json.job.state, "succeeded");
    assert.equal(done.json.attempts[0].conclusion, "success");
  } finally {
    await second.stop();
    await fake.close();
  }
});

test("the controller can be killed between dispatch and completion without duplicating the run", async () => {
  const fake = await startFakeGithub();
  const dbPath = path.join(TMP, "e2e-crash-dispatch.db");
  const first = await startController({ dbPath, githubApi: fake.url });
  let id;
  try {
    const api = client(first.url);
    await api.login();
    id = (await api.createJob({ goal: "no duplicate dispatch on crash", model: MODEL, max_attempts: 2 })).json.job.id;
    await api.tick();
    assert.equal(fake.dispatchCalls().length, 1);
  } finally {
    first.kill();
    await new Promise((resolve) => first.child.once("exit", resolve));
  }

  const second = await startController({ dbPath, githubApi: fake.url });
  try {
    const api = client(second.url);
    await api.login();
    // Several ticks: the running attempt must be adopted, never re-dispatched.
    await api.tick();
    await api.tick();
    assert.equal(fake.dispatchCalls().length, 1, "a restarted controller must not dispatch the same job again");
    assert.equal((await api.job(id)).json.job.state, "running");
    const [runId] = fake.runIds();
    fake.attachArtifact(runId, makeArtifactZip());
    fake.completeRun(runId, "success");
    await api.tick();
    assert.equal((await api.job(id)).json.job.state, "succeeded");
  } finally {
    await second.stop();
    await fake.close();
  }
});

test("a second controller on the same database does not double-dispatch (lease + attempt uniqueness)", async () => {
  const fake = await startFakeGithub();
  const dbPath = path.join(TMP, "e2e-two-controllers.db");
  const a = await startController({ dbPath, githubApi: fake.url });
  const b = await startController({ dbPath, githubApi: fake.url });
  try {
    const api = client(a.url);
    await api.login();
    const id = (await api.createJob({ goal: "two controllers, one dispatch", model: MODEL })).json.job.id;
    // Both controllers receive the same tick request at the same time.
    const [ra, rb] = await Promise.all([api.tick(), api.tick()]);
    assert.equal(ra.status, 200);
    assert.equal(rb.status, 200);
    await sleep(500);
    await api.tick();
    assert.equal(fake.dispatchCalls().length, 1, `expected exactly one dispatch, saw ${fake.dispatchCalls().length}`);
    const job = await api.job(id);
    assert.equal(job.json.job.state, "running");
    assert.equal(job.json.attempts.length, 1);
  } finally {
    await a.stop();
    await b.stop();
    await fake.close();
  }
});

test("the free-tier caps are visible over HTTP and stop dispatch when hit", async () => {
  const fake = await startFakeGithub();
  const dbPath = path.join(TMP, "e2e-caps.db");
  const controller = await startController({
    dbPath,
    githubApi: fake.url,
    env: { OC24_MAX_DISPATCH_PER_DAY: "1", OC24_MAX_CONCURRENT: "1", OC24_MAX_JOBS_PER_DAY: "2" },
  });
  try {
    const api = client(controller.url);
    await api.login();
    await api.createJob({ goal: "first job", model: MODEL });
    await api.createJob({ goal: "second job", model: MODEL });
    const blocked = await api.createJob({ goal: "third job", model: MODEL });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.error, "daily-job-cap");

    await api.tick();
    assert.equal(fake.dispatchCalls().length, 1);
    await api.tick();
    assert.equal(fake.dispatchCalls().length, 1, "the dispatch cap must hold the second job");

    const stats = await api.request("/api/stats");
    assert.equal(stats.json.caps.max_dispatch_per_day, 1);
    assert.equal(stats.json.dispatchesToday, 1);
    assert.equal(stats.json.jobsByState.queued, 1);
  } finally {
    await controller.stop();
    await fake.close();
  }
});

// ---------------------------------------------------------------------------
// Cloudflare D1 path (same store code, different call shape)
// ---------------------------------------------------------------------------

test("the store runs through the D1 executor call shape (Cloudflare path)", async () => {
  const fake = await startFakeGithub();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const d1 = {
    async exec(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      return {
        bind: (...params) => ({
          async run() {
            const r = db.prepare(sql).run(...params);
            return { success: true, meta: { changes: Number(r.changes ?? 0) } };
          },
          async all() {
            return { results: db.prepare(sql).all(...params) };
          },
          async first() {
            return db.prepare(sql).get(...params) ?? null;
          },
        }),
      };
    },
  };

  const store = await createStore(createD1Executor(d1)).init();
  const github = createGithub({ token: "ghp_d1_test_not_real", repo: "owner/repo", apiBase: fake.url, fetchImpl: fetch });
  const engine = createEngine({
    store,
    github,
    config: {
      repo: "owner/repo",
      ref: "main",
      workflow: "agent-job.yml",
      freeModels: [MODEL],
      maxConcurrent: 1,
      maxDispatchPerDay: 5,
      maxJobsPerDay: 5,
      maxCostUsd: 0,
      noRunGraceSec: 86400,
    },
  });

  const created = await engine.createJob({ goal: "d1 backed job", model: MODEL, verify_cmd: "npm test" });
  assert.equal(created.ok, true);
  const out = await engine.tick();
  assert.equal(out.dispatched.length, 1);
  const [runId] = fake.runIds();
  fake.attachArtifact(runId, makeArtifactZip());
  fake.completeRun(runId, "success");
  await engine.tick();

  const job = await store.getJob(created.job.id);
  assert.equal(job.state, "succeeded");
  assert.equal(job.tokens_total, 150);
  const attempt = (await store.listAttempts(created.job.id))[0];
  assert.equal(attempt.state, "succeeded");
  assert.equal(JSON.parse(attempt.metrics).source, "artifact-verified");
  assert.equal((await store.stats()).jobsByState.succeeded, 1);
  await fake.close();
});
