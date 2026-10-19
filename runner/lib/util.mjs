import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function genJobId(date = new Date()) {
  const ts = date.toISOString().replace(/[:-]/g, "").replace(/\.\d+Z$/, "Z");
  return `oc24-${ts}-${crypto.randomBytes(2).toString("hex")}`;
}

export function runSync(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error ?? null };
}

export function git(workspace, args, opts = {}) {
  return runSync("git", ["-C", workspace, ...args], opts);
}

// Env for anything the runner spawns. PWD is pinned to the workspace: POSIX
// CLIs (opencode included) resolve the project root from it, not from getcwd().
// node --test also sets markers in every test process; a child node --test that
// inherits them skips every file and still exits 0, which would fake a pass.
const NODE_TEST_ENV = ["NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID"];

export function childEnv(workspace, extra = {}) {
  const env = { ...process.env, ...extra, PWD: workspace };
  for (const k of NODE_TEST_ENV) delete env[k];
  return env;
}

// .mjs/.cjs/.js "binaries" (used by tests and stubs) run through the current node.
export function execFor(bin) {
  return /\.(mjs|cjs|js)$/i.test(bin)
    ? { cmd: process.execPath, preArgs: [bin] }
    : { cmd: bin, preArgs: [] };
}

export function makeRedactor(env, extraSecrets = []) {
  const secrets = Object.entries(env)
    .filter(([k, v]) => typeof v === "string" && v.length >= 6 && /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(k))
    .map(([, v]) => v)
    .concat(extraSecrets.filter((v) => typeof v === "string" && v.length >= 6))
    .sort((a, b) => b.length - a.length);
  const patterns = [
    /sk-[A-Za-z0-9_-]{20,}/g,
    /AIza[0-9A-Za-z_-]{30,}/g,
    /gh[pousr]_[A-Za-z0-9]{20,}/g,
    /github_pat_[A-Za-z0-9_]{30,}/g,
    /(?:Bearer|authorization)\s*[:=]?\s*[A-Za-z0-9._~+/=-]{25,}/gi,
    /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{8,}/g,
  ];
  let count = 0;
  return {
    redact(input) {
      let s = String(input ?? "");
      for (const v of secrets) {
        if (s.includes(v)) {
          count += s.split(v).length - 1;
          s = s.split(v).join("[REDACTED]");
        }
      }
      for (const p of patterns) {
        s = s.replace(p, () => {
          count++;
          return "[REDACTED]";
        });
      }
      return s;
    },
    get count() {
      return count;
    },
  };
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}
