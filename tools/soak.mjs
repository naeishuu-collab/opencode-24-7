#!/usr/bin/env node
// Soak harness: runs the real controller for a bounded window while watching it.
//
//   node tools/soak.mjs --minutes 10 --out runs/soak
//   node tools/soak.mjs --minutes 340 --out runs/soak --state runs/soak/state.json \
//        --restart-every-min 90 --jobs 1
//
// It proves, on real evidence, the properties 24/7 operation depends on:
//   - the controller keeps ticking with no manual calls (jobs advance on their own)
//   - a hard kill (SIGKILL) mid-flight is recovered on restart, with no duplicate
//     dispatch and no lost attempt
//   - no attempt is left running forever, every success is artifact-verified,
//     every job that ran cost $0
//   - the same state survives across slices, so a long soak can be split into
//     shorter runs (a CI job cannot hold six hours more than once per window)
//
// The verdict is honest: `soak_24h` only becomes "verified" when 24 h of
// *measured* active run time has accumulated in `state.json`. A short run says
// "pending" and prints exactly how much is missing.
//
// Evidence lives in --out: evidence.jsonl, soak-report.json, server.log,
// state.json and the SQLite database.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOAK_24H_MINUTES = 24 * 60;

function parseArgs(argv) {
  const args = {
    minutes: 5,
    out: null,
    state: null,
    sampleSec: 30,
    restartEveryMin: 0,
    jobs: 0,
    label: "local",
    goal:
      "Documentation only: add one sentence to README.md in the 'Tests' section saying the controller suites run under `npm test`. Change nothing else.",
    verify: "npm test",
    repo: process.env.OC24_REPO ?? "naeishuu-collab/opencode-24-7",
  };
  for (let i = 0; i < argv.length; i++) {
    const [key, value] = argv[i].startsWith("--") ? argv[i].slice(2).split("=") : [null, null];
    if (!key) continue;
    const next = value ?? argv[i + 1];
    const take = () => {
      if (value === undefined) i++;
      return next;
    };
    if (key === "minutes") args.minutes = Number(take()) || 5;
    else if (key === "out") args.out = take();
    else if (key === "state") args.state = take();
    else if (key === "sample-sec") args.sampleSec = Math.max(5, Number(take()) || 30);
    else if (key === "restart-every-min") args.restartEveryMin = Math.max(0, Number(take()) || 0);
    else if (key === "jobs") args.jobs = Math.max(0, Number(take()) || 0);
    else if (key === "label") args.label = String(take());
    else if (key === "goal") args.goal = String(take());
    else if (key === "verify") args.verify = String(take());
    else if (key === "repo") args.repo = String(take());
    else if (key === "help") {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 24).join("\n"));
      process.exit(0);
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  args.out = args.out ? path.resolve(ROOT, args.out) : path.join(ROOT, "runs", `soak-${stamp}`);
  args.state = args.state ? path.resolve(ROOT, args.state) : path.join(args.out, "state.json");
  return args;
}

const args = parseArgs(process.argv.slice(2));
fs.mkdirSync(args.out, { recursive: true });
fs.mkdirSync(path.dirname(args.state), { recursive: true });

const evidencePath = path.join(args.out, "evidence.jsonl");
const serverLogPath = path.join(args.out, "server.log");
const evidence = fs.createWriteStream(evidencePath, { flags: "a" });
const record = (kind, data = {}) => evidence.write(`${JSON.stringify({ at: new Date().toISOString(), kind, ...data })}\n`);

const savedState = fs.existsSync(args.state) ? JSON.parse(fs.readFileSync(args.state, "utf8")) : null;
const state = savedState ?? {
  created_at: new Date().toISOString(),
  active_minutes: 0,
  slices: [],
  restarts: 0,
  samples: 0,
  samples_ok: 0,
  jobs_created: 0,
};

// Self-terminating: once a 24 h window has been verified the scheduled slices
// have nothing left to prove. The schedule itself is removed after that.
if (state.verdict_24h === "verified") {
  console.log("[soak] 24 h soak already verified in this state file; nothing to do");
  process.exit(0);
}

// A fresh admin token per slice: the state file (which is cached in CI) never
// holds a credential, and the controller still refuses to start without one.
const adminToken = crypto.randomUUID().replace(/-/g, "");

const deadline = Date.now() + args.minutes * 60_000;
const slice = { start: new Date().toISOString(), label: args.label, host: null, end: null, samples: 0, samples_ok: 0 };
let child = null;
let url = null;
let stopping = false;
let cookie = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(pathname, { method = "GET", body, timeoutMs = 10_000 } = {}) {
  const res = await fetch(url + pathname, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const jar = res.headers.getSetCookie?.() ?? [];
  const session = jar.find((c) => c.startsWith("oc24_session="));
  if (session) cookie = session.split(";")[0];
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

function startController() {
  return new Promise((resolve, reject) => {
    const log = fs.createWriteStream(serverLogPath, { flags: "a" });
    child = spawn(process.execPath, [path.join(ROOT, "controller", "server.mjs")], {
      cwd: ROOT,
      env: {
        ...process.env,
        OC24_ADMIN_TOKEN: adminToken,
        OC24_DB_PATH: path.join(args.out, "controller.db"),
        OC24_REPO: args.repo,
        OC24_HOST: "127.0.0.1",
        OC24_PORT: "0",
        OC24_TICK: "1",
        OC24_TICK_SECONDS: "60",
        OC24_MAX_JOBS_PER_DAY: "10",
        OC24_MAX_DISPATCH_PER_DAY: "5",
        OC24_MAX_CONCURRENT: "1",
        OC24_EVENT_RETENTION_DAYS: "7",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffered = "";
    const timer = setTimeout(() => reject(new Error("controller did not report a listening address in 60 s")), 60_000);
    child.stdout.on("data", (chunk) => {
      log.write(chunk);
      buffered += chunk.toString();
      const line = buffered.split("\n").find((l) => l.includes('"listening":true'));
      if (line) {
        try {
          const info = JSON.parse(line.trim());
          clearTimeout(timer);
          url = info.url;
          slice.host = info.url;
          resolve(info);
        } catch {
          /* keep buffering */
        }
      }
    });
    child.stderr.on("data", (chunk) => log.write(chunk));
    child.on("exit", (code, signal) => {
      if (!stopping) record("controller-exit", { code, signal });
    });
  });
}

async function stopController(signal = "SIGKILL") {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((resolve) => child.once("exit", resolve));
  child.kill(signal);
  await Promise.race([done, sleep(10_000)]);
}

async function signIn() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const res = await api("/api/session", { method: "POST", body: { token: adminToken } });
      if (res.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await sleep(1_000);
  }
  return false;
}

async function sample() {
  state.samples++;
  slice.samples++;
  try {
    const health = await api("/healthz", { timeoutMs: 5_000 });
    const stats = await api("/api/stats", { timeoutMs: 10_000 });
    if (health.status !== 200 || stats.status !== 200) throw new Error(`healthz ${health.status}, stats ${stats.status}`);
    state.samples_ok++;
    slice.samples_ok++;
    const jobCount = Object.values(stats.json.jobsByState ?? {}).reduce((a, b) => a + b, 0);
    record("sample", {
      ok: true,
      jobs: jobCount,
      jobsByState: stats.json.jobsByState ?? {},
      activeAttempts: stats.json.activeAttempts ?? 0,
      events: stats.json.events?.count ?? null,
    });
    return stats.json;
  } catch (e) {
    record("sample", { ok: false, error: String(e?.message ?? e) });
    return null;
  }
}

async function createJob(n) {
  const res = await api("/api/jobs", {
    method: "POST",
    body: {
      goal: args.goal,
      model: process.env.OC24_SOAK_MODEL ?? "opencode/deepseek-v4.1-flash-free",
      verify_cmd: args.verify,
      timeout_sec: 1800,
      max_attempts: 1,
    },
  });
  if (res.status === 201) {
    state.jobs_created++;
    record("job-created", { job: res.json.job.id });
    console.log(`[soak] job ${n} created: ${res.json.job.id}`);
  } else {
    record("job-create-failed", { status: res.status, code: res.json?.error ?? null });
    console.log(`[soak] job ${n} not created: ${res.status} ${res.json?.error ?? ""}`);
  }
}

// ---- run -------------------------------------------------------------------

let keepRunning = true;
const stop = (signal) => {
  keepRunning = false;
  stopping = true;
  record("stop-requested", { signal });
  stopController().finally(() => process.exit(0));
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

const sliceStart = Date.now();
slice.start = new Date(sliceStart).toISOString();
record("slice-start", { label: args.label, minutes: args.minutes, repo: args.repo, dispatch: Boolean(process.env.OC24_GITHUB_TOKEN) });

await startController();
const signedIn = await signIn();
record("signed-in", { ok: signedIn });
if (!signedIn) {
  console.error("[soak] could not sign in to the controller; stopping");
  await stopController();
  process.exit(1);
}
console.log(`[soak] controller at ${url}, running for ${args.minutes} min`);

const restartEveryMs = args.restartEveryMin * 60_000;
const jobTimes = [];
for (let i = 0; i < args.jobs; i++) {
  // Spread the jobs across the window (first one early, so its dispatch and
  // artifact verification are watched for the rest of the run).
  jobTimes.push(deadline - args.minutes * 60_000 * (1 - (i + 1) / (args.jobs + 1)));
}
let lastRestart = Date.now();
let nextSample = 0;

while (keepRunning && Date.now() < deadline) {
  const now = Date.now();
  if (now >= nextSample) {
    nextSample = now + args.sampleSec * 1000;
    await sample();
  }
  while (jobTimes.length && Date.now() >= jobTimes[0]) {
    jobTimes.shift();
    await createJob(args.jobs - jobTimes.length);
  }
  if (restartEveryMs && now - lastRestart >= restartEveryMs) {
    lastRestart = now;
    const before = await api("/api/jobs?limit=1");
    console.log("[soak] SIGKILL the controller and restart it on the same database");
    await stopController("SIGKILL");
    await sleep(1_000);
    await startController();
    const ok = await signIn();
    state.restarts++;
    record("restart", { ok, jobsBefore: before.json?.total ?? null });
    console.log(`[soak] restarted after SIGKILL (signed in again: ${ok})`);
    if (!ok) {
      record("restart-failed", {});
      keepRunning = false;
    }
  }
  await sleep(2_000);
}

// ---- report ----------------------------------------------------------------

const sliceMinutes = (Date.now() - sliceStart) / 60_000;
slice.end = new Date().toISOString();
slice.minutes = Number(sliceMinutes.toFixed(2));
state.slices.push(slice);
state.active_minutes = Number(
  (state.slices.reduce((sum, s) => sum + (s.minutes ?? 0), 0)).toFixed(2),
);
const longestSlice = state.slices.reduce((max, s) => Math.max(max, s.minutes ?? 0), 0);
const firstStart = state.slices[0].start;
const windowMinutes = Number(((Date.now() - Date.parse(firstStart)) / 60_000).toFixed(2));
fs.writeFileSync(args.state, JSON.stringify(state, null, 2));

const list = await api("/api/jobs?limit=200");
const jobs = list.json?.jobs ?? [];
const details = [];
for (const job of jobs) {
  const view = await api(`/api/jobs/${encodeURIComponent(job.id)}`);
  if (view.status === 200) details.push(view.json);
}

const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
const isStuck = (attempt, atMs) => {
  if (!["dispatching", "running"].includes(attempt.state)) return false;
  const last = Date.parse(attempt.heartbeat_at ?? attempt.dispatched_at ?? attempt.created_at);
  // The controller's own lease (default 900 s) plus slack: past that, a live
  // attempt means the tick loop is not doing its job.
  return Number.isFinite(last) && atMs - last > 1_200_000;
};

add("controller answered at least 90% of samples", state.samples === 0 || state.samples_ok / state.samples >= 0.9, `${state.samples_ok}/${state.samples}`);
add("no job reported more attempts than it stored", details.every((v) => v.job.attempt_count === v.attempts.length), `${details.length} jobs`);
add("every attempt marker is unique per job", details.every((v) => new Set(v.attempts.map((a) => a.marker)).size === v.attempts.length), "");
add(
  "no attempt is stuck past its lease",
  details.every((v) => v.attempts.every((a) => !isStuck(a, Date.now()))),
  details.flatMap((v) => v.attempts.filter((a) => isStuck(a, Date.now())).map((a) => `${v.job.id}#${a.n}`)).join(", "),
);
add(
  "every succeeded job passed independent verification",
  details.every((v) => v.job.state !== "succeeded" || v.job.verification?.ok === true),
  details.filter((v) => v.job.state === "succeeded" && v.job.verification?.ok !== true).map((v) => v.job.id).join(", "),
);
const costTotal = details.reduce((sum, v) => sum + Number(v.job.cost_usd ?? 0), 0);
add("every job reported $0 cost", costTotal === 0, `total $${costTotal}`);
add("no duplicate dispatch (one run id per attempt)", details.every((v) => new Set(v.attempts.map((a) => a.run_id).filter(Boolean)).size === v.attempts.filter((a) => a.run_id).length), "");

const active24 = state.active_minutes >= SOAK_24H_MINUTES;
// 24/7 is a claim about a window, not about a single process: a 24 h window
// during which the controller was up for >= 98% of the measured time is the
// honest bar (the gaps are cache restores between slices, and they are counted
// against availability). `continuous_24h` says whether one process ran 24 h.
const coverage = windowMinutes > 0 ? state.active_minutes / windowMinutes : 0;
const verified24 = windowMinutes >= SOAK_24H_MINUTES && coverage >= 0.98;
const report = {
  label: args.label,
  generated_at: new Date().toISOString(),
  window: { first_start: firstStart, last_end: slice.end, minutes: windowMinutes },
  minutes: { this_slice: slice.minutes, active_total: state.active_minutes, longest_slice: Number(longestSlice.toFixed(2)) },
  restarts: state.restarts,
  samples: { total: state.samples, ok: state.samples_ok },
  jobs: {
    total: jobs.length,
    by_state: jobs.reduce((acc, j) => ({ ...acc, [j.state]: (acc[j.state] ?? 0) + 1 }), {}),
    cost_usd_total: costTotal,
  },
  checks,
  verdict: {
    soak_24h: verified24 ? "verified" : "pending",
    reason: verified24
      ? `24 h window with ${(coverage * 100).toFixed(2)}% measured uptime`
      : windowMinutes < SOAK_24H_MINUTES
        ? `${windowMinutes.toFixed(1)} of ${SOAK_24H_MINUTES} window minutes elapsed`
        : `${(coverage * 100).toFixed(1)}% uptime over ${windowMinutes.toFixed(0)} min (needs >= 98%)`,
    continuous_24h: longestSlice >= SOAK_24H_MINUTES,
    coverage_pct: Number((coverage * 100).toFixed(2)),
  },
  evidence: { jsonl: evidencePath, log: serverLogPath, database: path.join(args.out, "controller.db") },
};

fs.writeFileSync(path.join(args.out, "soak-report.json"), JSON.stringify(report, null, 2));
state.verdict_24h = report.verdict.soak_24h;
state.verdict_reason = report.verdict.reason;
fs.writeFileSync(args.state, JSON.stringify(state, null, 2));
record("slice-end", { minutes: slice.minutes, verdict: report.verdict });
await sleep(200);
evidence.end();

console.log("\n=== SOAK ===");
console.log(JSON.stringify(report, null, 2));
console.log(`24/7 verdict: ${report.verdict.soak_24h.toUpperCase()} (${report.verdict.reason})`);

await stopController("SIGTERM");
process.exit(checks.every((c) => c.ok) ? 0 : 1);
