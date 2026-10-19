# Phase 2D — cloud controller, autonomous loop, dashboard

Status: **implemented and tested locally (Node + SQLite), deploy-gated for
Cloudflare.** Everything below was executed; items that were not are listed under
[Unverified](#unverified).

## What this phase adds

| piece | file(s) | state |
| --- | --- | --- |
| Job API + queue + state machine | `controller/lib/engine.mjs`, `controller/app.mjs` | implemented, tested |
| SQL store (SQLite locally, D1 in the cloud) | `controller/lib/store.mjs` | implemented, tested on both call shapes |
| GitHub Actions dispatch + run polling + artifact verification | `controller/lib/github.mjs`, `controller/lib/zip.mjs` | implemented, tested against a fake API over real HTTP |
| Local/self-hosted server + tick loop | `controller/server.mjs` | implemented, tested as a child process |
| Cloudflare Worker + Cron Trigger + D1 binding | `controller/worker.mjs`, `wrangler.toml` | implemented, **not deployed** (no CF account) |
| Dashboard (real data, mobile, dark mode) | `web/index.html`, `web/app.js`, `web/style.css` | implemented, driven in a real browser |
| Runner advisory reporting (heartbeat/result) | `runner/lib/report.mjs` | implemented, tested end-to-end |

The agent still has no write access to anything: `contents: read`, no push, no PR,
no deploy. A job produces a diff artifact that a human applies. That is a
deliberate boundary, not a missing feature.

## Architecture

```
        browser (dashboard, session cookie)
                    |
   +----------------v-----------------+          +----------------------+
   | controller  (app.mjs, one fetch  |  dispatch | GitHub Actions       |
   | handler, two runtimes)           +---------->| agent-job.yml        |
   |                                  |           |  runner/run-job.mjs  |
   |  engine.mjs  job state machine   |  poll     |  (contents: read)    |
   |  store.mjs   SQL (SQLite | D1)   |<----------|                      |
   |  github.mjs  REST client         |  artifact |  uploads job.json +  |
   |  zip.mjs     artifact reader     |  download |  diff.patch          |
   +----------------------------------+           +----------------------+
      ^              ^
      |              |
  Cron Trigger    runner report (advisory, optional)
  (worker) or     POST /api/attempts/:id/report
  POST /api/tick
```

One request handler, one state machine, one store — two runtimes:

* `controller/server.mjs` — Node http + `node:sqlite`, used locally, in tests and
  by anyone who wants a self-hosted controller.
* `controller/worker.mjs` — Cloudflare Worker `fetch` + `scheduled` (Cron
  Trigger), D1 as the store. Same `app.mjs`, same `engine.mjs`, same SQL.

## Job state machine

| state | meaning | who sets it |
| --- | --- | --- |
| `awaiting_approval` | the goal implies an external effect (push/PR/deploy) | `createJob` when `allow_external` |
| `queued` | ready to dispatch | creation, approval, `resolve(retry)`, safe re-queue |
| `running` | a workflow run exists (linked or about to be) | dispatch accepted, or run adopted by marker |
| `succeeded` | run `success` **and** artifact contract passed | `contractCheck` |
| `failed` | run failed, or the artifact contradicts the policy | `finalizeFromRun` |
| `cancelled` | cancelled by a human, confirmed by the API | cancel path |
| `unknown` | the result cannot be established | unconfirmed dispatch, missing/corrupt artifact |

`unknown` is a terminal state for the machine — it moves only when a human calls
`POST /api/jobs/:id/resolve` (`retry` / `succeeded` / `failed`).

### The six rules that make double execution unlikely

1. **Attempt row before the call.** The row (with marker and token hash) is
   written before `workflow_dispatch`, so a crash mid-call leaves evidence
   instead of a silent retry.
2. **Definite failures do not consume the attempt budget.** A `422`/`404`/`401`
   produced no run: the attempt row is deleted and the job stays `queued`.
3. **Rate limits hold, they do not fail.** `429`/`403+remaining:0` sets a pause
   (`dispatch_pause_until`) so the controller never hammers the API.
4. **Indefinite failures become `unknown`.** Network error, timeout or `5xx` may
   or may not have started a run, so nothing is retried automatically.
5. **Prove-then-retry.** After a grace period (`OC24_NO_RUN_GRACE_SEC`, default
   30 min) the controller searches workflow runs for the attempt's unique marker:
   * a run exists → it is **adopted** (never re-dispatched, never re-run);
   * no run exists → nothing was executed, so the job may be re-queued safely;
   * no attempt budget left → the job is closed as `failed`.
6. **The verdict comes from the artifact.** The agent's own claim (and any
   runner report) can never set a state; only the uploaded `job.json` plus the
   run conclusion can.

Leases: every attempt carries `lease_expires_at` (default 900 s, `OC24_LEASE_SEC`).
A `dispatching` attempt whose lease expires becomes `unknown` — the crashed-dispatch
path is tested.

## Independent verification (artifact contract)

`contractCheck()` fails a job unless the artifact proves all of this:

| check | why |
| --- | --- |
| `schema === 1` | the artifact is a file this controller understands |
| `status === "success"` | the runner's own verdict |
| `usage.costUsd <= OC24_MAX_COST_USD` (default 0) | a paid run is never accepted, even if everything else looks fine |
| `costPolicy.modelAllowlisted === true` | the run really used an allowlisted free model |
| `model === job.model` | the executed model is the requested one |
| `target.commitBefore === target.commitAfter` | the run was read-only — no commit happened |
| `verification.status === "passed"` and the same command (when `verify_cmd` was set) | the run's test evidence is present and matches the request |

A run that succeeded but produced no readable artifact is `unknown` (safe stop),
never a success. Artifacts larger than 32 MB, zip64 archives and unknown
compression methods are refused with a reason.

## Free-tier math and terms of service

| resource | free limit (docs) | how this design stays inside it |
| --- | --- | --- |
| GitHub Actions (public repo) | unlimited minutes for the owning repo; 6 h/job; `schedule` minimum 5 min, best-effort; schedules auto-disable after 60 days without repo activity | jobs are dispatched on demand, `timeout-minutes: 90`, caps `OC24_MAX_DISPATCH_PER_DAY` (default 20) and `OC24_MAX_CONCURRENT` (default 2) |
| Cloudflare Workers (free) | 100k requests/day, 10 ms CPU/request, 128 MB | the worker only serves the dashboard/API and one tick per cron slot (288/day at `*/5`) |
| Cloudflare D1 (free) | 5 M rows read/day, 100k rows written/day, 5 GB | a tick writes a handful of rows; events are the only append-heavy table |
| Cloudflare Cron Triggers | included on the free plan | the scheduler; `wrangler.toml` sets `*/5 * * * *` |
| Model | OpenCode Console free models ("free for a limited time") | `runner/config/free-models.json` allowlist, `--max-cost-usd 0`, controller-side cost contract |

Rules that are respected on purpose: one GitHub account, one Cloudflare account,
no infinite restart loops, no resident-process tricks, no use of another
repository's free minutes. The controller fails closed (`429`, `unknown`, pause)
rather than retrying until something breaks.

**What is *not* guaranteed by a free tier**, stated plainly:

* 24 h *reachable control plane* (dashboard + API) — that is what the worker gives.
* 24 h *continuous AI compute* is **not** guaranteed: hosted runners queue, cron is
  best-effort and can be delayed, the free model can be withdrawn, and a
  Cloudflare worker that is only triggered on a schedule does not compute while
  idle. The system is built to hold work safely (`queued`, `unknown`, pause)
  rather than to pretend the compute is always there.
* A public-repo `schedule:` workflow is disabled after 60 days of repository
  inactivity; a commit (or a manual run) resets that timer.

## Running it

Local (no account needed, real GitHub API optional):

```bash
export OC24_ADMIN_TOKEN=<long random token>      # required, the server refuses to start without it
export OC24_REPO=<owner>/<repo>
export OC24_GITHUB_TOKEN=<fine-grained token>    # optional: without it dispatch stays disabled
export OC24_DB_PATH=./controller/data/controller.db
node controller/server.mjs
# open http://127.0.0.1:8787 and sign in with the admin token
node controller/server.mjs --print-config        # effective settings, tokens never printed
```

Cloudflare (free plan, needs your account - not done here):

```bash
wrangler d1 create oc24-controller               # paste database_id into wrangler.toml
wrangler secret put OC24_ADMIN_TOKEN             # dashboard/admin auth
wrangler secret put OC24_GITHUB_TOKEN            # dispatch + run polling (fine-grained, actions:write on this repo only)
wrangler deploy
# then set OC24_CONTROLLER_URL in wrangler.toml [vars] and redeploy so runners can report back
```

## Security model

| boundary | mechanism |
| --- | --- |
| API auth | session cookie from the admin token (`SHA-256` + constant-time compare), `HttpOnly`, `SameSite=Strict`, `Secure` on https, 12 h TTL, 10 logins/hour/IP |
| dashboard XSS | no inline script/style, `default-src 'none'` CSP, all data inserted via `textContent` |
| GitHub token | never logged, never in an artifact; the controller's own requests are the only place it appears |
| agent permissions | `contents: read`; a push attempt is denied by policy and the workflow re-proves `"push": false` on every run |
| attempt token | deliberately **not** a secret (it travels as a workflow input). It only authorises an advisory report for one attempt; a report cannot change a job's state |
| untrusted input | goal text, artifact content and reports are data. The verdict comes from `contractCheck` against the controller's own record of the job |
| store growth | events are the only unbounded table; see Known gaps |

## Verification status

Executed:

* `node --test "tests/*.test.mjs"` — **76 tests, 73 pass, 0 fail, 3 skipped**
  (skips are the real-model integration tests) on Windows (node 24.21) and on
  Ubuntu/WSL2 (node 22.22).
* `tests/controller.test.mjs` — 34 tests: store reopen, validation and caps,
  contract check, zip reader, dispatch/verify/cancel/unknown paths, rate limit,
  concurrency and daily caps, tick lock, token hygiene, HTTP auth, dashboard CSP,
  unhandled-error redaction.
* `tests/controller-e2e.test.mjs` — 9 tests against a **real child process**:
  full job loop, self-ticking loop with no manual calls, restart recovery after a
  hard kill, no duplicate dispatch across a restart, two controllers on one
  database, free-tier caps, D1 call shape.
* `tests/report.test.mjs` — 2 tests: a real runner process reporting to a real
  controller server (metrics stored as `runner-report`, job state unchanged), and
  a dead report target that never fails the job and never leaks the token.
* **Real dispatch E2E (2026-10-19, public repo, free tier only).** A local
  controller (tick loop on, no manual calls) created a job through the HTTP API.
  Its own tick dispatched `agent-job.yml` at `117594b` via `workflow_dispatch`
  (run [`39263425059`](https://github.com/naeishuu-collab/opencode-24-7/actions/runs/39263425059)),
  matched the run by marker through `run-name`, downloaded the artifact
  (`oc24-job-39263425059`, 9,609 bytes) and verified the runner's `job.json`
  independently: model allowlisted, `costUsd 0`, 5 steps, 30,836 tokens,
  `npm test` exit 0, `commitBefore == commitAfter` (no commit), one changed path.
  The job reached `succeeded` 72 s after creation, with `artifacts: 1`,
  `event: workflow_dispatch` and `head_sha: 117594b` confirmed through the GitHub
  API; the dashboard showed the same state from `/api/stats`.

### Unverified

* **Cloudflare deployment.** No CF account: the worker entry, D1 binding, cron
  trigger and the 10 ms CPU/request budget are untested in the real runtime. The
  shared code path is tested through the D1 call shape, but only deployment can
  prove the rest. The Node controller path is proven end-to-end against real
  GitHub; only the Cloudflare-hosted variant of that path is unproven.
* Sustained load: many jobs per day, artifact growth, D1 row quotas, a full day
  of cron ticks.
* A callback from a **cloud** runner to the controller (needs a public controller
  URL, i.e. the deployment above).
* GitHub Enterprise / organisation-level policies; the controller assumes
  `api.github.com`.
* Real cost-stop behaviour: no paid model was ever used, so the "$0 refusal" is
  proven only against synthetic artifacts.

### Known gaps

* Events are never pruned; a long-lived controller should add a retention job
  (e.g. delete events older than 30 days) before it runs for months.
* Job goals are stored verbatim in D1/SQLite; they can contain anything a human
  typed. The dashboard escapes them, but they are not encrypted at rest.
* The dashboard is a single page without pagination beyond the API's `limit`.
* `wrangler.toml` pins `compatibility_date = 2025-09-01`; re-check it when
  actually deploying.
