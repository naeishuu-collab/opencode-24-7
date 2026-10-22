// The controller HTTP surface, written as a single `Request -> Response`
// handler so the exact same code runs on Node (local dev, tests) and inside a
// Cloudflare Worker (`fetch` handler).
//
// Auth: a session cookie created from the admin token. Everything under /api
// needs a session except /api/session, /healthz and the per-attempt report
// endpoint (which uses the attempt token and is advisory only).
import { dayKey, errorResponse, jsonResponse, nowIso, randHex, redact, tokenMatches, truncate } from "./lib/util.mjs";
import { agentList } from "./lib/agents.mjs";

export const SESSION_COOKIE = "oc24_session";
const SESSION_TTL_SEC = 12 * 3600;
const LOGIN_MAX_PER_HOUR = 10;
const BODY_MAX_BYTES = 64 * 1024;

// D1 caps LIKE patterns at 50 bytes, so keep the term well under that (the two
// surrounding "%" are part of the pattern). Never let a long term become an
// error in the cloud.
function searchTerm(raw) {
  if (!raw) return null;
  const clean = String(raw).replace(/[\u0000-\u001f]/g, "").trim();
  if (!clean) return null;
  let end = Math.min(clean.length, 64);
  while (end > 0 && new TextEncoder().encode(clean.slice(0, end)).length > 40) end--;
  return end > 0 ? clean.slice(0, end) : null;
}

export function createApp({ store, engine, config, assets = {}, now = () => nowIso() }) {
  const adminToken = config.adminToken ?? null;

  if (!adminToken) {
    // Fail closed: without an admin token the controller must not expose a
    // mutating API. The server refuses to start with this error.
    throw new Error("OC24_ADMIN_TOKEN is required (refusing to run without authentication)");
  }

  function clientIp(request) {
    return (
      request.headers.get("cf-connecting-ip") ??
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "local"
    );
  }

  function cookieValue(request, name) {
    const header = request.headers.get("cookie");
    if (!header) return null;
    for (const part of header.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === name) return v.join("=");
    }
    return null;
  }

  function isSecure(request) {
    try {
      return new URL(request.url).protocol === "https:";
    } catch {
      return false;
    }
  }

  function sessionCookie(id, request, maxAgeSec) {
    const attrs = [`${SESSION_COOKIE}=${id}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSec}`];
    if (isSecure(request)) attrs.push("Secure");
    return attrs.join("; ");
  }

  async function currentSession(request) {
    const id = cookieValue(request, SESSION_COOKIE);
    if (!id || !/^[a-f0-9]{32,64}$/.test(id)) return null;
    const session = await store.getSession(id);
    if (!session) return null;
    if (session.expires_at < now()) {
      await store.deleteSession(id);
      return null;
    }
    await store.touchSession(id, now());
    return session;
  }

  async function readJson(request) {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > BODY_MAX_BYTES) return { ok: false, code: "body-too-large", message: `body over ${BODY_MAX_BYTES} bytes` };
    let text;
    try {
      text = await request.text();
    } catch {
      return { ok: false, code: "unreadable-body", message: "could not read the request body" };
    }
    if (text.length > BODY_MAX_BYTES) return { ok: false, code: "body-too-large", message: `body over ${BODY_MAX_BYTES} bytes` };
    if (!text) return { ok: true, value: {} };
    try {
      const value = JSON.parse(text);
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, code: "bad-json", message: "body must be a JSON object" };
      }
      return { ok: true, value };
    } catch {
      return { ok: false, code: "bad-json", message: "body is not valid JSON" };
    }
  }

  function publicJob(job, goal = job.goal) {
    if (!job) return null;
    return {
      id: job.id,
      created_at: job.created_at,
      updated_at: job.updated_at,
      state: job.state,
      goal,
      verify_cmd: job.verify_cmd,
      model: job.model,
      agent: job.agent ?? "opencode",
      timeout_sec: job.timeout_sec,
      max_attempts: job.max_attempts,
      attempt_count: job.attempt_count,
      allow_external: job.allow_external === 1,
      approved_at: job.approved_at,
      approved_by: job.approved_by,
      cancel_requested: job.cancel_requested === 1,
      cost_usd: job.cost_usd,
      tokens_total: job.tokens_total,
      run_id: job.run_id,
      run_url: job.run_url,
      artifact_name: job.artifact_name,
      verification: job.verification ? JSON.parse(job.verification) : null,
      last_error: job.last_error,
      finished_at: job.finished_at,
      repo: job.repo,
      workflow: job.workflow,
    };
  }

  function publicAttempt(attempt) {
    let metrics = null;
    if (attempt.metrics) {
      try {
        metrics = JSON.parse(attempt.metrics);
      } catch {
        metrics = { source: "unreadable", note: "stored metrics could not be parsed" };
      }
    }
    return {
      id: attempt.id,
      n: attempt.n,
      state: attempt.state,
      marker: attempt.marker,
      created_at: attempt.created_at,
      dispatched_at: attempt.dispatched_at,
      heartbeat_at: attempt.heartbeat_at,
      run_id: attempt.run_id,
      run_url: attempt.run_url,
      conclusion: attempt.conclusion,
      artifact_name: attempt.artifact_name,
      error: attempt.error,
      metrics,
    };
  }

  async function route(request, url) {
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();
    const parts = path.split("/").filter(Boolean);

    if (path === "/healthz") {
      return jsonResponse({ ok: true, service: "opencode-24-7-controller", time: now(), version: config.version ?? "2e" });
    }

    // ---- attempts report: token auth, advisory only -----------------------
    if (parts[0] === "api" && parts[1] === "attempts" && parts[3] === "report" && method === "POST") {
      const parsed = await readJson(request);
      if (!parsed.ok) return errorResponse(400, parsed.code, parsed.message);
      const token = parsed.value.token ?? request.headers.get("x-oc24-attempt-token") ?? "";
      const result = await engine.report(parts[2], token, parsed.value);
      if (!result.ok) return errorResponse(result.code === "bad-token" ? 401 : 404, result.code, result.message);
      return jsonResponse(result);
    }

    // ---- session ---------------------------------------------------------
    if (path === "/api/session" && method === "POST") {
      const ip = clientIp(request);
      const bucket = `${dayKey(now())}T${now().slice(11, 13)}`;
      const attempts = await store.bumpCounter(`login:${ip}`, 1, bucket);
      if (attempts > LOGIN_MAX_PER_HOUR) {
        return errorResponse(429, "rate-limited", `too many login attempts (${LOGIN_MAX_PER_HOUR}/hour)`);
      }
      const parsed = await readJson(request);
      if (!parsed.ok) return errorResponse(400, parsed.code, parsed.message);
      const given = typeof parsed.value.token === "string" ? parsed.value.token : "";
      if (!(await tokenMatches(adminToken, given))) {
        await store.appendEvent({ kind: "login-failed", message: `bad admin token from ${ip}`, at: now() });
        return errorResponse(401, "bad-token", "invalid admin token");
      }
      await store.deleteExpiredSessions(now());
      const id = randHex(32);
      const expires = new Date(Date.parse(now()) + SESSION_TTL_SEC * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
      await store.createSession({ id, created_at: now(), expires_at: expires, ip });
      await store.appendEvent({ kind: "login", message: `session opened from ${ip}`, at: now() });
      return jsonResponse({ ok: true, expires_at: expires }, 200, { "set-cookie": sessionCookie(id, request, SESSION_TTL_SEC) });
    }

    const session = await currentSession(request);
    const authed = Boolean(session);

    if (path === "/api/session" && method === "DELETE") {
      const id = cookieValue(request, SESSION_COOKIE);
      if (id) await store.deleteSession(id);
      return jsonResponse({ ok: true }, 200, { "set-cookie": sessionCookie("", request, 0) });
    }

    // ---- static dashboard ------------------------------------------------
    if (method === "GET" && ["/", "/index.html", "/app.js", "/style.css"].includes(path)) {
      const name = path === "/" || path === "/index.html" ? "index" : path === "/app.js" ? "appJs" : "styleCss";
      const body = assets[name];
      if (!body) return errorResponse(404, "asset-missing", `${path} is not bundled with this controller`);
      const type = name === "index" ? "text/html; charset=utf-8" : path === "/app.js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": type,
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
      });
    }

    if (!path.startsWith("/api/")) return errorResponse(404, "not-found", `no route for ${method} ${path}`);
    if (!authed) {
      return errorResponse(401, "unauthorized", "sign in first (POST /api/session with the admin token)");
    }

    // ---- jobs ------------------------------------------------------------
    if (path === "/api/jobs" && method === "GET") {
      const state = url.searchParams.get("state");
      const q = searchTerm(url.searchParams.get("q"));
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
      const before = url.searchParams.get("before") || null;
      const filter = { state: state && state !== "all" ? state : null, q, before, limit, offset };
      const jobs = await store.listJobs(filter);
      const total = await store.countJobs(filter);
      const goals = await Promise.all(jobs.map((job) => engine.openGoal(job)));
      return jsonResponse({
        jobs: jobs.map((job, i) => publicJob(job, goals[i])),
        limit,
        offset,
        count: jobs.length,
        total,
        has_more: offset + jobs.length < total,
        state: state ?? "all",
        q,
      });
    }

    if (path === "/api/jobs" && method === "POST") {
      const parsed = await readJson(request);
      if (!parsed.ok) return errorResponse(400, parsed.code, parsed.message);
      const result = await engine.createJob(parsed.value, { actor: `api:${clientIp(request)}` });
      if (!result.ok) {
        const status = result.code === "daily-job-cap" ? 429 : 400;
        return errorResponse(status, result.code, result.message);
      }
      return jsonResponse({ ok: true, job: publicJob(result.job, await engine.openGoal(result.job)) }, 201);
    }

    if (parts[0] === "api" && parts[1] === "jobs" && parts[2]) {
      const id = parts[2];
      if (parts.length === 3 && method === "GET") {
        const view = await engine.jobView(id);
        if (!view) return errorResponse(404, "not-found", `no job ${id}`);
        return jsonResponse({
          job: publicJob(view.job, await engine.openGoal(view.job)),
          attempts: view.attempts.map(publicAttempt),
          events: view.events.map((e) => ({
            seq: e.seq,
            at: e.at,
            kind: e.kind,
            message: e.message,
            attempt_id: e.attempt_id,
            data: e.data ? JSON.parse(e.data) : null,
          })),
        });
      }
      if (parts.length === 4 && method === "POST") {
        const action = parts[3];
        const parsed = await readJson(request);
        if (!parsed.ok) return errorResponse(400, parsed.code, parsed.message);
        const actor = `api:${clientIp(request)}`;
        const result =
          action === "cancel"
            ? await engine.requestCancel(id, { actor })
            : action === "approve"
              ? await engine.approveJob(id, { actor })
              : action === "resolve"
                ? await engine.resolveUnknown(id, { outcome: parsed.value.outcome, actor, note: parsed.value.note ? truncate(String(parsed.value.note), 300) : null })
                : null;
        if (!result) return errorResponse(404, "no-action", `unknown job action "${redact(action)}"`);
        if (!result.ok) {
          const status = result.code === "not-found" ? 404 : result.code === "already-finished" ? 409 : 400;
          return errorResponse(status, result.code, result.message);
        }
        return jsonResponse({ ok: true, job: publicJob(result.job, await engine.openGoal(result.job)), note: result.note ?? null });
      }
    }

    // ---- controller operations ------------------------------------------
    if (path === "/api/tick" && method === "POST") {
      const result = await engine.tick();
      return jsonResponse({ ok: true, ...result });
    }

    if (path === "/api/stats" && method === "GET") {
      const stats = await store.stats(now());
      const events = await store.eventStats();
      return jsonResponse({
        ...stats,
        events,
        caps: {
          max_jobs_per_day: config.maxJobsPerDay,
          max_dispatch_per_day: config.maxDispatchPerDay,
          max_concurrent: config.maxConcurrent,
          max_cost_usd: config.maxCostUsd,
        },
        retention: {
          events_days: engine.config.eventRetentionDays,
          goals_days: engine.config.goalRetentionDays,
        },
        goal_storage: engine.config.goalKey ? "encrypted" : "plain",
        agents: agentList({ freeModels: config.freeModels }),
        repo: config.repo,
        workflow: config.workflow,
        ref: config.ref,
        controller_url: config.controllerUrl,
        github_token: config.githubConfigured ? "configured" : "missing",
        free_models: config.freeModels,
      });
    }

    if (path === "/api/config" && method === "GET") {
      return jsonResponse({
        repo: config.repo,
        ref: config.ref,
        workflow: config.workflow,
        controller_url: config.controllerUrl,
        free_models: config.freeModels,
        agents: agentList({ freeModels: config.freeModels }),
        goal_storage: engine.config.goalKey ? "encrypted" : "plain",
        caps: {
          maxJobsPerDay: config.maxJobsPerDay,
          maxDispatchPerDay: config.maxDispatchPerDay,
          maxConcurrent: config.maxConcurrent,
          maxCostUsd: config.maxCostUsd,
        },
        github: config.githubConfigured ? "configured" : "missing",
      });
    }

    return errorResponse(404, "not-found", `no route for ${method} ${path}`);
  }

  async function handle(request) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse(400, "bad-url", "unparsable request URL");
    }
    try {
      return await route(request, url);
    } catch (e) {
      // Never leak internals (or a token) to the client; keep the detail in a
      // redacted event so the operator can see what happened.
      const message = redact(truncate(e?.stack ?? e?.message ?? String(e), 2000));
      try {
        await store.appendEvent({ kind: "unhandled-error", message: `${request.method} ${url.pathname}: ${message}`, at: now() });
      } catch {
        /* logging must never mask the original failure */
      }
      return errorResponse(500, "internal-error", "the controller failed to handle this request; see the event log");
    }
  }

  return { handle };
}
