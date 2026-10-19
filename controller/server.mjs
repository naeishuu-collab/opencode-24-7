#!/usr/bin/env node
// Local / self-hosted controller entry point.
//
//   OC24_ADMIN_TOKEN=<secret> OC24_REPO=owner/name [OC24_GITHUB_TOKEN=<pat>] \
//     node controller/server.mjs
//
// The same app runs in a Cloudflare Worker (controller/worker.mjs); this file
// only bridges Node's http server to the fetch-style handler, serves the
// dashboard from web/ and runs the tick loop.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.mjs";
import { createEngine } from "./lib/engine.mjs";
import { createGithub } from "./lib/github.mjs";
import { createSqliteExecutor, createStore } from "./lib/store.mjs";
import { clampInt, redact } from "./lib/util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

export function loadConfig(env = process.env) {
  const freeModels = JSON.parse(fs.readFileSync(path.join(ROOT, "runner", "config", "free-models.json"), "utf8")).models;
  const repo = env.OC24_REPO ?? "naeishuu-collab/opencode-24-7";
  return {
    adminToken: env.OC24_ADMIN_TOKEN ?? null,
    githubToken: env.OC24_GITHUB_TOKEN ?? null,
    githubApiBase: env.OC24_GITHUB_API ?? "https://api.github.com",
    repo,
    ref: env.OC24_REF ?? "main",
    workflow: env.OC24_WORKFLOW ?? "agent-job.yml",
    controllerUrl: env.OC24_CONTROLLER_URL || null,
    dbPath: env.OC24_DB_PATH ?? path.join(ROOT, "controller", "data", "controller.db"),
    host: env.OC24_HOST ?? "127.0.0.1",
    port: clampInt(env.OC24_PORT, 0, 65535, 8787),
    tickSeconds: clampInt(env.OC24_TICK_SECONDS, 5, 3600, 60),
    tickEnabled: (env.OC24_TICK ?? "1") !== "0",
    maxJobsPerDay: clampInt(env.OC24_MAX_JOBS_PER_DAY, 1, 500, 50),
    maxDispatchPerDay: clampInt(env.OC24_MAX_DISPATCH_PER_DAY, 1, 200, 20),
    maxConcurrent: clampInt(env.OC24_MAX_CONCURRENT, 1, 10, 2),
    maxCostUsd: Number(env.OC24_MAX_COST_USD ?? 0),
    leaseSec: clampInt(env.OC24_LEASE_SEC, 60, 86400, 900),
    noRunGraceSec: clampInt(env.OC24_NO_RUN_GRACE_SEC, 300, 86400, 1800),
    freeModels,
  };
}

export function summarizeConfig(config) {
  return {
    repo: config.repo,
    ref: config.ref,
    workflow: config.workflow,
    controller_url: config.controllerUrl ?? "(unset: in-cloud runners cannot report back)",
    db: config.dbPath,
    github_api: config.githubApiBase ?? "https://api.github.com",
    listen: `${config.host}:${config.port}`,
    tick_enabled: config.tickEnabled,
    tick_seconds: config.tickSeconds,
    admin_token: config.adminToken ? "configured" : "MISSING (server will refuse to start)",
    github_token: config.githubToken ? "configured" : "missing (dispatch disabled, jobs stay queued)",
    caps: {
      jobs_per_day: config.maxJobsPerDay,
      dispatches_per_day: config.maxDispatchPerDay,
      concurrent: config.maxConcurrent,
      max_cost_usd: config.maxCostUsd,
    },
    free_models: config.freeModels.length,
  };
}

export async function buildController(config = loadConfig(), { fetchImpl = globalThis.fetch } = {}) {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const store = await createStore(await createSqliteExecutor(config.dbPath)).init();
  const github = createGithub({
    token: config.githubToken,
    repo: config.repo,
    fetchImpl,
    apiBase: config.githubApiBase ?? "https://api.github.com",
  });
  const engine = createEngine({
    store,
    github,
    config: {
      repo: config.repo,
      ref: config.ref,
      workflow: config.workflow,
      freeModels: config.freeModels,
      maxConcurrent: config.maxConcurrent,
      maxDispatchPerDay: config.maxDispatchPerDay,
      maxJobsPerDay: config.maxJobsPerDay,
      maxCostUsd: config.maxCostUsd,
      controllerUrl: config.controllerUrl,
      leaseSec: config.leaseSec,
      noRunGraceSec: config.noRunGraceSec,
    },
  });
  const assets = {
    index: fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8"),
    appJs: fs.readFileSync(path.join(ROOT, "web", "app.js"), "utf8"),
    styleCss: fs.readFileSync(path.join(ROOT, "web", "style.css"), "utf8"),
  };
  const app = createApp({
    store,
    engine,
    assets,
    config: { ...config, githubConfigured: Boolean(config.githubToken) },
  });
  return { store, engine, app, config };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

export async function startServer(config = loadConfig()) {
  const { store, engine, app } = await buildController(config);
  const server = http.createServer(async (req, res) => {
    let response;
    try {
      const body = await readBody(req);
      const host = req.headers.host ?? `${config.host}:${config.port}`;
      const request = new Request(`http://${host}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body,
        ...(body ? { duplex: "half" } : {}),
      });
      response = await app.handle(request);
    } catch (e) {
      response = new Response(JSON.stringify({ error: "bridge-error", message: redact(e.message) }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    const headers = {};
    for (const [k, v] of response.headers) headers[k] = v;
    res.writeHead(response.status, headers);
    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
  });

  const timer = config.tickEnabled
    ? setInterval(() => {
        engine.tick().catch((e) => console.error(`[tick] ${redact(e.message)}`));
      }, config.tickSeconds * 1000)
    : null;
  timer?.unref?.();

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  const port = server.address().port;
  const url = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${port}`;
  // A single machine-readable line so tests and supervisors can find the port.
  console.log(JSON.stringify({ listening: true, url, ...summarizeConfig({ ...config, port }) }));

  if (config.tickEnabled) engine.tick().catch((e) => console.error(`[tick] ${redact(e.message)}`));

  const close = async () => {
    if (timer) clearInterval(timer);
    await new Promise((resolve) => server.close(resolve));
    await store.close?.();
  };
  return { server, store, engine, app, url, close };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const config = loadConfig();
  if (process.argv.includes("--print-config")) {
    console.log(JSON.stringify(summarizeConfig(config), null, 2));
    process.exit(0);
  }
  if (!config.adminToken) {
    console.error("OC24_ADMIN_TOKEN is required; refusing to start an unauthenticated controller");
    process.exit(1);
  }
  const { close } = await startServer(config);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      close().then(() => process.exit(0));
    });
  }
}
