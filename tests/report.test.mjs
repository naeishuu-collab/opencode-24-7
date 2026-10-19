// The runner -> controller advisory report path, end to end: a real runner
// process reports to a real controller HTTP server. Also proves that a broken
// report target never fails the job.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../controller/server.mjs";
import { startFakeGithub } from "./stubs/fake-github.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RUNNER = path.join(ROOT, "runner", "run-job.mjs");
const STUB = path.join(HERE, "stubs", "fake-opencode.mjs");
const MODEL = "opencode/deepseek-v4.1-flash-free";
const ADMIN = "oc24_report_admin_token_1234";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oc24-report-tests-"));
process.on("exit", () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function git(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(TMP, "repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "tests@example.com"]);
  git(dir, ["config", "user.name", "oc24 tests"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  fs.writeFileSync(path.join(dir, "fixture.mjs"), "export const value = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

async function startController() {
  const fake = await startFakeGithub();
  const dbPath = path.join(fs.mkdtempSync(path.join(TMP, "db-")), "controller.db");
  const config = {
    adminToken: ADMIN,
    githubToken: "ghp_report_test_not_real",
    githubApiBase: fake.url,
    repo: "owner/repo",
    ref: "main",
    workflow: "agent-job.yml",
    controllerUrl: null,
    dbPath,
    host: "127.0.0.1",
    port: 0,
    tickEnabled: false,
    tickSeconds: 60,
    maxJobsPerDay: 50,
    maxDispatchPerDay: 20,
    maxConcurrent: 2,
    maxCostUsd: 0,
    leaseSec: 900,
    noRunGraceSec: 3600,
    freeModels: [MODEL],
  };
  const started = await startServer(config);
  const api = {
    async session() {
      const res = await fetch(`${started.url}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: ADMIN }),
      });
      assert.equal(res.status, 200);
      return res.headers.getSetCookie().find((c) => c.startsWith("oc24_session=")).split(";")[0];
    },
  };
  return { fake, ...started, api };
}

function runRunner(dir, extraArgs = [], env = {}) {
  const runBase = fs.mkdtempSync(path.join(TMP, "runs-"));
  const args = [RUNNER, "--workspace", dir, "--model", MODEL, "--opencode-bin", STUB, "--run-base", runBase, "--prompt", "stub task", ...extraArgs];
  // spawn (not spawnSync): a test that hosts the controller in-process must keep
  // its event loop free, otherwise the runner's report cannot be answered.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`runner did not exit; stdout=${stdout} stderr=${stderr}`));
    }, 120_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith("RESULT "));
      resolve({ code, stdout, stderr, result: line ? JSON.parse(line.slice(7)) : null });
    });
  });
}

test("the runner reports heartbeats and its final result to the controller", async () => {
  const controller = await startController();
  try {
    // A dispatched job, so a real attempt row with a real token exists.
    const created = await controller.engine.createJob({ goal: "report from the runner", model: MODEL, verify_cmd: "node --test" });
    assert.equal(created.ok, true);
    const tick = await controller.engine.tick();
    assert.equal(tick.dispatched.length, 1);
    const attempt = (await controller.store.listAttempts(created.job.id))[0];
    const token = controller.fake.lastDispatchInputs().attempt_token;

    const dir = makeRepo();
    const run = await runRunner(dir, ["--report-url", controller.url, "--attempt-id", attempt.id, "--report-token", token], { OC24_STUB_MODE: "ok" });
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.equal(run.result.status, "success");

    const stored = await controller.store.getAttempt(attempt.id);
    assert.ok(stored.heartbeat_at, "the heartbeat must be recorded");
    const metrics = JSON.parse(stored.metrics);
    assert.equal(metrics.source, "runner-report");
    assert.equal(metrics.status, "success");
    assert.equal(metrics.model, MODEL);
    const events = await controller.store.listEvents({ job_id: created.job.id });
    assert.ok(events.some((e) => e.kind === "attempt-report" && e.message.includes("runner started")));
    assert.ok(events.some((e) => e.kind === "attempt-report" && e.message.includes("runner finished with success")));

    // Advisory: the job is still running until the run itself is checked.
    assert.equal((await controller.store.getJob(created.job.id)).state, "running");

    // The attempt token never lands in the run artifacts.
    const jobJson = fs.readFileSync(path.join(run.result.jobDir, "job.json"), "utf8");
    assert.doesNotMatch(jobJson, new RegExp(token));
    assert.doesNotMatch(jobJson, new RegExp(ADMIN));
    const runnerLog = fs.readFileSync(path.join(run.result.jobDir, "logs", "runner.log"), "utf8");
    assert.doesNotMatch(runnerLog, new RegExp(token));
  } finally {
    await controller.close();
    await controller.fake.close();
  }
});

test("a dead report target never fails the job and never leaks the token", async () => {
  const dir = makeRepo();
  const token = `oc24_${"ab".repeat(24)}`;
  const run = await runRunner(
    dir,
    ["--report-url", "http://127.0.0.1:1/controller", "--attempt-id", "att-none", "--report-token", token],
    { OC24_STUB_MODE: "ok" },
  );
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.equal(run.result.status, "success");
  const runnerLog = fs.readFileSync(path.join(run.result.jobDir, "logs", "runner.log"), "utf8");
  assert.match(runnerLog, /report failed/);
  assert.doesNotMatch(runnerLog, new RegExp(token));
});
