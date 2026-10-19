#!/usr/bin/env node
// Deterministic stand-in for the opencode CLI used by tests/runner.test.mjs.
// Modes are selected with OC24_STUB_MODE and mimic the verified output shape of
// `opencode run --standalone --format json`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.argv.includes("--version")) {
  // synchronous: process.exit() can truncate pending pipe writes on Windows
  fs.writeSync(1, `opencode v${process.env.OC24_STUB_VERSION ?? "2.9.9"}\n`);
  process.exit(0);
}

const mode = process.env.OC24_STUB_MODE ?? "ok";
const sid = "ses_stub00000000000000000000";
const out = (o) => fs.writeSync(1, JSON.stringify(o) + "\n");
const base = (type, part) => ({ type, timestamp: Date.now(), sessionID: sid, part });
const stepStart = () => out(base("step_start", { type: "step-start" }));
const stepFinish = ({ tokens = {}, cost } = {}) => {
  const part = { type: "step-finish", reason: "tool-calls", tokens };
  if (cost !== undefined) part.cost = cost; // providers that never report cost omit the field entirely
  out(base("step_finish", part));
};
const text = (t) => out(base("text", { type: "text", text: t }));
const tool = (name, status = "completed") => out(base("tool_use", { type: "tool", tool: name, state: { status } }));
const failWith = (type, message, code) => {
  out({ type: "error", timestamp: Date.now(), sessionID: sid, error: { type, message } });
  process.exit(code);
};
const hang = () => setInterval(() => {}, 1000);

if (process.env.OC24_STUB_CHECK_CONFIG) {
  const file = ".opencode/opencode.json";
  const state = process.env.OC24_STUB_STATE ?? path.join(os.tmpdir(), "oc24-stub-state.json");
  let check = { file: false };
  try {
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    check = {
      file: true,
      hasOurPolicy: cfg.policies?.some((p) => p.resource === "shell:git push*"),
      hasRepoPolicy: cfg.policies?.some((p) => p.resource === "shell:repo-custom *"),
    };
  } catch (e) {
    check = { file: false, error: String(e.message) };
  }
  fs.writeFileSync(state, JSON.stringify(check));
}

const okBody = () => {
  stepStart();
  // Touch one tracked file (exercises " M path" porcelain lines) and one untracked file.
  try {
    fs.appendFileSync("README.md", "stub edit\n");
  } catch {
    /* fixture without README.md */
  }
  fs.writeFileSync("stub-touched.txt", "ok\n");
  tool("write");
  stepFinish({ tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 });
  text(`stub ok pwd=${process.env.PWD ?? ""}`);
};

switch (mode) {
  case "ok":
    okBody();
    process.exit(0);
    break;
  case "silent":
    process.exit(0);
    break;
  case "fail":
    failWith("provider.no-route", "Model unavailable: fake/model", 3);
    break;
  case "transient":
    failWith("provider.network", "connection reset by peer", 1);
    break;
  case "flaky": {
    const state = process.env.OC24_STUB_STATE ?? path.join(os.tmpdir(), "oc24-stub-flaky.json");
    let n = 0;
    try {
      n = Number(fs.readFileSync(state, "utf8")) || 0;
    } catch {
      /* first attempt */
    }
    fs.writeFileSync(state, String(n + 1));
    if (n === 0) failWith("provider.network", "connection reset by peer", 1);
    okBody();
    process.exit(0);
    break;
  }
  case "hang":
    stepStart();
    hang();
    break;
  case "tokens": {
    stepStart();
    let i = 0;
    const t = setInterval(() => {
      i++;
      stepFinish({ tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
      if (i >= 6) clearInterval(t);
    }, 30);
    hang();
    break;
  }
  case "cost":
    stepStart();
    stepFinish({ tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 1.25 });
    hang();
    break;
  case "nocost":
    // events but no cost field at all (provider that does not report usage)
    stepStart();
    tool("read");
    stepFinish({ tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } });
    text("stub nocost");
    process.exit(0);
    break;
  case "burst":
    // large burst, then an immediate exit: every line must still be read
    for (let i = 0; i < 500; i++) {
      stepFinish({ tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 });
    }
    process.exit(0);
    break;
  case "leaky-file": {
    const secret = process.env.OC24_TEST_SECRET ?? "no-secret";
    stepStart();
    fs.writeFileSync("agent-output.txt", `token=${secret}\n`);
    tool("write");
    stepFinish({ tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 });
    text("wrote agent-output.txt");
    process.exit(0);
    break;
  }
  case "leaky": {
    const secret = process.env.OC24_TEST_SECRET ?? "no-secret";
    stepStart();
    stepFinish({ tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 });
    fs.writeSync(2, `stderr leaks ${secret}\n`);
    text(`the secret is ${secret} ok`);
    process.exit(0);
    break;
  }
  default:
    console.error(`unknown stub mode: ${mode}`);
    process.exit(2);
}
