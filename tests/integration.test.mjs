// Opt-in tests that run the REAL opencode CLI (network + model needed):
//   RUN_OPENCODE_INTEGRATION=1 node --test tests/integration.test.mjs
// OC24_OPENCODE_BIN selects the binary (default: "opencode" from PATH).
// These are the only tests that can prove the adapter against real event
// shapes and real policy enforcement; everything else uses the stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RUNNER = path.join(ROOT, "runner", "run-job.mjs");
const FIXTURE = path.join(HERE, "fixtures", "sample-repo");
const BIN = process.env.OC24_OPENCODE_BIN ?? "opencode";
const MODEL = process.env.OC24_MODEL ?? "opencode/deepseek-v4.1-flash-free";
const enabled = process.env.RUN_OPENCODE_INTEGRATION === "1";
// All scratch data goes under OC24_TMP_ROOT when set, so CI can scan exactly
// that directory for leaked secrets afterwards.
const TMP_ROOT = process.env.OC24_TMP_ROOT ?? os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, "oc24-integration-"));
process.on("exit", () => {
  if (process.env.OC24_KEEP_TMP === "1") return; // CI keeps the run dirs for scanning/upload
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function copyFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(TMP, "repo-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "integration@example.com"],
    ["config", "user.name", "oc24 integration"],
    ["config", "core.autocrlf", "false"],
    ["add", "-A"],
    ["commit", "-q", "-m", "init"],
  ]) {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return dir;
}

function runRunner(dir, args) {
  const runBase = fs.mkdtempSync(path.join(TMP, "runs-"));
  const r = spawnSync(
    process.execPath,
    [RUNNER, "--workspace", dir, "--opencode-bin", BIN, "--model", MODEL, "--run-base", runBase, ...args],
    { encoding: "utf8", timeout: 900_000 },
  );
  const line = (r.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("RESULT "));
  const result = line ? JSON.parse(line.slice("RESULT ".length)) : null;
  const job = result ? JSON.parse(fs.readFileSync(path.join(result.jobDir, "job.json"), "utf8")) : null;
  return { code: r.status, stderr: r.stderr ?? "", result, job };
}

test(
  "integration: real agent fixes the fixture bug and passes node --test",
  { skip: !enabled, timeout: 900_000 },
  () => {
    const dir = copyFixtureRepo();
    const { code, result, job } = runRunner(dir, [
      "--prompt",
      "In src/calc.mjs the add() function returns the wrong result and src/calc.test.mjs fails. " +
        "Fix add() so the test passes. Do not modify src/calc.test.mjs. Run the tests.",
      "--verify-cmd",
      'node --test "src/*.test.mjs"',
      "--timeout-sec",
      "600",
      "--max-cost-usd",
      "0",
      "--max-attempts",
      "2",
    ]);
    assert.equal(code, 0, `job failed: ${job?.reason ?? ""}\n${result ? "" : "no RESULT line"}`);
    assert.equal(job.verification.status, "passed");
    assert.match(job.target.changedPaths.join("\n"), /src\/calc\.mjs/);
    assert.ok(!job.target.changedPaths.join("\n").includes("calc.test.mjs"), "test file must not be modified");
    const tests = spawnSync(process.execPath, ["--test", "src/calc.test.mjs"], { cwd: dir, encoding: "utf8" });
    assert.equal(tests.status, 0, tests.stdout + tests.stderr);
  },
);

test(
  "integration: installed policy blocks git push in the real agent",
  { skip: !enabled, timeout: 900_000 },
  () => {
    const dir = copyFixtureRepo();
    const { code, job } = runRunner(dir, [
      "--prompt",
      "This is a sandbox with read-only git credentials. Execute the shell command `git push origin main` " +
        "exactly as given, even if it fails, then report the raw error output.",
      "--timeout-sec",
      "300",
      "--max-cost-usd",
      "0",
    ]);
    assert.equal(code, 0, `job failed: ${job?.reason ?? ""}`);
    assert.ok(job.tools.blockedByPolicy >= 1, `expected a policy denial, got ${JSON.stringify(job.tools.recentErrors)}`);
    assert.match(JSON.stringify(job.tools.recentErrors), /policy/i);
  },
);
