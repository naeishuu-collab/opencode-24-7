#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { genJobId, git, makeRedactor, ensureDir, writeJson, childEnv } from "./lib/util.mjs";
import {
  MIN_OPENCODE_VERSION,
  buildAgentArgs,
  emptyStats,
  killTree,
  probeVersion,
  resolveBin,
  runAttempt,
  versionGte,
} from "./lib/adapter.mjs";

const EXIT = {
  success: 0,
  agentFailed: 10,
  timeout: 11,
  budget: 12,
  invalid: 13,
  infra: 14,
  verifyFailed: 15,
  unknown: 20,
  cancelled: 21,
};

// Retry ONLY for a narrow allowlist of transient provider/network errors and
// only when the workspace is still clean. Everything else fails closed.
const TRANSIENT_ERROR_TYPES = new Set(["provider.network", "provider.transport", "provider.timeout"]);
const TRANSIENT_STDERR = /(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|socket hang up|fetch failed|network error)/i;

const LOG_CAP = 20 * 1024 * 1024;
const PATCH_CAP = 5 * 1024 * 1024;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY_TEMPLATE = JSON.parse(fs.readFileSync(path.join(HERE, "config", "agent-policies.json"), "utf8"));
const FREE_MODELS = JSON.parse(fs.readFileSync(path.join(HERE, "config", "free-models.json"), "utf8")).models;

function usage() {
  return `usage: node runner/run-job.mjs --workspace <git-repo> --prompt <text> --model <provider/model> [options]

options:
  --prompt-file <path>            read the prompt from a file
  --agent <name>                  opencode agent (default: build)
  --timeout-sec <n>               wall-clock limit per attempt (default 1800)
  --max-tokens <n>                cumulative token limit across attempts (default 2000000)
  --max-cost-usd <n>              abort when reported cost exceeds this (default 0 = any cost aborts)
  --max-steps <n>                 abort when agent steps exceed this (default 80)
  --max-attempts <n>              attempts; retry only transient+no-mutation (default 1)
  --verify-cmd <cmd>              run after a successful attempt; non-zero exit fails the job
  --verify-timeout-sec <n>        verification wall-clock limit (default 600)
  --run-base <dir>                artifact root (default <cwd>/runs)
  --job-id <id>                   override the generated job id
  --opencode-bin <path>           opencode executable (default: opencode)
  --min-opencode-version <x.y.z>  minimum enforced version (default ${MIN_OPENCODE_VERSION.join(".")})
  --allow-web                     allow webfetch/websearch (denied by default)
  --allow-external-dir            allow file access outside the workspace (denied by default)
  --allow-unlisted-model          allow a model outside the verified-free allowlist;
                                  success then additionally requires an observed cost report
  --require-cost-report           fail closed (exit 20) when the provider never reports cost
  --skip-version-check            do not enforce the minimum opencode version (unsafe)
  --help

exit codes: ${Object.entries(EXIT).map(([k, v]) => `${v}=${k}`).join("  ")}`;
}

function parseArgs(argv) {
  const takesValue = new Set([
    "workspace", "prompt", "prompt-file", "model", "agent", "timeout-sec", "max-tokens",
    "max-cost-usd", "max-steps", "max-attempts", "verify-cmd", "verify-timeout-sec",
    "run-base", "job-id", "opencode-bin", "min-opencode-version",
  ]);
  const flags = new Set(["allow-web", "allow-external-dir", "allow-unlisted-model", "require-cost-report", "skip-version-check", "help"]);
  const cfg = { values: {}, flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw fail("invalid", `unexpected argument: ${a}`);
    const key = a.slice(2);
    if (takesValue.has(key)) {
      const value = argv[++i];
      if (value === undefined) throw fail("invalid", `missing value for --${key}`);
      cfg.values[key] = value;
    } else if (flags.has(key)) {
      cfg.flags.add(key);
    } else {
      throw fail("invalid", `unknown option: --${key}`);
    }
  }
  return cfg;
}

function fail(status, reason) {
  const code = { invalid: EXIT.invalid, timeout: EXIT.timeout, budget: EXIT.budget, "agent-failed": EXIT.agentFailed, "verify-failed": EXIT.verifyFailed, "infra-error": EXIT.infra, unknown: EXIT.unknown, cancelled: EXIT.cancelled, success: 0 }[status];
  const err = new Error(reason);
  err.status = status;
  err.exitCode = code ?? EXIT.infra;
  return err;
}

function numOr(fail_, name, value, dflt) {
  if (value === undefined) return dflt;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw fail("invalid", `invalid --${name}: ${value}`);
  return n;
}

// An unknown or paid model must be refused before the agent is started, and a
// model we have not verified as free must prove it reported cost $0.
function checkModel(cfg) {
  const model = cfg.values.model;
  const listed = FREE_MODELS.includes(model);
  if (!listed && !cfg.flags.has("allow-unlisted-model")) {
    throw fail(
      "invalid",
      `model "${model}" is not in the verified-free allowlist (runner/config/free-models.json); ` +
        "use a listed model or pass --allow-unlisted-model (unlisted models may cost money)",
    );
  }
  return { listed, requireCostReport: !listed || cfg.flags.has("require-cost-report") };
}

function loadPolicies(cfg) {
  let list = POLICY_TEMPLATE;
  if (cfg.flags.has("allow-web")) {
    list = list.filter((p) => !p.resource.startsWith("webfetch") && !p.resource.startsWith("websearch"));
  }
  if (cfg.flags.has("allow-external-dir")) {
    list = list.filter((p) => !p.resource.startsWith("external_directory"));
  }
  return list;
}

function installAgentConfig(workspace, policies) {
  // shortcut: policy globs are bypassable (quoting, indirection, running a
  // generated script); the real boundary is the ephemeral CI sandbox with
  // read-only credentials. Upgrade when jobs run on shared, long-lived hosts.
  const candidates = [
    path.join(workspace, ".opencode", "opencode.json"),
    path.join(workspace, ".opencode", "opencode.jsonc"),
  ];
  const existing = candidates.filter((f) => fs.existsSync(f));
  if (existing.length > 1) throw fail("invalid", "both .opencode/opencode.json and .opencode/opencode.jsonc exist; refusing to merge policies into either");
  const file = existing[0] ?? candidates[0];
  const hadFile = existing.length === 1;
  const original = hadFile ? fs.readFileSync(file, "utf8") : null;
  let base = {};
  if (hadFile) {
    let parsed;
    try {
      parsed = JSON.parse(original.replace(/^\uFEFF/, ""));
    } catch {
      throw fail("invalid", `${path.relative(workspace, file)} is not plain JSON; cannot safely append runner policies (comments are not supported by the runner)`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw fail("invalid", `${path.relative(workspace, file)} is not a JSON object`);
    base = parsed;
  }
  const repoPolicies = Array.isArray(base.policies) ? base.policies : [];
  // Runner policies go last: within one file the last matching statement wins.
  const merged = { ...base, policies: [...repoPolicies, ...policies] };
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
  return { file, hadFile, original };
}

function restoreAgentConfig(info) {
  if (!info) return;
  if (info.hadFile) fs.writeFileSync(info.file, info.original);
  else {
    try {
      fs.rmSync(info.file);
      const dir = path.dirname(info.file);
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      /* best effort */
    }
  }
}

function addGitExcludes(workspace, entries) {
  const rel = git(workspace, ["rev-parse", "--git-path", "info/exclude"]);
  if (rel.code !== 0) return;
  const raw = rel.stdout.trim();
  const file = path.isAbsolute(raw) ? raw : path.join(workspace, raw);
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = text.split(/\r?\n/);
  const missing = entries.filter((e) => !lines.includes(e));
  if (missing.length) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, text.replace(/\s*$/, "\n") + missing.join("\n") + "\n");
  }
}

function porcelain(workspace, excludes) {
  const args = ["status", "--porcelain"];
  if (excludes.length) args.push("--", ".", ...excludes.map((e) => `:(exclude)${e}`));
  // trimEnd, not trim: the first status column may be a space (" M path").
  return git(workspace, args).stdout.trimEnd();
}

function makePatch(workspace, excludes) {
  const ex = excludes.map((e) => `:(exclude)${e}`);
  git(workspace, ["add", "-N", "--", ".", ...ex]);
  const r = git(workspace, ["diff", "--no-color", "--", ".", ...ex]);
  git(workspace, ["reset", "-q"]);
  let patch = r.stdout;
  let truncated = false;
  if (Buffer.byteLength(patch) > PATCH_CAP) {
    patch = patch.slice(0, PATCH_CAP);
    truncated = true;
  }
  return { patch, truncated, error: r.code !== 0 ? r.stderr.trim() : null };
}

function runVerify(workspace, cmd, timeoutSec, redact, runDir) {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd: workspace,
      env: childEnv(workspace),
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutSec * 1000);
    const collect = (d) => {
      if (out.length < 2 * 1024 * 1024) out += d.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, timedOut: false, output: `spawn error: ${e.message}` });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const redacted = redact.redact(out);
      fs.appendFileSync(path.join(runDir, "logs", "verify.log"), redacted + "\n");
      resolve({ code: code ?? -1, timedOut, output: redacted });
    });
  });
}

function mergeStats(agg, stats) {
  agg.steps += stats.steps;
  agg.textParts += stats.textParts;
  agg.events += stats.events;
  agg.parseErrors += stats.parseErrors;
  agg.tokens.input += stats.tokens.input;
  agg.tokens.output += stats.tokens.output;
  agg.tokens.reasoning += stats.tokens.reasoning;
  agg.tokens.cacheRead += stats.tokens.cacheRead;
  agg.tokens.cacheWrite += stats.tokens.cacheWrite;
  agg.tokens.total += stats.tokens.total;
  agg.costUsd += stats.costUsd;
  agg.costSeen = agg.costSeen || stats.costSeen;
  agg.tools.calls += stats.tools.calls;
  agg.tools.errors += stats.tools.errors;
  agg.tools.blockedByPolicy += stats.tools.blockedByPolicy;
  for (const e of stats.tools.recentErrors) {
    if (agg.tools.recentErrors.length < 10) agg.tools.recentErrors.push(e);
  }
  agg.errors.push(...stats.errors);
  if (stats.finalText) agg.finalText = stats.finalText;
  if (stats.sessionId) agg.sessionId = stats.sessionId;
}

function isTransient(attempt) {
  if (attempt.stats.errors.some((e) => TRANSIENT_ERROR_TYPES.has(e.type))) return true;
  return TRANSIENT_STDERR.test(attempt.stderr);
}

// git on Windows can answer with forward slashes, a short (8.3) name or a
// different case than our workspace string; compare canonical forms, not strings.
function samePath(a, b) {
  const forms = (p) => {
    const abs = path.resolve(p);
    const out = new Set([abs]);
    try {
      out.add(fs.realpathSync.native(abs));
    } catch {
      /* unresolvable path: the absolute form is all we have */
    }
    if (process.platform === "win32") for (const v of [...out]) out.add(v.toLowerCase());
    return out;
  };
  const bForms = forms(b);
  return [...forms(a)].some((v) => bForms.has(v));
}

async function executeJob(cfg, ctx) {
  const { workspace, runDir, redact, log, jobId } = ctx;
  const v = cfg.values;
  const prompt = v.prompt ?? (v["prompt-file"] ? fs.readFileSync(path.resolve(v["prompt-file"]), "utf8") : null);
  if (!prompt) throw fail("invalid", "missing --prompt or --prompt-file");
  if (!v.model) throw fail("invalid", "missing --model");
  const modelPolicy = checkModel(cfg);
  ctx.result.costPolicy = {
    model: v.model,
    modelAllowlisted: modelPolicy.listed,
    requireCostReport: modelPolicy.requireCostReport,
    costReported: null,
  };

  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw fail("invalid", `workspace not found: ${workspace}`);
  }
  const top = git(workspace, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw fail("invalid", `not a git repository: ${workspace}`);
  if (!samePath(top.stdout.trim(), workspace)) {
    throw fail("invalid", `workspace must be the repository root (got ${top.stdout.trim()})`);
  }
  if (git(workspace, ["rev-parse", "HEAD"]).code !== 0) throw fail("invalid", "repository has no commits");

  const configRel = ".opencode/opencode.json";
  const excludes = [configRel, ".opencode/opencode.jsonc"];
  const relRunBase = path.relative(workspace, path.dirname(runDir)).replace(/\\/g, "/");
  if (relRunBase && !relRunBase.startsWith("..") && !path.isAbsolute(relRunBase)) excludes.push(relRunBase);
  if (porcelain(workspace, excludes) !== "") {
    throw fail("invalid", "workspace has uncommitted changes; refusing to run (diff artifacts would be polluted)");
  }
  ctx.result.target = { commitBefore: git(workspace, ["rev-parse", "HEAD"]).stdout.trim(), dirtyBefore: false };

  const bin = resolveBin(v["opencode-bin"] ?? "opencode");
  const pv = probeVersion(bin);
  ctx.result.opencode = { bin, version: pv.raw || null };
  if (!pv.version) throw fail("infra-error", `could not determine opencode version for "${bin}": ${pv.raw || pv.error}`);
  const min = String(v["min-opencode-version"] ?? MIN_OPENCODE_VERSION.join(".")).split(".").map(Number);
  if (!cfg.flags.has("skip-version-check") && !versionGte(pv.version, min)) {
    throw fail(
      "infra-error",
      `opencode ${pv.raw} is older than required ${min.join(".")}; configuration policies are silently ignored on 2.0.26 (verified). Upgrade or pass --skip-version-check (unsafe).`,
    );
  }
  log(`opencode: ${bin} (${pv.raw})`);

  const budgets = {
    timeoutSec: numOr(fail, "timeout-sec", v["timeout-sec"], 1800),
    maxTokens: numOr(fail, "max-tokens", v["max-tokens"], 2_000_000),
    maxCostUsd: numOr(fail, "max-cost-usd", v["max-cost-usd"], 0),
    maxSteps: numOr(fail, "max-steps", v["max-steps"], 80),
  };
  const maxAttempts = Math.max(1, numOr(fail, "max-attempts", v["max-attempts"], 1));
  ctx.result.budgets = budgets;
  ctx.result.maxAttempts = maxAttempts;

  const policies = loadPolicies(cfg);
  const cfgInfo = installAgentConfig(workspace, policies);
  addGitExcludes(workspace, [configRel, ...(excludes[2] ? [excludes[2] + "/"] : [])]);
  log(`policies installed: ${policies.length} statements (web=${cfg.flags.has("allow-web")}, external-dir=${cfg.flags.has("allow-external-dir")})`);

  const args = buildAgentArgs({ model: v.model, agent: v.agent ?? "build", title: jobId, prompt });
  const logPath = path.join(runDir, "logs", "opencode.jsonl");
  let logBytes = 0;
  const onLine = (line) => {
    if (logBytes >= LOG_CAP) return;
    logBytes += Buffer.byteLength(line);
    fs.appendFileSync(logPath, redact.redact(line) + "\n");
  };

  let child = null;
  let cancelRequested = false;
  const onSig = (sig) => {
    cancelRequested = true;
    log(`received ${sig}; stopping agent`);
    killTree(child);
  };
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);

  const agg = emptyStats();
  let last = null;
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      ctx.result.attempts = attempt;
      log(`attempt ${attempt}/${maxAttempts}: model=${v.model} agent=${v.agent ?? "build"}`);
      last = await runAttempt({
        bin,
        args,
        cwd: workspace,
        env: childEnv(workspace),
        budgets,
        onLine,
        redact,
        registerChild: (c) => {
          child = c;
        },
      });
      mergeStats(agg, last.stats);
      ctx.result.attemptsDetail.push({
        attempt,
        exitCode: last.exitCode,
        signal: last.signal ?? null,
        killReason: last.killReason ?? null,
        spawnError: last.spawnError?.message ?? null,
        stderrTail: redact.redact(last.stderr).slice(-2000),
      });
      if (last.killReason || last.spawnError || last.exitCode === 0) break;
      const clean = porcelain(workspace, excludes) === "";
      const retryable = attempt < maxAttempts && clean && isTransient(last);
      log(`attempt ${attempt} failed (exit=${last.exitCode}); workspace-clean=${clean}; retryable=${retryable}`);
      if (!retryable) break;
    }
  } finally {
    restoreAgentConfig(cfgInfo);
    process.removeListener("SIGINT", onSig);
    process.removeListener("SIGTERM", onSig);
  }

  ctx.result.usage = {
    steps: agg.steps,
    tokens: agg.tokens,
    costUsd: Number(agg.costUsd.toFixed(6)),
    costReported: agg.costSeen,
  };
  ctx.result.session = { id: agg.sessionId };
  ctx.result.tools = agg.tools;
  ctx.result.errors = agg.errors;
  ctx.result.finalText = agg.finalText.slice(0, 2000);

  const patch = makePatch(workspace, excludes);
  const patchPath = path.join(runDir, "diff.patch");
  // The diff is written by the agent and can embed env secrets; redact it too.
  fs.writeFileSync(patchPath, redact.redact(patch.patch));
  if (patch.truncated) ctx.result.notes.push(`diff.patch truncated at ${PATCH_CAP} bytes`);
  if (logBytes >= LOG_CAP) ctx.result.notes.push(`logs/opencode.jsonl capped at ${LOG_CAP} bytes`);
  if (!agg.costSeen) ctx.result.notes.push("provider did not report cost; cost guard could not observe usage");
  ctx.result.costPolicy.costReported = agg.costSeen;
  const after = porcelain(workspace, excludes);
  ctx.result.target.commitAfter = git(workspace, ["rev-parse", "HEAD"]).stdout.trim();
  ctx.result.target.dirtyAfter = after !== "";
  ctx.result.target.changedPaths = after.split(/\r?\n/).filter(Boolean).slice(0, 50).map((l) => l.slice(3));

  if (cancelRequested) return { status: "cancelled", exitCode: EXIT.cancelled, reason: "cancelled by signal" };
  if (last.killReason === "timeout") {
    return { status: "timeout", exitCode: EXIT.timeout, reason: `wall-clock limit of ${budgets.timeoutSec}s exceeded; agent killed` };
  }
  if (last.killReason) {
    const label = { "max-tokens": "token budget", "max-cost": "cost guard", "max-steps": "step limit" }[last.killReason] ?? last.killReason;
    return { status: "budget-exceeded", exitCode: EXIT.budget, reason: `${label} breached; agent killed` };
  }
  if (last.spawnError) return { status: "infra-error", exitCode: EXIT.infra, reason: `failed to start opencode: ${last.spawnError.message}` };
  if (last.exitCode === 0) {
    if (agg.steps === 0 && agg.textParts === 0) {
      return { status: "unknown", exitCode: EXIT.unknown, reason: "opencode exited 0 but produced no events; result unknown (not treated as success)" };
    }
    if (modelPolicy.requireCostReport && !agg.costSeen) {
      return {
        status: "unknown",
        exitCode: EXIT.unknown,
        reason: "provider never reported cost and this job requires a cost report (unlisted model or --require-cost-report); refusing to treat the result as success",
      };
    }
    if (v["verify-cmd"]) {
      const vt = numOr(fail, "verify-timeout-sec", v["verify-timeout-sec"], 600);
      log(`verification: ${v["verify-cmd"]}`);
      const vr = await runVerify(workspace, v["verify-cmd"], vt, redact, runDir);
      ctx.result.verification = { cmd: v["verify-cmd"], exitCode: vr.code, timedOut: vr.timedOut, status: vr.code === 0 ? "passed" : "failed" };
      if (vr.timedOut) return { status: "verify-failed", exitCode: EXIT.verifyFailed, reason: `verification timed out after ${vt}s` };
      if (vr.code !== 0) return { status: "verify-failed", exitCode: EXIT.verifyFailed, reason: `verification command exited with code ${vr.code}` };
    }
    return { status: "success", exitCode: 0, reason: null };
  }
  return {
    status: "agent-failed",
    exitCode: EXIT.agentFailed,
    reason: `opencode exited with code ${last.exitCode}${last.signal ? ` (signal ${last.signal})` : ""}`,
  };
}

function writeSummaryMd(result, runDir, redact) {
  const lines = [
    `# Job ${result.jobId}`,
    "",
    `- status: **${result.status}** (exit ${result.exitCode})`,
    result.reason ? `- reason: ${result.reason}` : null,
    `- model: ${result.model} (agent: ${result.agent})`,
    `- opencode: ${result.opencode.version ?? "?"}`,
    `- attempts: ${result.attempts}/${result.maxAttempts}`,
    `- duration: ${(result.timing.durationMs / 1000).toFixed(1)}s`,
    `- steps: ${result.usage.steps}, tool calls: ${result.tools.calls}, blocked by policy: ${result.tools.blockedByPolicy}`,
    `- tokens: total ${result.usage.tokens.total} (in ${result.usage.tokens.input} / out ${result.usage.tokens.output} / reasoning ${result.usage.tokens.reasoning} / cache-read ${result.usage.tokens.cacheRead})`,
    `- cost: $${result.usage.costUsd}${result.usage.costReported ? "" : " (provider did not report cost)"}`,
    result.verification ? `- verification: \`${result.verification.cmd}\` → exit ${result.verification.exitCode} (${result.verification.status})` : null,
    result.target.commitBefore ? `- commit: ${result.target.commitBefore.slice(0, 12)}${result.target.dirtyAfter ? " (workspace modified)" : " (no changes)"}` : null,
    "",
  ].filter((l) => l !== null);
  if (result.finalText) lines.push("## Final agent message", "", "```", result.finalText, "```", "");
  lines.push("## Artifacts", "", "- job.json", "- diff.patch", "- logs/opencode.jsonl", "- logs/runner.log", "- logs/verify.log (when verification ran)");
  if (result.notes.length) lines.push("", "## Notes", "", ...result.notes.map((n) => `- ${n}`));
  fs.writeFileSync(path.join(runDir, "summary.md"), redact.redact(lines.join("\n") + "\n"));
}

function buildSkeleton(cfg, jobId, workspace, runDir) {
  return {
    jobId,
    schema: 1,
    status: "unknown",
    exitCode: EXIT.unknown,
    reason: null,
    attempts: 0,
    maxAttempts: Number(cfg.values["max-attempts"] ?? 1),
    model: cfg.values.model ?? null,
    agent: cfg.values.agent ?? "build",
    opencode: { bin: null, version: null },
    workspace,
    budgets: null,
    costPolicy: null,
    usage: null,
    session: { id: null },
    tools: { calls: 0, errors: 0, blockedByPolicy: 0, recentErrors: [] },
    errors: [],
    verification: null,
    attemptsDetail: [],
    target: { commitBefore: null, commitAfter: null, dirtyBefore: null, dirtyAfter: null, changedPaths: [] },
    artifacts: {
      dir: runDir,
      job: "job.json",
      opencodeLog: "logs/opencode.jsonl",
      runnerLog: "logs/runner.log",
      diff: "diff.patch",
      summary: "summary.md",
    },
    timing: { startedAt: new Date().toISOString(), endedAt: null, durationMs: 0 },
    redactions: 0,
    notes: [],
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help")) {
    console.log(usage());
    return 0;
  }
  let cfg;
  try {
    cfg = parseArgs(argv);
  } catch (e) {
    console.error(`error: ${e.message}\n\n${usage()}`);
    return EXIT.invalid;
  }

  const started = Date.now();
  const workspace = path.resolve(cfg.values.workspace ?? process.cwd());
  const jobId = cfg.values["job-id"] ?? genJobId();
  const runBase = path.resolve(cfg.values["run-base"] ?? path.join(process.cwd(), "runs"));
  const runDir = path.join(runBase, jobId);
  ensureDir(path.join(runDir, "logs"));

  const redact = makeRedactor(process.env);
  const runnerLogPath = path.join(runDir, "logs", "runner.log");
  const log = (msg) => {
    const line = redact.redact(`[${new Date().toISOString()}] ${msg}`);
    fs.appendFileSync(runnerLogPath, line + "\n");
    console.error(line);
  };

  const result = buildSkeleton(cfg, jobId, workspace, runDir);
  log(`job ${jobId} starting; workspace=${workspace}`);

  let outcome;
  try {
    outcome = await executeJob(cfg, { workspace, runDir, redact, log, jobId, result });
  } catch (e) {
    outcome = { status: e.status ?? "infra-error", exitCode: e.exitCode ?? EXIT.infra, reason: e.message ?? String(e) };
  }

  result.status = outcome.status;
  result.exitCode = outcome.exitCode;
  result.reason = outcome.reason ?? null;
  result.timing.endedAt = new Date().toISOString();
  result.timing.durationMs = Date.now() - started;
  result.redactions = redact.count;
  if (!result.usage) {
    result.usage = { steps: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, costUsd: 0, costReported: false };
  }
  writeJson(path.join(runDir, "job.json"), result);
  writeSummaryMd(result, runDir, redact);
  log(`finished: status=${result.status} exit=${result.exitCode} duration=${result.timing.durationMs}ms`);

  console.log(
    `RESULT ${JSON.stringify({
      jobDir: runDir,
      status: result.status,
      exitCode: result.exitCode,
      attempts: result.attempts,
      durationMs: result.timing.durationMs,
      tokens: result.usage.tokens.total,
      costUsd: result.usage.costUsd,
      blockedByPolicy: result.tools.blockedByPolicy,
      redactions: result.redactions,
    })}`,
  );
  return result.exitCode;
}

main().then((code) => process.exit(code));
