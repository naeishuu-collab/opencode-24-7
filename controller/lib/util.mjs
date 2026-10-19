// Small helpers for the cloud controller. Node + Workers compatible: no node:
// imports except crypto, which both runtimes provide through WebCrypto.
export const isWin = typeof process !== "undefined" && process.platform === "win32";

export function nowIso(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function addSeconds(iso, sec) {
  return nowIso(new Date(Date.parse(iso) + sec * 1000));
}

export function randHex(bytes = 8) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function newJobId(date = new Date()) {
  return `job-${nowIso(date).replace(/[:-]/g, "")}-${randHex(2)}`;
}

export function newAttemptId(date = new Date()) {
  return `att-${nowIso(date).replace(/[:-]/g, "")}-${randHex(3)}`;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Constant-time hex compare (same length expected: both are SHA-256 digests).
export function hexEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Constant-time compare, also safe for different lengths (compare digests).
export async function tokenMatches(expected, given) {
  if (typeof expected !== "string" || typeof given !== "string" || !expected) return false;
  const [a, b] = await Promise.all([sha256Hex(expected), sha256Hex(given)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function clampInt(value, min, max, dflt) {
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function dayKey(iso) {
  return iso.slice(0, 10);
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(status, code, message, extra = {}) {
  return jsonResponse({ error: code, message, ...extra }, status);
}

// Never let a credential reach a log line, an event row or an error message.
export function redact(text, secrets = []) {
  let out = String(text ?? "");
  for (const s of secrets) {
    if (typeof s === "string" && s.length >= 6) out = out.split(s).join("[REDACTED]");
  }
  return out
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{10,})\b/g, "[REDACTED]")
    .replace(/\b(oc24_[A-Za-z0-9_-]{10,})\b/g, "[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED]");
}

export function truncate(text, max = 2000) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}... [${s.length - max} more]` : s;
}

export async function withTimeout(promise, ms, label = "operation") {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
