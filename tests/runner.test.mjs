// Deterministic runner tests: every opencode invocation goes through tests/stubs/fake-opencode.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RUNNER = path.join(ROOT, "runner", "run-job.mjs");
const SCANNER = path.join(ROOT, "tools", "scan-run-dir.mjs");
const STUB = path.join(HERE, "stubs", "fake-opencode.mjs");
const FREE_MODEL = "opencode/deepseek-v4.1-flash-free";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oc24-tests-"));
process.on("exit", () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* temp dir cleanup is best effort */
  }
});

let seq = 0;

function gitSpawn(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, `repo-${++seq}-`));
  gitSpawn(dir, ["init", "-q", "-b", "main"]);
  gitSpawn(dir, ["config", "user.email", "tests@example.com"]);
  gitSpawn(dir, ["config", "user.name", "oc24 tests"]);
  gitSpawn(dir, ["config", "core.autocrlf", "false"]);
  const all = { "README.md": "# fixture\n", ...files };
  for (const [rel, content] of Object.entries(all)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
  gitSpawn(dir, ["add", "-A"]);
  gitSpawn(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function runRunner(dir, extraArgs = [], env = {}) {
  const runBase = fs.mkdtempSync(path.join(TMP, "runs-"));
  const args = [RUNNER, "--workspace", dir, "--model", FREE_MODEL, "--opencode-bin", STUB, "--run-base", runBase, ...extraArgs];
  const r = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
  const line = (r.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("RESULT "));
  const result = line ? JSON.parse(line.slice("RESULT ".length)) : null;
  const job = result ? JSON.parse(fs.readFileSync(path.join(result.jobDir, "job.json"), "utf8")) : null;
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", result, job };
}

function readRun(jobDir, rel) {
  return fs.readFileSync(path.join(jobDir, rel), "utf8");
}

const PROMPT = ["--prompt", "stub task"];

test("ok: success with job artifacts, diff and restored workspace", () => {
  const dir = makeRepo();
  const { code, result, job } = runRunner(dir, PROMPT, { OC24_STUB_MODE: "ok" });
  assert.equal(code, 0);
  assert.equal(result.status, "success");
  assert.equal(result.attempts, 1);
  assert.equal(job.exitCode, 0);
  assert.equal(job.session.id, "ses_stub00000000000000000000");
  assert.equal(job.usage.steps, 1);
  assert.equal(job.usage.tokens.total, 120);
  assert.equal(job.usage.costReported, true);
  assert.equal(job.tools.calls, 1);
  assert.equal(job.target.dirtyAfter, true);
  assert.deepEqual(job.target.changedPaths, ["README.md", "stub-touched.txt"]);
  assert.match(readRun(result.jobDir, "diff.patch"), /stub-touched\.txt/);
  assert.match(readRun(result.jobDir, "diff.patch"), /\+ok/);
  assert.match(readRun(result.jobDir, "diff.patch"), /\+\+\+ b\/README\.md/);
  assert.match(readRun(result.jobDir, "logs/opencode.jsonl"), /"step_finish"/);
  assert.match(readRun(result.jobDir, "summary.md"), /status: \*\*success\*\*/);
  assert.ok(fs.existsSync(path.join(result.jobDir, "logs", "runner.log")));
  // installed config and its directory are gone again
  assert.ok(!fs.existsSync(path.join(dir, ".opencode")));
  // the temporary config is registered in .git/info/exclude, not in the diff
  assert.match(fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8"), /\.opencode\/opencode\.json/);
  assert.ok(!readRun(result.jobDir, "diff.patch").includes(".opencode/opencode.json"));
});

test("env: the agent sees PWD of the workspace, not the caller's", () => {
  const dir = makeRepo();
  const elsewhere = path.join(TMP, "caller-pwd");
  const { code, job } = runRunner(dir, PROMPT, { OC24_STUB_MODE: "ok", PWD: elsewhere });
  assert.equal(code, 0);
  // opencode resolves its project root from PWD on POSIX: a forwarded PWD makes
  // the agent operate on the caller's directory (seen in the WSL verification).
  assert.ok(job.finalText.includes(dir), `finalText should contain the workspace, got: ${job.finalText}`);
  assert.ok(!job.finalText.includes(elsewhere), `finalText must not contain the caller PWD, got: ${job.finalText}`);
});

test("workspace: path case and forward slashes are normalized on windows", { skip: process.platform !== "win32" }, () => {
  const dir = makeRepo();
  const odd = dir.replace(/\\/g, "/").toUpperCase();
  // CI runs found this: `git rev-parse --show-toplevel` answers with forward
  // slashes, so a raw string compare rejected every job (exit 13) on the runner.
  const { code, result } = runRunner(odd, PROMPT, { OC24_STUB_MODE: "ok" });
  assert.equal(code, 0);
  assert.equal(result.status, "success");
});

test("silent: exit 0 with no events is unknown, never success", () => {
  const dir = makeRepo();
  const { code, result, job } = runRunner(dir, PROMPT, { OC24_STUB_MODE: "silent" });
  assert.equal(code, 20);
  assert.equal(result.status, "unknown");
  assert.match(job.reason, /no events/);
});

test("fail: provider error maps to agent-failed and is not retried by default", () => {
  const dir = makeRepo();
  const { code, result, job } = runRunner(dir, PROMPT, { OC24_STUB_MODE: "fail" });
  assert.equal(code, 10);
  assert.equal(result.status, "agent-failed");
  assert.equal(result.attempts, 1);
  assert.equal(job.attemptsDetail.length, 1);
  assert.equal(job.errors[0].type, "provider.no-route");
});

test("transient provider error still fails without --max-attempts 2", () => {
  const dir = makeRepo();
  const { code, result } = runRunner(dir, PROMPT, { OC24_STUB_MODE: "transient" });
  assert.equal(code, 10);
  assert.equal(result.attempts, 1);
});

test("transient error is retried (and retry is recorded) when allowed", () => {
  const dir = makeRepo();
  const { code, result, job } = runRunner(dir, [...PROMPT, "--max-attempts", "2"], { OC24_STUB_MODE: "transient" });
  assert.equal(code, 10);
  assert.equal(result.attempts, 2);
  assert.equal(job.attemptsDetail.length, 2);
});

test("flaky: second attempt succeeds after transient failure", () => {
  const dir = makeRepo();
  const state = path.join(TMP, `flaky-${++seq}.json`);
  const { code, result } = runRunner(dir, [...PROMPT, "--max-attempts", "2"], {
    OC24_STUB_MODE: "flaky",
    OC24_STUB_STATE: state,
  });
  assert.equal(code, 0);
  assert.equal(result.status, "success");
  assert.equal(result.attempts, 2);
});

test("dirty workspace: refuses to start", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "stray.txt"), "uncommitted\n");
  const { code, result, job } = runRunner(dir, PROMPT, { OC24_STUB_MODE: "ok" });
  assert.equal(code, 13);
  assert.equal(result.status, "invalid");
  assert.equal(job.attempts, 0);
  assert.match(job.reason, /uncommitted changes/);
  assert.ok(!fs.existsSync(path.join(dir, ".opencode")));
});

test("hang: wall-clock timeout kills the agent", () => {
  const dir = makeRepo();
  const { code, result, job } = runRunner(dir, [...PROMPT, "--timeout-sec", "1"], { OC24_STUB_MODE: "hang" });
  assert.equal(code, 11);
  assert.equal(result.status, "timeout");
  assert.equal(job.attemptsDetail[0].killReason, "timeout");
  assert.match(job.reason, /wall-clock limit of 1s/);
});

test("tokens: token budget kills the agent", () => {
  const dir = makeRepo();
  const { code, result, job } = runRunner(
    dir,
    [...PROMPT, "--max-tokens", "1500000", "--timeout-sec", "30"],
    { OC24_STUB_MODE: "tokens" },
  );
  assert.equal(code, 12);
  assert.equal(result.status, "budget-exceeded");
  assert.equal(job.attemptsDetail[0].killReason, "max-tokens");
  assert.match(job.reason, /token budget/);
});

test("cost: any reported cost above --max-cost-usd 0 kills the agent", () => {
  const dir = makeRepo();
  const { code, result, job } = runRunner(dir, [...PROMPT, "--timeout-sec", "30"], { OC24_STUB_MODE: "cost" });
  assert.equal(code, 12);
  assert.equal(result.status, "budget-exceeded");
  assert.equal(job.attemptsDetail[0].killReason, "max-cost");
  assert.match(job.reason, /cost guard/);
});

test("redaction: env secret never reaches job.json, summary or logs", () => {
  const dir = makeRepo();
  const secret = "supersecretvalue123";
  const { code, result, job } = runRunner(dir, PROMPT, { OC24_STUB_MODE: "leaky", OC24_TEST_SECRET: secret });
  assert.equal(code, 0);
  assert.ok(result.redactions > 0, "expected at least one redaction");
  const texts = {
    job: readRun(result.jobDir, "job.json"),
    summary: readRun(result.jobDir, "summary.md"),
    opencodeLog: readRun(result.jobDir, "logs/opencode.jsonl"),
    runnerLog: readRun(result.jobDir, "logs/runner.log"),
  };
  for (const [name, text] of Object.entries(texts)) {
    assert.ok(!text.includes(secret), `${name} leaked the secret`);
  }
  for (const name of ["job", "summary", "opencodeLog"]) {
    assert.match(texts[name], /\[REDACTED\]/, `${name} has no redaction marker`);
  }
  assert.match(job.finalText, /\[REDACTED\]/);
});

test("redaction: a secret the agent writes into a file is redacted out of the diff", () => {
  const dir = makeRepo();
  const secret = "supersecretvalue456";
  const { code, result } = runRunner(dir, PROMPT, { OC24_STUB_MODE: "leaky-file", OC24_TEST_SECRET: secret });
  assert.equal(code, 0);
  const patch = readRun(result.jobDir, "diff.patch");
  assert.ok(!patch.includes(secret), "diff.patch leaked the secret");
  assert.match(patch, /\[REDACTED\]/);
});

test("redaction: no file in the run directory contains the secret (artifact scan)", () => {
  const dir = makeRepo();
  const secret = "supersecretvalue789";
  const { code, result } = runRunner(dir, PROMPT, { OC24_STUB_MODE: "leaky", OC24_TEST_SECRET: secret });
  assert.equal(code, 0);
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.readFileSync(p).includes(secret)) offenders.push(path.relative(result.jobDir, p));
    }
  };
  walk(result.jobDir);
  assert.deepEqual(offenders, []);
});

test("scanner: clean run directory passes, leaked file fails", () => {
  const dir = makeRepo();
  const secret = "supersecretvalue321";
  const { result } = runRunner(dir, PROMPT, { OC24_STUB_MODE: "ok", OC24_TEST_SECRET: secret });

  const clean = spawnSync(process.execPath, [SCANNER, result.jobDir], {
    encoding: "utf8",
    env: { ...process.env, OC24_TEST_SECRET: secret },
  });
  assert.equal(clean.status, 0, clean.stderr);

  const dirty = path.join(TMP, `dirty-${++seq}`);
  fs.mkdirSync(dirty, { recursive: true });
  fs.writeFileSync(path.join(dirty, "leak.txt"), `token=${secret}\n`);
  const found = spawnSync(process.execPath, [SCANNER, dirty], {
    encoding: "utf8",
    env: { ...process.env, OC24_TEST_SECRET: secret },
  });
  assert.equal(found.status, 1);
  assert.match(found.stderr, /leak\.txt/);
  assert.ok(!found.stderr.includes(secret), "scanner must not print the secret");

  const missing = spawnSync(process.execPath, [SCANNER, path.join(TMP, "no-such-dir")], { encoding: "utf8" });
  assert.equal(missing.status, 0);
});

test("model allowlist: unlisted model is refused before the agent starts", () => {
  const dir = makeRepo();
  const { code, result, job } = runRunner(dir, ["--prompt", "x", "--model", "some/paid-model"], { OC24_STUB_MODE: "ok" });
  assert.equal(code, 13);
  assert.equal(result.status, "invalid");
  assert.match(job.reason, /not in the verified-free allowlist/);
  assert.equal(job.attempts, 0);
  assert.ok(!fs.existsSync(path.join(dir, ".opencode")), "agent must not have been started");
});

test("model allowlist: unlisted model needs a cost report, allowlisted model does not", () => {
  const dir = makeRepo();
  const unlisted = runRunner(dir, ["--prompt", "x", "--model", "some/other-model", "--allow-unlisted-model"], {
    OC24_STUB_MODE: "nocost",
  });
  assert.equal(unlisted.code, 20);
  assert.equal(unlisted.result.status, "unknown");
  assert.match(unlisted.job.reason, /never reported cost/);
  assert.equal(unlisted.job.costPolicy.requireCostReport, true);
  assert.equal(unlisted.job.costPolicy.costReported, false);

  const listed = runRunner(dir, [...PROMPT, "--require-cost-report"], { OC24_STUB_MODE: "nocost" });
  assert.equal(listed.code, 20);
  assert.equal(listed.job.costPolicy.requireCostReport, true);

  const listedDefault = runRunner(dir, PROMPT, { OC24_STUB_MODE: "nocost" });
  assert.equal(listedDefault.code, 0);
  assert.equal(listedDefault.job.costPolicy.requireCostReport, false);
  assert.match(listedDefault.job.notes.join("\n"), /did not report cost/);
});

test("verify: passing command keeps success, failing command is verify-failed", () => {
  const dir = makeRepo();
  const pass = runRunner(dir, [...PROMPT, "--verify-cmd", 'node -e "process.exit(0)"'], { OC24_STUB_MODE: "ok" });
  assert.equal(pass.code, 0);
  assert.equal(pass.job.verification.status, "passed");

  const dir2 = makeRepo();
  const fail = runRunner(dir2, [...PROMPT, "--verify-cmd", 'node -e "process.exit(7)"'], { OC24_STUB_MODE: "ok" });
  assert.equal(fail.code, 15);
  assert.equal(fail.result.status, "verify-failed");
  assert.equal(fail.job.verification.exitCode, 7);
  assert.ok(fs.existsSync(path.join(fail.result.jobDir, "logs", "verify.log")));
});

test("verify: timeout is a verification failure", () => {
  const dir = makeRepo();
  const { code, job } = runRunner(
    dir,
    [...PROMPT, "--verify-cmd", 'node -e "setTimeout(()=>{},60000)"', "--verify-timeout-sec", "1"],
    { OC24_STUB_MODE: "ok" },
  );
  assert.equal(code, 15);
  assert.equal(job.verification.timedOut, true);
});

test("verify: node test markers of the caller are not inherited", () => {
  const dir = makeRepo();
  // Seen in the first cloud run: the verify command inherited NODE_TEST_CONTEXT
  // from the test process, so `node --test` inside it skipped every file and
  // still exited 0. The agent spawn shares this env helper.
  const probe = 'node -e "process.exit(process.env.NODE_TEST_CONTEXT || process.env.NODE_TEST_WORKER_ID ? 3 : 0)"';
  const { code, job } = runRunner(dir, [...PROMPT, "--verify-cmd", probe], {
    OC24_STUB_MODE: "ok",
    NODE_TEST_CONTEXT: "child-v8",
    NODE_TEST_WORKER_ID: "1",
  });
  assert.equal(code, 0);
  assert.equal(job.verification.status, "passed");
});

test("config: repo policies survive, runner policies are appended last, file is restored", () => {
  const repoConfig = { $schema: "https://opencode.ai/config.json", policies: [{ action: "tool.use", resource: "shell:repo-custom *", effect: "deny" }] };
  const dir = makeRepo({ ".opencode/opencode.json": JSON.stringify(repoConfig, null, 2) + "\n" });
  const before = fs.readFileSync(path.join(dir, ".opencode", "opencode.json"), "utf8");
  const state = path.join(TMP, `cfg-${++seq}.json`);
  const { code } = runRunner(dir, PROMPT, {
    OC24_STUB_MODE: "ok",
    OC24_STUB_CHECK_CONFIG: "1",
    OC24_STUB_STATE: state,
  });
  assert.equal(code, 0);
  const seen = JSON.parse(fs.readFileSync(state, "utf8"));
  assert.equal(seen.file, true);
  assert.equal(seen.hasRepoPolicy, true);
  assert.equal(seen.hasOurPolicy, true);
  assert.equal(fs.readFileSync(path.join(dir, ".opencode", "opencode.json"), "utf8"), before);
});

test("config: non-JSON config is rejected without touching it", () => {
  const original = "// comment\n{\n  \"policies\": []\n}\n";
  const dir = makeRepo({ ".opencode/opencode.jsonc": original });
  const { code, job } = runRunner(dir, PROMPT, { OC24_STUB_MODE: "ok" });
  assert.equal(code, 13);
  assert.match(job.reason, /not plain JSON/);
  assert.equal(fs.readFileSync(path.join(dir, ".opencode", "opencode.jsonc"), "utf8"), original);
});

test("config: json + jsonc together is rejected", () => {
  const dir = makeRepo({ ".opencode/opencode.json": "{}\n", ".opencode/opencode.jsonc": "{}\n" });
  const { code, job } = runRunner(dir, PROMPT, { OC24_STUB_MODE: "ok" });
  assert.equal(code, 13);
  assert.match(job.reason, /both/);
});

test("version: older opencode is refused unless the check is skipped", () => {
  const dir = makeRepo();
  const old = runRunner(dir, PROMPT, { OC24_STUB_MODE: "ok", OC24_STUB_VERSION: "2.0.26" });
  assert.equal(old.code, 14);
  assert.equal(old.result.status, "infra-error");
  assert.match(old.job.reason, /older than required 2\.0\.32/);

  const forced = runRunner(dir, [...PROMPT, "--skip-version-check"], { OC24_STUB_MODE: "ok", OC24_STUB_VERSION: "2.0.26" });
  assert.equal(forced.code, 0);
});

test("infra: missing opencode binary is infra-error, not agent-failed", () => {
  const dir = makeRepo();
  const missing = spawnSync(
    process.execPath,
    [RUNNER, "--workspace", dir, "--model", FREE_MODEL, "--opencode-bin", path.join(TMP, "does-not-exist"), ...PROMPT, "--run-base", path.join(TMP, "runs-missing")],
    { encoding: "utf8" },
  );
  assert.equal(missing.status, 14);
});

test("invalid arguments exit 13", () => {
  const dir = makeRepo();
  const base = [RUNNER, "--workspace", dir, "--opencode-bin", STUB, "--run-base", path.join(TMP, `runs-inv-${++seq}`)];
  for (const args of [
    [...base, "--model", FREE_MODEL, "--prompt", "x", "--nope"],
    [...base, "--model", FREE_MODEL, "--prompt", "x", "--max-tokens", "abc"],
    [...base, "--model", FREE_MODEL],
    [...base, "--prompt", "x"],
  ]) {
    const r = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(r.status, 13, `expected 13 for: ${args.join(" ")}`);
  }
});

test("cancel: SIGINT stops a hanging agent", { skip: process.platform === "win32" }, async () => {
  const dir = makeRepo();
  const runBase = fs.mkdtempSync(path.join(TMP, "runs-cancel-"));
  const child = spawn(
    process.execPath,
    [RUNNER, "--workspace", dir, "--model", FREE_MODEL, "--opencode-bin", STUB, "--run-base", runBase, ...PROMPT, "--timeout-sec", "120"],
    { env: { ...process.env, OC24_STUB_MODE: "hang" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise((resolve) => {
    child.stderr.on("data", (d) => {
      if (d.toString().includes("attempt 1/1")) setTimeout(() => child.kill("SIGINT"), 300);
    });
    child.on("exit", resolve);
  });
  assert.equal(child.exitCode, 21);
});
