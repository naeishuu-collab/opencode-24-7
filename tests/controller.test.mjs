// Controller tests: store, validation, the job state machine (against a fake
// GitHub REST API over real HTTP) and the HTTP handler.
//
// The engine is driven through the real github.mjs client on purpose, so HTTP
// status handling (permanent vs rate-limited vs unknown) is covered too.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../controller/app.mjs";
import { contractCheck, createEngine, extractMetrics, validateJobSpec } from "../controller/lib/engine.mjs";
import { createGithub } from "../controller/lib/github.mjs";
import { createSqliteExecutor, createStore } from "../controller/lib/store.mjs";
import { readZipEntries } from "../controller/lib/zip.mjs";
import { makeArtifactZip, makeJobJson, makeZip } from "./helpers/artifacts.mjs";
import { startFakeGithub } from "./stubs/fake-github.mjs";

const FREE = ["opencode/deepseek-v4.1-flash-free"];
const MODEL = FREE[0];
const ADMIN = "oc24_admin_test_token_123456";

let seq = 0;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oc24-controller-tests-"));
process.on("exit", () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* temp cleanup is best effort */
  }
});

async function harness({ engine: engineOverrides = {}, app: appOverrides = {} } = {}) {
  const fake = await startFakeGithub();
  const dir = fs.mkdtempSync(path.join(TMP, `c-${++seq}-`));
  const dbPath = path.join(dir, "controller.db");
  // A controllable clock so lease, grace and pause windows can be crossed
  // without sleeping. It starts at the real time so timestamps written by the
  // fake GitHub (real clock) and by the controller stay comparable.
  let clockMs = Date.now();
  const clock = {
    now: () => new Date(clockMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    advance: (sec) => {
      clockMs += sec * 1000;
      return clock.now();
    },
  };
  const store = await createStore(await createSqliteExecutor(dbPath), { now: clock.now }).init();
  const github = createGithub({ token: "ghp_test_token_not_real", repo: "owner/repo", apiBase: fake.url, fetchImpl: fetch });
  const engine = createEngine({
    store,
    github,
    now: clock.now,
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
      noRunGraceSec: 0,
      tickLeaseSec: 60,
      ...engineOverrides,
    },
  });
  const app = createApp({
    store,
    engine,
    now: clock.now,
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
  return { fake, dir, dbPath, store, engine, app, github, clock };
}

async function call(app, urlPath, { method = "GET", body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const res = await app.handle(
    new Request(`http://localhost:8787${urlPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
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
  const cookie = res.headers.get("set-cookie");
  assert.match(cookie, /oc24_session=[a-f0-9]{32,64}/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  return cookie.split(";")[0];
}

async function createJob(engine, overrides = {}) {
  const result = await engine.createJob({
    goal: "fix the flaky test in the runner",
    model: MODEL,
    verify_cmd: "npm test",
    ...overrides,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.job;
}

function finishRun(fake, runId, { conclusion = "success", bytes = makeArtifactZip(), name, expired = false } = {}) {
  if (bytes) fake.attachArtifact(runId, bytes, { name, expired });
  fake.completeRun(runId, conclusion);
  return runId;
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

test("store keeps jobs, attempts, events, counters and sessions, and survives a reopen", async () => {
  const { store, dbPath } = await harness();
  const job = await store.createJob({
    id: "job-1",
    created_at: "2026-10-19T10:00:00Z",
    state: "queued",
    goal: "g",
    verify_cmd: null,
    model: MODEL,
    timeout_sec: 60,
    max_attempts: 1,
    repo: "owner/repo",
    ref: "main",
    workflow: "agent-job.yml",
    allow_external: false,
  });
  assert.equal(job.state, "queued");
  await store.updateJob("job-1", { state: "running", attempt_count: 1 });
  await store.createAttempt({
    id: "att-1",
    job_id: "job-1",
    n: 1,
    marker: "m-1",
    token_hash: "a".repeat(64),
    state: "dispatching",
    created_at: "2026-10-19T10:00:01Z",
  });
  await store.appendEvent({ job_id: "job-1", kind: "test-event", message: "hello" });
  await store.bumpCounter("dispatch");
  await store.bumpCounter("dispatch");
  await store.setMeta("tick_lock_until", "2026-10-19T10:01:00Z");
  await store.createSession({ id: "s".repeat(32), created_at: "2026-10-19T10:00:00Z", expires_at: "2026-10-20T10:00:00Z" });

  assert.equal((await store.getJob("job-1")).state, "running");
  assert.equal((await store.getAttemptByMarker("m-1")).id, "att-1");
  assert.equal(await store.getCounter("dispatch"), 2);
  assert.equal(await store.getMeta("tick_lock_until"), "2026-10-19T10:01:00Z");
  assert.equal((await store.listEvents({ job_id: "job-1" })).length, 1);
  assert.equal(await store.countActiveAttempts(), 1);
  assert.equal((await store.stats()).jobsByState.running, 1);

  // Reopen the same file: state must be there (controller restart recovery).
  const reopened = await createStore(await createSqliteExecutor(dbPath)).init();
  assert.equal((await reopened.getJob("job-1")).attempt_count, 1);
  assert.equal((await reopened.getSession("s".repeat(32))).id, "s".repeat(32));
  assert.equal(await reopened.countActiveAttempts(), 1);
});

// ---------------------------------------------------------------------------
// validation and policy
// ---------------------------------------------------------------------------

test("validateJobSpec enforces the free-model allowlist and clamps budgets", async () => {
  const freeModels = new Set(FREE);
  assert.equal(validateJobSpec({ goal: "do a thing", model: "opencode/paid-model" }, { freeModels }).code, "model-not-allowlisted");
  assert.equal(validateJobSpec({ goal: "x", model: MODEL }, { freeModels }).code, "invalid-goal");
  const v = validateJobSpec({ goal: "  build the thing  ", model: MODEL, timeout_sec: 999999, max_attempts: 99 }, { freeModels });
  assert.equal(v.ok, true);
  assert.equal(v.value.goal, "build the thing");
  assert.equal(v.value.timeout_sec, 3600);
  assert.equal(v.value.max_attempts, 3);
  assert.equal(validateJobSpec({ goal: "do it", model: MODEL, verify_cmd: 5 }, { freeModels }).code, "invalid-verify");
});

test("engine refuses a paid model and holds external-effect jobs for approval", async () => {
  const { engine, store } = await harness();
  const paid = await engine.createJob({ goal: "ship it", model: "openai/gpt-5" });
  assert.equal(paid.ok, false);
  assert.equal(paid.code, "model-not-allowlisted");

  const risky = await createJob(engine, { goal: "push the change to main", allow_external: true });
  assert.equal(risky.state, "awaiting_approval");
  let tick = await engine.tick();
  assert.equal(tick.dispatched.length, 0, "an unapproved external job must not be dispatched");
  assert.equal((await store.getJob(risky.id)).state, "awaiting_approval");

  const approved = await engine.approveJob(risky.id, { actor: "test" });
  assert.equal(approved.ok, true);
  assert.equal(approved.job.state, "queued");
  tick = await engine.tick();
  assert.equal(tick.dispatched.length, 1);
});

test("engine enforces the daily job cap", async () => {
  const { engine } = await harness({ engine: { maxJobsPerDay: 2 } });
  assert.equal((await engine.createJob({ goal: "one", model: MODEL })).ok, true);
  assert.equal((await engine.createJob({ goal: "two", model: MODEL })).ok, true);
  const third = await engine.createJob({ goal: "three", model: MODEL });
  assert.equal(third.ok, false);
  assert.equal(third.code, "daily-job-cap");
});

// ---------------------------------------------------------------------------
// independent verification (contract)
// ---------------------------------------------------------------------------

test("contractCheck verifies the artifact against the policy the controller set", () => {
  const job = { model: MODEL, verify_cmd: "npm test" };
  assert.deepEqual(contractCheck(job, makeJobJson(), null, { maxCostUsd: 0 }).ok, true);

  const paid = contractCheck(job, makeJobJson({ usage: { steps: 1, tokens: { total: 10 }, costUsd: 0.02, costReported: true } }), null, { maxCostUsd: 0 });
  assert.equal(paid.ok, false);
  assert.match(paid.reasons.join(" "), /cost/);

  const otherModel = contractCheck(job, makeJobJson({ model: "opencode/other-free" }), null, { maxCostUsd: 0 });
  assert.equal(otherModel.ok, false);
  assert.match(otherModel.reasons.join(" "), /requested/);

  const committed = contractCheck(job, makeJobJson({ target: { commitBefore: "a", commitAfter: "b", changedPaths: [] } }), null, { maxCostUsd: 0 });
  assert.equal(committed.ok, false);
  assert.match(committed.reasons.join(" "), /read-only/);

  const noVerify = contractCheck(job, makeJobJson({ verification: null }), null, { maxCostUsd: 0 });
  assert.equal(noVerify.ok, false);
  assert.match(noVerify.reasons.join(" "), /verify command/);

  const failedVerify = contractCheck(job, makeJobJson({ status: "verify-failed", verification: { cmd: "npm test", exitCode: 1, status: "failed" } }), null, {
    maxCostUsd: 0,
  });
  assert.equal(failedVerify.ok, false);
});

test("zip reader handles deflate and stored entries and refuses junk", async () => {
  const zip = makeZip({ "a/job.json": JSON.stringify(makeJobJson()), "a/diff.patch": "diff\n" });
  const entries = await readZipEntries(new Uint8Array(zip));
  assert.equal([...entries.keys()].sort().join(","), "a/diff.patch,a/job.json");
  assert.match(new TextDecoder().decode(entries.get("a/diff.patch")), /diff/);

  const stored = await readZipEntries(new Uint8Array(makeZip({ "x.txt": "plain" }, { store: true })));
  assert.equal(new TextDecoder().decode(stored.get("x.txt")), "plain");

  await assert.rejects(() => readZipEntries(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /not a zip archive/);
});

test("extractMetrics reads the runner's job.json shape", async () => {
  const entries = await readZipEntries(new Uint8Array(makeArtifactZip()));
  const jobJson = JSON.parse(new TextDecoder().decode(entries.get("run-base/job-test/job.json")));
  const metrics = extractMetrics(jobJson, entries);
  assert.equal(metrics.model, MODEL);
  assert.equal(metrics.costUsd, 0);
  assert.equal(metrics.tokens, 150);
  assert.equal(metrics.verification.status, "passed");
  assert.match(metrics.diff, /diff --git/);
  assert.match(metrics.summary, /status: success/);
  assert.equal(metrics.source, "artifact-verified");
});

// ---------------------------------------------------------------------------
// dispatch and the state machine
// ---------------------------------------------------------------------------

test("a full job: dispatch once, verify the artifact, succeed with metrics", async () => {
  const { engine, store, fake } = await harness();
  const job = await createJob(engine);

  const t1 = await engine.tick();
  assert.equal(t1.dispatched.length, 1);
  const dispatch = fake.lastDispatchInputs();
  assert.match(dispatch.job_marker, /^oc24-job-/);
  assert.equal(dispatch.model, MODEL);
  assert.equal(dispatch.verify_cmd, "npm test");
  assert.match(dispatch.attempt_token, /^oc24_[a-f0-9]{48}$/);
  assert.equal((await store.getJob(job.id)).state, "running");

  const [runId] = fake.runIds();
  fake.setRunStatus(runId, "in_progress");
  const t2 = await engine.tick();
  assert.equal(t2.finalized.length, 0, "a run still in progress must not be finalised");

  finishRun(fake, runId, { conclusion: "success" });
  const t3 = await engine.tick();
  assert.equal(t3.finalized.length, 1);
  const done = await store.getJob(job.id);
  assert.equal(done.state, "succeeded");
  assert.equal(done.cost_usd, 0);
  assert.equal(done.tokens_total, 150);
  assert.equal(JSON.parse(done.verification).ok, true);
  assert.match(done.run_url, /\/runs\//);

  // Idempotent: another tick finds nothing running and does not re-dispatch.
  const t4 = await engine.tick();
  assert.equal(t4.dispatched.length, 0);
  assert.equal(t4.finalized.length, 0);
  assert.equal(fake.dispatchCalls().length, 1);
});

test("a completed run whose artifact costs money is failed, not accepted", async () => {
  const { engine, store, fake } = await harness();
  const job = await createJob(engine);
  await engine.tick();
  const [runId] = fake.runIds();
  finishRun(fake, runId, {
    bytes: makeArtifactZip({ usage: { steps: 3, tokens: { total: 10 }, costUsd: 0.03, costReported: true } }),
  });
  await engine.tick();
  const done = await store.getJob(job.id);
  assert.equal(done.state, "failed");
  assert.match(done.last_error, /cost/);
});

test("a run that committed to the repository is failed (read-only proof)", async () => {
  const { engine, store, fake } = await harness();
  const job = await createJob(engine);
  await engine.tick();
  const [runId] = fake.runIds();
  finishRun(fake, runId, { bytes: makeArtifactZip({ target: { commitBefore: "aaa", commitAfter: "bbb", changedPaths: [] } }) });
  await engine.tick();
  const done = await store.getJob(job.id);
  assert.equal(done.state, "failed");
  assert.match(done.last_error, /read-only/);
});

test("missing artifact is a safe stop: unknown, never success", async () => {
  const { engine, store, fake } = await harness();
  const job = await createJob(engine);
  await engine.tick();
  const [runId] = fake.runIds();
  fake.completeRun(runId, "success"); // no artifact attached
  const out = await engine.tick();
  assert.equal(out.finalized.length, 1);
  const done = await store.getJob(job.id);
  assert.equal(done.state, "unknown");
  assert.match(done.last_error, /artifact/);
});

test("a corrupt artifact is a safe stop too", async () => {
  const { engine, store, fake } = await harness();
  const job = await createJob(engine);
  await engine.tick();
  const [runId] = fake.runIds();
  finishRun(fake, runId, { bytes: Buffer.from("this is not a zip") });
  await engine.tick();
  const done = await store.getJob(job.id);
  assert.equal(done.state, "unknown");
  assert.match(done.last_error, /artifact/);
});

test("a failed run is failed even when its artifact looks fine", async () => {
  const { engine, store, fake } = await harness();
  const job = await createJob(engine);
  await engine.tick();
  const [runId] = fake.runIds();
  finishRun(fake, runId, { conclusion: "failure" });
  await engine.tick();
  const done = await store.getJob(job.id);
  assert.equal(done.state, "failed");
  assert.match(done.last_error, /concluded "failure"/);
});

test("a cancelled run maps to cancelled", async () => {
  const { engine, store, fake } = await harness();
  const job = await createJob(engine);
  await engine.tick();
  const [runId] = fake.runIds();
  finishRun(fake, runId, { conclusion: "cancelled", bytes: null });
  await engine.tick();
  assert.equal((await store.getJob(job.id)).state, "cancelled");
});

test("a rejected dispatch (422) fails closed and does not burn an attempt", async () => {
  const { engine, store, fake } = await harness({ engine: { maxConcurrent: 5 } });
  fake.state.dispatchStatus = 422;
  const job = await createJob(engine, { max_attempts: 2 });
  const out = await engine.tick();
  assert.equal(out.dispatched.length, 0);
  assert.equal((await store.listAttempts(job.id)).length, 0, "a definite rejection must not consume the attempt budget");
  assert.equal((await store.getJob(job.id)).state, "queued");

  fake.state.dispatchStatus = 204;
  const retry = await engine.tick();
  assert.equal(retry.dispatched.length, 1);
  assert.equal((await store.getJob(job.id)).state, "running");
});

test("with no attempt budget left, a rejected dispatch fails the job", async () => {
  const { engine, store, fake } = await harness();
  fake.state.dispatchStatus = 422;
  const job = await createJob(engine, { max_attempts: 1 });
  await engine.tick();
  assert.equal((await store.getJob(job.id)).state, "failed");
  assert.match((await store.getJob(job.id)).last_error, /dispatch rejected/);
});

test("an unknown dispatch outcome is never retried automatically", async () => {
  // A long grace period: the engine has not yet probed for a run, so nothing
  // may move on its own.
  const { engine, store, fake } = await harness({ engine: { noRunGraceSec: 86400 } });
  const job = await createJob(engine, { max_attempts: 3 });
  fake.state.dispatchStatus = 500;
  const out = await engine.tick();
  assert.equal(out.dispatched.length, 0);
  const after = await store.getJob(job.id);
  assert.equal(after.state, "unknown");
  assert.match(after.last_error, /outcome unknown/);
  assert.equal(fake.dispatchCalls().length, 1);

  // The engine must not dispatch again while the outcome is unknown.
  for (let i = 0; i < 3; i++) await engine.tick();
  assert.equal(fake.dispatchCalls().length, 1, "unknown outcomes must not be re-executed");

  // Only a human decision moves it.
  const resolved = await engine.resolveUnknown(job.id, { outcome: "retry", actor: "test" });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.job.state, "queued");
});

test("a dispatch that failed but did start a run is adopted, not repeated", async () => {
  const { engine, store, fake } = await harness();
  const job = await createJob(engine, { max_attempts: 3 });
  fake.state.createRunOnFailure = true;
  fake.state.dispatchStatus = 500;
  await engine.tick();
  assert.equal((await store.getJob(job.id)).state, "unknown");
  assert.equal(fake.runIds().length, 1);

  // noRunGraceSec is 0 in tests: the next tick looks for a run and finds one.
  fake.state.dispatchStatus = 204;
  const adopted = await engine.tick();
  assert.equal(adopted.resolvedDispatches.length, 1);
  assert.equal(adopted.resolvedDispatches[0].action, "adopted");
  const linked = await store.getJob(job.id);
  assert.equal(linked.state, "running");
  assert.equal(linked.run_id, fake.runIds()[0]);
  assert.equal(fake.dispatchCalls().length, 1, "the existing run must be adopted, never re-dispatched");

  finishRun(fake, fake.runIds()[0], { conclusion: "success" });
  await engine.tick();
  assert.equal((await store.getJob(job.id)).state, "succeeded");
});

test("a dispatch that failed and started no run is re-queued after proving no run exists", async () => {
  const { engine, store, fake } = await harness();
  const job = await createJob(engine, { max_attempts: 2 });
  fake.state.dispatchStatus = 500;
  await engine.tick();
  assert.equal((await store.getJob(job.id)).state, "unknown");

  fake.state.dispatchStatus = 204;
  const cleared = await engine.tick();
  assert.equal(cleared.resolvedDispatches.length, 1);
  assert.equal(cleared.resolvedDispatches[0].action, "requeued");
  // The proof (no run exists for the old marker) happens before the re-dispatch,
  // which is why the retry may even land in the same tick - with a new marker.
  assert.equal((await store.getJob(job.id)).state, "running");
  assert.equal(fake.dispatchCalls().length, 2);
  const [first, second] = fake.dispatchCalls();
  assert.notEqual(second.body.inputs.job_marker, first.body.inputs.job_marker);
});

test("a dispatch lease that expires without confirmation becomes unknown", async () => {
  // A long grace period keeps the run search out of this tick: the immediate
  // outcome of an unconfirmed dispatch is unknown, and nothing moves on its own.
  const { engine, store } = await harness({ engine: { noRunGraceSec: 86400 } });
  const job = await createJob(engine);
  const past = "2026-10-19T00:00:00Z";
  await store.createAttempt({
    id: "att-crashed",
    job_id: job.id,
    n: 1,
    marker: "oc24-crashed",
    token_hash: "b".repeat(64),
    state: "dispatching",
    created_at: past,
  });
  await store.updateAttempt("att-crashed", { dispatched_at: past, lease_expires_at: past });
  await store.updateJob(job.id, { state: "running" });

  const out = await engine.tick();
  assert.deepEqual(out.expired, ["att-crashed"]);
  const after = await store.getJob(job.id);
  assert.equal(after.state, "unknown");
  assert.match(after.last_error, /lease expired/);
});

test("GitHub rate limiting holds the job instead of failing or looping", async () => {
  const { engine, store, fake, clock } = await harness();
  fake.state.rateLimited = true;
  const job = await createJob(engine);
  const out = await engine.tick();
  assert.equal(out.dispatched.length, 0);
  assert.equal((await store.getJob(job.id)).state, "queued");
  assert.equal((await store.listAttempts(job.id)).length, 0);
  assert.ok(await store.getMeta("dispatch_pause_until"));

  // Still paused half a minute later: no hot loop against GitHub.
  clock.advance(30);
  await engine.tick();
  assert.equal(fake.dispatchCalls().length, 1, "the paused controller must not call GitHub again");

  fake.state.rateLimited = false;
  clock.advance(3600);
  await engine.tick();
  assert.equal(fake.dispatchCalls().length, 2, "the job is dispatched once the pause is over");
  assert.equal((await store.getJob(job.id)).state, "running");
});

test("the concurrency cap and the daily dispatch cap are enforced", async () => {
  const { engine, store } = await harness({ engine: { maxConcurrent: 1, maxDispatchPerDay: 1 } });
  await createJob(engine, { goal: "job one" });
  await createJob(engine, { goal: "job two" });

  const t1 = await engine.tick();
  assert.equal(t1.dispatched.length, 1);
  assert.equal((await store.countActiveAttempts()), 1);

  const t2 = await engine.tick();
  assert.equal(t2.dispatched.length, 0);
  const states = (await store.listJobs({})).map((j) => j.state).sort();
  assert.deepEqual(states, ["queued", "running"]);
});

test("cancelling a running job cancels the GitHub run", async () => {
  const { engine, store, fake } = await harness();
  const job = await createJob(engine);
  await engine.tick();
  const [runId] = fake.runIds();
  fake.setRunStatus(runId, "in_progress");

  const requested = await engine.requestCancel(job.id, { actor: "test" });
  assert.equal(requested.ok, true);
  const out = await engine.tick();
  assert.deepEqual(out.cancelled, [job.id]);
  assert.equal((await store.getJob(job.id)).state, "cancelled");
  assert.ok(fake.calls.some((c) => /\/cancel$/.test(c.path)));
});

test("cancelling a queued job never dispatches it", async () => {
  const { engine, store, fake } = await harness();
  const job = await createJob(engine);
  const cancelled = await engine.requestCancel(job.id, { actor: "test" });
  assert.equal(cancelled.job.state, "cancelled");
  const out = await engine.tick();
  assert.equal(out.dispatched.length, 0);
  assert.equal(fake.dispatchCalls().length, 0);
});

test("runner reports are advisory: they record metrics but never decide the state", async () => {
  const { engine, store, fake } = await harness();
  const job = await createJob(engine);
  await engine.tick();
  const [runId] = fake.runIds();
  fake.setRunStatus(runId, "in_progress");
  const attempt = (await store.listAttempts(job.id))[0];
  const token = fake.lastDispatchInputs().attempt_token;

  const bad = await engine.report(attempt.id, "not-the-token", { metrics: { status: "success" } });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "bad-token");

  const good = await engine.report(attempt.id, token, { message: "halfway", phase: "implement", metrics: { status: "running", steps: 4 } });
  assert.equal(good.ok, true);
  assert.equal(good.advisory, true);
  const stored = await store.getAttempt(attempt.id);
  assert.match(stored.metrics, /runner-report/);
  assert.equal((await store.getJob(job.id)).state, "running", "a report must not finish a job");

  // Even a report claiming success cannot end the job; the run decides.
  await engine.report(attempt.id, token, { metrics: { status: "success", costUsd: 0 } });
  assert.equal((await store.getJob(job.id)).state, "running");
  finishRun(fake, runId, { conclusion: "success" });
  await engine.tick();
  assert.equal((await store.getJob(job.id)).state, "succeeded");
  assert.equal(JSON.parse((await store.getAttempt(attempt.id)).metrics).source, "artifact-verified");
});

test("resolveUnknown refuses to retry without attempt budget", async () => {
  const { engine, store, fake } = await harness();
  const job = await createJob(engine, { max_attempts: 1 });
  fake.state.dispatchStatus = 500;
  await engine.tick();
  assert.equal((await store.getJob(job.id)).state, "unknown");
  const refused = await engine.resolveUnknown(job.id, { outcome: "retry" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "no-attempt-budget");
  const closed = await engine.resolveUnknown(job.id, { outcome: "failed", note: "operator" });
  assert.equal(closed.ok, true);
  assert.equal(closed.job.state, "failed");
});

test("the tick lock stops two overlapping ticks from double-dispatching", async () => {
  const { engine, store } = await harness();
  await createJob(engine);
  await store.setMeta("tick_lock_until", "2999-01-01T00:00:00Z");
  const out = await engine.tick();
  assert.equal(out.skipped, "tick-lock");
});

test("no credential ever reaches the event log", async () => {
  const { engine, store, fake } = await harness();
  const job = await createJob(engine);
  await engine.tick();
  const token = fake.lastDispatchInputs().attempt_token;
  const events = await store.listEvents({ job_id: job.id });
  const dump = JSON.stringify(events);
  assert.doesNotMatch(dump, new RegExp(token));
  assert.doesNotMatch(dump, /ghp_test_token_not_real/);
  const attempt = (await store.listAttempts(job.id))[0];
  assert.equal(attempt.token_hash.length, 64, "only the token hash is stored");
  assert.doesNotMatch(attempt.token_hash, new RegExp(token));
});

test("the artifact download follows the signed redirect without the token", async () => {
  const { engine, fake } = await harness();
  await createJob(engine);
  await engine.tick();
  const [runId] = fake.runIds();
  finishRun(fake, runId, { conclusion: "success" });
  await engine.tick();
  assert.equal(fake.state.authorizationOnSignedUrl, null, "the Authorization header must not travel to the signed URL");
});

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

test("the app refuses to exist without an admin token", () => {
  assert.throws(
    () => createApp({ store: {}, engine: {}, assets: {}, config: { repo: "o/r", freeModels: [] } }),
    /OC24_ADMIN_TOKEN is required/,
  );
});

test("auth: healthz is open, the API is not, and logins are rate limited", async () => {
  const { app } = await harness();
  const health = await call(app, "/healthz");
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);

  const noSession = await call(app, "/api/jobs");
  assert.equal(noSession.status, 401);

  const wrong = await call(app, "/api/session", { method: "POST", body: { token: "wrong" } });
  assert.equal(wrong.status, 401);

  const cookie = await login(app);
  const withSession = await call(app, "/api/jobs", { cookie });
  assert.equal(withSession.status, 200);
  assert.deepEqual(withSession.json.jobs, []);

  // 10 attempts per hour per IP: the successful login above counted as one.
  let limited = null;
  for (let i = 0; i < 12; i++) {
    limited = await call(app, "/api/session", { method: "POST", body: { token: "nope" } });
    if (limited.status === 429) break;
  }
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error, "rate-limited");
});

test("the dashboard is served with a strict CSP and the API rejects bad input", async () => {
  const { app, store } = await harness();
  const index = await call(app, "/");
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type"), /text\/html/);
  assert.match(index.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(index.text, /<title>/);

  const cookie = await login(app);
  const badBody = await call(app, "/api/jobs", { method: "POST", body: "{not json", cookie });
  assert.equal(badBody.status, 400);

  const paidModel = await call(app, "/api/jobs", { method: "POST", body: { goal: "do something", model: "openai/gpt-5" }, cookie });
  assert.equal(paidModel.status, 400);
  assert.equal(paidModel.json.error, "model-not-allowlisted");

  const created = await call(app, "/api/jobs", { method: "POST", body: { goal: "write a test", model: MODEL }, cookie });
  assert.equal(created.status, 201);
  const id = created.json.job.id;

  const detail = await call(app, `/api/jobs/${id}`, { cookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.job.id, id);
  assert.deepEqual(detail.json.attempts, []);
  assert.ok(detail.json.events.length >= 1);

  const missing = await call(app, "/api/jobs/job-nope", { cookie });
  assert.equal(missing.status, 404);
  const noRoute = await call(app, "/api/nope", { cookie });
  assert.equal(noRoute.status, 404);

  const stats = await call(app, "/api/stats", { cookie });
  assert.equal(stats.json.jobsByState.queued, 1);
  assert.equal(stats.json.caps.max_cost_usd, 0);
  assert.equal(await store.getCounter("job"), 1);
});

test("the HTTP surface drives dispatch, reporting, approval, cancel and resolve", async () => {
  const { app, engine, store, fake } = await harness();
  const cookie = await login(app);

  const created = await call(app, "/api/jobs", { method: "POST", body: { goal: "http driven job", model: MODEL, max_attempts: 2 }, cookie });
  assert.equal(created.status, 201);
  const id = created.json.job.id;

  const tick = await call(app, "/api/tick", { method: "POST", body: {}, cookie });
  assert.equal(tick.status, 200);
  assert.equal(tick.json.dispatched.length, 1);
  const attempt = (await store.listAttempts(id))[0];
  const token = fake.lastDispatchInputs().attempt_token;

  const report = await call(app, `/api/attempts/${attempt.id}/report`, { method: "POST", body: { token, phase: "plan", message: "started" } });
  assert.equal(report.status, 200);
  const badReport = await call(app, `/api/attempts/${attempt.id}/report`, { method: "POST", body: { token: "nope" } });
  assert.equal(badReport.status, 401);

  // finish it through the API
  const [runId] = fake.runIds();
  finishRun(fake, runId, { conclusion: "success" });
  await call(app, "/api/tick", { method: "POST", body: {}, cookie });
  const done = await call(app, `/api/jobs/${id}`, { cookie });
  assert.equal(done.json.job.state, "succeeded");

  // cancel is refused on a finished job
  const cancelDone = await call(app, `/api/jobs/${id}/cancel`, { method: "POST", body: {}, cookie });
  assert.equal(cancelDone.status, 409);

  // unknown job + human resolution over HTTP
  fake.state.dispatchStatus = 500;
  const risky = await call(app, "/api/jobs", { method: "POST", body: { goal: "another", model: MODEL, max_attempts: 2 }, cookie });
  await call(app, "/api/tick", { method: "POST", body: {}, cookie });
  const unknown = await call(app, `/api/jobs/${risky.json.job.id}`, { cookie });
  assert.equal(unknown.json.job.state, "unknown");
  const retried = await call(app, `/api/jobs/${risky.json.job.id}/resolve`, { method: "POST", body: { outcome: "retry" }, cookie });
  assert.equal(retried.status, 200);
  assert.equal(retried.json.job.state, "queued");

  // approval flow
  const external = await call(app, "/api/jobs", { method: "POST", body: { goal: "deploy something", model: MODEL, allow_external: true }, cookie });
  assert.equal(external.json.job.state, "awaiting_approval");
  const approved = await call(app, `/api/jobs/${external.json.job.id}/approve`, { method: "POST", body: {}, cookie });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.job.state, "queued");
  assert.ok(engine);
});

test("an unhandled handler error is logged redacted and answered as 500", async () => {
  const { app, store } = await harness();
  const cookie = await login(app);
  // Break the engine behind the app's back: this is what a bug would look like.
  const original = store.listJobs;
  store.listJobs = async () => {
    throw new Error("boom sk-abcdefghijklmnopqrstuvwxyz");
  };
  const res = await call(app, "/api/jobs", { cookie });
  assert.equal(res.status, 500);
  assert.equal(res.json.error, "internal-error");
  assert.doesNotMatch(res.text, /sk-abcdefghijklmnop/);
  store.listJobs = original;
  const events = await store.listEvents({ limit: 50 });
  const errorEvent = events.find((e) => e.kind === "unhandled-error");
  assert.ok(errorEvent);
  assert.doesNotMatch(errorEvent.message, /sk-abcdefghijklmnop/);
});
