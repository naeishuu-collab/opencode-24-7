import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execFor } from "./util.mjs";

// Policies (tool.use hard denies) were verified enforced on 2.0.32 and verified
// NOT enforced (silently ignored) on 2.0.26. Never run below this.
export const MIN_OPENCODE_VERSION = [2, 0, 32];

export function probeVersion(bin) {
  const { cmd, preArgs } = execFor(bin);
  const r = spawnSync(cmd, [...preArgs, "--version"], { encoding: "utf8", timeout: 60000 });
  const raw = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  const m = raw.match(/v?(\d+)\.(\d+)\.(\d+)/);
  return { raw, version: m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null, error: r.error ?? null };
}

export function versionGte(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

export function resolveBin(bin) {
  // On Windows the npm global shim is a .ps1/.cmd that spawn() cannot execute
  // directly; fall back to the exe shipped inside @opencode/cli.
  if (process.platform === "win32" && path.basename(bin) === "opencode") {
    const candidate = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  return bin;
}

export function buildAgentArgs({ model, agent, title, prompt }) {
  const args = ["run", "--standalone", "--format", "json", "--auto"];
  if (model) args.push("--model", model);
  if (agent) args.push("--agent", agent);
  if (title) args.push("--title", title);
  args.push(prompt);
  return args;
}

export function emptyStats() {
  return {
    sessionId: null,
    steps: 0,
    textParts: 0,
    finalText: "",
    events: 0,
    parseErrors: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    costUsd: 0,
    costSeen: false,
    tools: { calls: 0, errors: 0, blockedByPolicy: 0, recentErrors: [] },
    errors: [],
  };
}

export function ingestLine(stats, line) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    stats.parseErrors++;
    return null;
  }
  stats.events++;
  if (ev.sessionID && !stats.sessionId) stats.sessionId = ev.sessionID;
  if (ev.type === "step_finish") {
    stats.steps++;
    const t = ev.part?.tokens ?? {};
    stats.tokens.input += t.input ?? 0;
    stats.tokens.output += t.output ?? 0;
    stats.tokens.reasoning += t.reasoning ?? 0;
    stats.tokens.cacheRead += t.cache?.read ?? 0;
    stats.tokens.cacheWrite += t.cache?.write ?? 0;
    stats.tokens.total =
      stats.tokens.input + stats.tokens.output + stats.tokens.reasoning + stats.tokens.cacheRead + stats.tokens.cacheWrite;
    const cost = ev.part?.cost;
    if (typeof cost === "number") {
      stats.costUsd += cost;
      stats.costSeen = true;
    }
  } else if (ev.type === "tool_use") {
    stats.tools.calls++;
    const st = ev.part?.state ?? {};
    if (st.status === "error") {
      const msg = String(st.error ?? "tool error");
      if (msg.includes("policy")) stats.tools.blockedByPolicy++;
      else stats.tools.errors++;
      if (stats.tools.recentErrors.length < 10) {
        stats.tools.recentErrors.push({ tool: ev.part?.tool ?? "?", error: msg.slice(0, 200) });
      }
    }
  } else if (ev.type === "text") {
    stats.textParts++;
    if (typeof ev.part?.text === "string" && ev.part.text.trim()) stats.finalText = ev.part.text;
  } else if (ev.type === "error") {
    stats.errors.push({ type: String(ev.error?.type ?? "unknown"), message: String(ev.error?.message ?? "").slice(0, 300) });
  }
  return ev;
}

export function budgetBreach(stats, budgets) {
  if (budgets.maxSteps && stats.steps > budgets.maxSteps) return "max-steps";
  if (budgets.maxTokens && stats.tokens.total > budgets.maxTokens) return "max-tokens";
  if (budgets.maxCostUsd != null && stats.costUsd > budgets.maxCostUsd) return "max-cost";
  return null;
}

export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    /* process already gone */
  }
}

export function runAttempt({ bin, args, cwd, env, budgets, onLine, registerChild, redact }) {
  return new Promise((resolve) => {
    const { cmd, preArgs } = execFor(bin);
    const child = spawn(cmd, [...preArgs, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    registerChild?.(child);
    const stats = emptyStats();
    let killReason = null;
    let spawnError = null;
    let stderr = "";
    const kill = (reason) => {
      if (!killReason) {
        killReason = reason;
        killTree(child);
      }
    };
    const timer = setTimeout(() => kill("timeout"), (budgets.timeoutSec ?? 1800) * 1000);
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      onLine?.(line);
      // Redact before parsing so no raw secret can reach stats (finalText, errors,
      // tool messages) and therefore job.json.
      const ev = ingestLine(stats, redact ? redact.redact(line) : line);
      if (ev) {
        const breach = budgetBreach(stats, budgets);
        if (breach) kill(breach);
      }
    });
    child.stderr.on("data", (d) => {
      stderr = (stderr + d.toString()).slice(-16384);
    });
    child.on("error", (err) => {
      spawnError = err;
    });
    // "close" (not "exit") fires after the stdio pipes are drained, so no event
    // line can be lost. Resolving on "exit" made the runner drop the tail of the
    // output whenever the child wrote and exited quickly (seen on a loaded
    // windows-latest runner: a nocost run with events was read as "no events").
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      rl.close();
      registerChild?.(null);
      resolve({ stats, exitCode: code, signal, killReason, spawnError, stderr });
    });
  });
}
