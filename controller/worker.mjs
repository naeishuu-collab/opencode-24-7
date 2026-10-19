// Cloudflare Worker entry point (free plan: Workers + D1 + Cron Triggers).
//
//   wrangler d1 create oc24-controller        -> put the id into wrangler.toml
//   wrangler secret put OC24_ADMIN_TOKEN      -> dashboard/admin auth
//   wrangler secret put OC24_GITHUB_TOKEN     -> workflow dispatch + run polling
//   wrangler deploy
//
// The request handling, state machine and verification code is identical to
// the Node server; only the store executor (D1) and the asset imports differ.
import indexHtml from "../web/index.html";
import appJs from "../web/app.js";
import styleCss from "../web/style.css";
import freeModelsJson from "../runner/config/free-models.json";
import { createApp } from "./app.mjs";
import { createEngine } from "./lib/engine.mjs";
import { createGithub } from "./lib/github.mjs";
import { createD1Executor, createStore } from "./lib/store.mjs";
import { clampInt } from "./lib/util.mjs";

let cached = null;

export function workerConfig(env) {
  return {
    adminToken: env.OC24_ADMIN_TOKEN ?? null,
    githubToken: env.OC24_GITHUB_TOKEN ?? null,
    repo: env.OC24_REPO ?? "naeishuu-collab/opencode-24-7",
    ref: env.OC24_REF ?? "main",
    workflow: env.OC24_WORKFLOW ?? "agent-job.yml",
    controllerUrl: env.OC24_CONTROLLER_URL || null,
    agent: env.OC24_AGENT ?? "opencode",
    goalKey: env.OC24_GOAL_KEY || null,
    eventRetentionDays: clampInt(env.OC24_EVENT_RETENTION_DAYS, 0, 3650, 30),
    goalRetentionDays: clampInt(env.OC24_GOAL_RETENTION_DAYS, 0, 3650, 0),
    maxJobsPerDay: clampInt(env.OC24_MAX_JOBS_PER_DAY, 1, 500, 50),
    maxDispatchPerDay: clampInt(env.OC24_MAX_DISPATCH_PER_DAY, 1, 200, 20),
    maxConcurrent: clampInt(env.OC24_MAX_CONCURRENT, 1, 10, 2),
    // D1 free allows 50 queries per invocation: a cron tick must stay well under
    // it, so the cloud defaults poll fewer runs and dispatch one job per tick.
    maxPollsPerTick: clampInt(env.OC24_MAX_POLLS_PER_TICK, 1, 20, 5),
    maxDispatchesPerTick: clampInt(env.OC24_MAX_DISPATCHES_PER_TICK, 1, 5, 1),
    maxCostUsd: Number(env.OC24_MAX_COST_USD ?? 0),
    leaseSec: clampInt(env.OC24_LEASE_SEC, 60, 86400, 900),
    noRunGraceSec: clampInt(env.OC24_NO_RUN_GRACE_SEC, 300, 86400, 1800),
    freeModels: freeModelsJson.models,
  };
}

export async function buildWorkerApp(env, { fetchImpl = globalThis.fetch } = {}) {
  const config = workerConfig(env);
  if (config.goalKey && config.goalKey.length < 16) {
    // Same fail-closed rule as the Node server: never encrypt with a weak key.
    throw new Error("OC24_GOAL_KEY must be at least 16 characters");
  }
  const store = await createStore(createD1Executor(env.DB)).init();
  const github = createGithub({ token: config.githubToken, repo: config.repo, fetchImpl });
  const engine = createEngine({
    store,
    github,
    config: { ...config, defaultAgent: config.agent, defaultWorkflow: config.workflow },
  });
  const app = createApp({
    store,
    engine,
    config: { ...config, githubConfigured: Boolean(config.githubToken) },
    assets: { index: indexHtml, appJs, styleCss },
  });
  return { app, engine, store, config };
}

async function get(env) {
  if (!cached) cached = await buildWorkerApp(env);
  return cached;
}

export default {
  async fetch(request, env) {
    const { app } = await get(env);
    return app.handle(request);
  },

  // Cron Trigger: the free-plan scheduler. Drains queued work, polls running
  // runs, applies leases and finalises finished runs.
  async scheduled(event, env) {
    const { engine } = await get(env);
    const out = await engine.tick();
    console.log(
      JSON.stringify({
        cron: event.cron,
        at: out.at,
        dispatched: out.dispatched.length,
        finalized: out.finalized.length,
        pruned_events: out.maintenance?.pruned_events ?? 0,
      }),
    );
    return out;
  },
};
