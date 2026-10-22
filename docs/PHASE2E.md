# Phase 2E — Cloud integration, retention, agent adapters, soak

Phase 2D built the controller, the state machine and independent artifact
verification. Phase 2E makes it fit the free cloud for real: it sizes the tick
to D1's per-invocation query cap, adds retention and goal encryption, introduces
an agent adapter boundary, and adds a soak harness that produces an honest 24 h
verdict instead of a claim.

## What changed

| area | change |
| --- | --- |
| D1 / free plan | `maxPollsPerTick` 5 and `maxDispatchesPerTick` 1 in the Worker; a regression test pins a tick to **<= 45 statements** (D1 Free allows 50 per invocation). Event pruning is batched. |
| retention | `engine.maintenance()` runs from the same tick (Node interval and Cloudflare cron), at most once per 6 h: expired sessions, events older than `OC24_EVENT_RETENTION_DAYS` (30), finished goals older than `OC24_GOAL_RETENTION_DAYS` (0 = keep). |
| pagination/search | `GET /api/jobs?state=&q=&limit=&offset=&before=` returns `total` and `has_more`; the dashboard has search, paging and a state filter. Search terms are truncated to 40 bytes (D1's LIKE pattern cap is 50). |
| goal confidentiality | `OC24_GOAL_KEY` (>= 16 chars) stores goals as AES-256-GCM ciphertext (`enc1.<iv>.<ct>`); a session gets the plaintext, the database never does. Missing/wrong key fails closed with a readable marker. |
| agent adapters | `controller/lib/agents.mjs`: OpenCode is available; Codex CLI, Claude Code and Gemini CLI are declared but `available: false` and are rejected at creation. An adapter only names its workflow, its runner secret and its limits. |
| D1 prep | `migrations/0001_schema.sql`, `migrations_dir` in `wrangler.toml`, `npm run d1:init:local|remote`, `npm run deploy`. |
| dashboard | agent selector (unavailable agents disabled with the reason), search, paging, event count, goal-storage indicator, retention in the footer. No fabricated rows. |
| soak | `tools/soak.mjs` + `.github/workflows/soak.yml` (dispatch-only until approved): slices, SIGKILL restarts, invariant checks, an accumulated runtime in the Actions cache, and a `soak-report.json`. |

## Cloudflare free plan (official docs, checked 2026-10-20)

**Workers Free**

| limit | value | consequence for this project |
| --- | --- | --- |
| requests | 100,000/day | cron `*/5` = 288/day; dashboard traffic is tiny |
| CPU per request / cron | 10 ms | the tick is I/O bound (D1 + GitHub); no heavy compute |
| cron wall time | 15 min | a tick takes seconds |
| cron triggers | 5/account | one |
| subrequests | 50/request | a tick: 1 run list + up to 5 polls + 1 dispatch + 1 artifact download |
| memory | 128 MB | artifact cap is 32 MB |
| variables | 64/worker, 5 KB each | ~12 used |

**D1 Free**

| limit | value | consequence |
| --- | --- | --- |
| database size | 500 MB (account 5 GB) | events are pruned; logs/diffs live in artifacts, not D1 |
| queries per Worker invocation | **50** | tick defaults: 5 polls, 1 dispatch, statement-count test |
| row size | 2 MB | metrics are truncated to 40 KB |
| SQL statement | 100 KB | fine |
| LIKE pattern | **50 bytes** | `q` is truncated to 40 bytes |
| bound parameters | 100 | fine |
| query duration | 30 s | indexed lookups |

Both products stay on the free plan unless the account is explicitly upgraded;
this repository never enables a paid feature, and `OC24_MAX_COST_USD=0` keeps the
model side free as well.

## Deployment runbook (deployed 2026-10-19)

The free plan was deployed and exercised for real; this is what it took.

```sh
wrangler login                                   # account owner (OAuth, expires in ~1 h)
wrangler whoami                                  # confirm the account
wrangler d1 create oc24-controller               # database_id below
#   put database_id into wrangler.toml
npx wrangler d1 execute oc24-controller --file migrations/0001_schema.sql --remote -y
npx wrangler secret put OC24_ADMIN_TOKEN         # long random string, read from stdin
npx wrangler secret put OC24_GOAL_KEY            # >= 16 chars, no way to recover it
npx wrangler secret put OC24_GITHUB_TOKEN        # fine-grained PAT: actions:write, contents:read
npx wrangler deploy
```

Live values:

| item | value |
| --- | --- |
| worker | `https://oc24-controller.naeishuu.workers.dev` |
| D1 | `oc24-controller`, `49efd2f8-a70b-4814-8f15-ff4e1fb35b68`, APAC (KIX) |
| cron | `*/5 * * * *` (Workers Cron Triggers, free plan) |
| secrets | `OC24_ADMIN_TOKEN`, `OC24_GOAL_KEY` (both random, generated locally) |
| `OC24_GITHUB_TOKEN` | **not set** - creating a least-privilege fine-grained PAT needs the account owner in the browser; until then the worker stores jobs but cannot dispatch |

Gotchas found during the deploy (all fixed in the code before the final deploy):

* The account had no `workers.dev` subdomain, so `wrangler deploy` refused to
  publish. It was registered once through the API (`naeishuu`); the dashboard
  link in the error message does the same thing.
* `preview_urls` is on by default in wrangler 4 and would publish a second,
  unlisted URL for every version. `wrangler.toml` now sets `preview_urls = false`.
* **Real bug, caught only by the first live request**: D1's `db.exec()` splits its
  input on newlines and runs each line as a statement, so a formatted multi-line
  `CREATE TABLE` fails with `SQLITE_ERROR: incomplete input`. The D1 executor now
  splits on statement boundaries and flattens each statement; the D1 call-shape
  test rejects multi-line `exec` input so it cannot come back.
* A fresh hostname can fail the TLS handshake for the first request or two while
  Cloudflare provisions the certificate; retry before assuming a network block.
* `wrangler login` is an OAuth session with a ~1 h access token. Re-run it before
  a deploy; a long-lived `CLOUDFLARE_API_TOKEN` is the better long-term option.

After deploying, `OC24_CONTROLLER_URL` is set to the workers.dev URL (runner
reports are advisory only) and the worker is verified with:

```sh
curl https://oc24-controller.naeishuu.workers.dev/healthz   # {"ok":true,...,"version":"2e"}
```


## Agent adapters

```js
{
  id: "opencode",
  available: true,
  workflow: "agent-job.yml",       // dispatched for this agent
  authSecret: "OPENCODE_AUTH_JSON", // lives in the workflow, never in the controller
  modelsFrom: "free-models",        // which allowlist applies
  limits: { timeoutSecMax: 3600, maxAttempts: 3 },
}
```

Adding an agent = add an entry, add a workflow that emits the same artifact
contract (`job.json`, `summary.md`, `diff.patch`, `log.txt`), flip `available`.
The controller's state machine, verification, cost policy and retention stay
unchanged, and the controller holds no agent credentials. A job records the
agent it was created with, so an adapter can be added without touching existing
jobs. Unknown and unavailable agents are rejected at creation (`agent-not-found`
/ `agent-unavailable`); there is no fallback.

Codex CLI / Claude Code / Gemini CLI remain unavailable on purpose: their free
tier, authentication and terms have not been verified, which is a precondition
in `docs/FREE-MODELS.md` for this project.

## Goal confidentiality

* Storage: `OC24_GOAL_KEY` derived with SHA-256 -> AES-256-GCM, random 12-byte IV
  per goal, ciphertext prefixed `enc1.`. The key is never written to D1/SQLite.
* Read path: only an authenticated session gets plaintext (`GET /api/jobs`,
  `GET /api/jobs/:id`); logs and artifacts never contain the goal.
* Loss of the key: goals become unreadable (`[encrypted: ...]`), everything else
  (state, runs, verification, costs) remains. There is no recovery by design.
* Limitation: full-text search cannot see encrypted goals; search still matches
  job ids. Pruning goals of old finished jobs (`OC24_GOAL_RETENTION_DAYS`) is the
  complement for databases that keep many jobs.

## Soak harness

`tools/soak.mjs` runs the real controller (child process, SQLite, real GitHub
when a token is present) for a bounded window:

* samples `/healthz` and `/api/stats`; records every observation to
  `evidence.jsonl`
* optionally creates a small number of real jobs across the window
* optionally `SIGKILL`s the controller and restarts it on the same database
  every N minutes (the restart is the recovery test)
* at the end checks: sample availability, attempts vs `attempt_count`, unique
  markers, no attempt past its lease, every success artifact-verified, $0 cost,
  no duplicate run id
* accumulates active minutes and a coverage figure in `state.json`, so a long
  soak can be split into slices

The verdict is deliberately strict: `soak_24h: verified` requires a **24 h
window with >= 98 % measured uptime**. A shorter run reports `pending`, the
window and the coverage. The Actions workflow (`.github/workflows/soak.yml`)
runs one slice per dispatch (a GitHub-hosted job cannot exceed 6 h) and persists
the database and the accumulator in the Actions cache. Slices **chain
themselves**: the last step dispatches the next slice, the `soak` concurrency
group keeps them serialized, and the chain stops when the verdict is `verified`
or after five 300-minute slices (finite test, not a production loop).

## Verification status

Executed locally (Windows 11 / node 24.21 and WSL2 Ubuntu / node 22.22):

* `node --test "tests/*.test.mjs"` — **87 tests, 84 pass, 0 fail, 3 skipped**
  (the skips are the real-model integration tests, run separately in the cloud).
* Phase 2E suite (`tests/phase2e.test.mjs`, 11 tests): agent fail-closed and
  adapter limits, agent in the job/API, pagination totals, id/goal search and
  40-byte truncation, event retention and goal pruning, maintenance throttling,
  encrypted goals absent from the database and present over the API, wrong/missing
  key markers, the **<= 45 statement tick**, and an in-place migration of a
  Phase 2D database.
* Soak smoke (1.2 min, 2 SIGKILL restarts, 3 s sampling): availability 100 %,
  all invariants green, verdict `pending` as designed.
* Real-job soak (6 min, 1 real dispatch, no restarts): controller reachable for
  **18/18 samples**; it dispatched run **39337598363** (`workflow_dispatch`,
  marker `oc24-job-20261019T224828Z-96ca-a1-9ad2`), downloaded and verified the
  artifact, and marked the job `succeeded` - 36,482 tokens, **$0**, 1 attempt,
  no duplicate run id. Verdict `pending` (6 of 1440 min), coverage 100 %.
  Evidence: `runs/soak-real/` (gitignored).
* Soak **workflow** smoke on GitHub-hosted Linux (run `39338006574`, dispatched
  manually with `minutes=1, jobs=0`): the workflow registered, restored/saved the
  cache, ran the controller in the runner, signed in, sampled 2/2, uploaded the
  evidence artifact, and reported `pending`. This validates the workflow file and
  `tools/soak.mjs` on Linux; it is not the 24 h measurement.

Deployed and exercised in the real cloud (2026-10-19, free plan):

* `https://oc24-controller.naeishuu.workers.dev/healthz` -> 200
  `{"ok":true,...,"version":"2e"}`; unauthenticated `/api/jobs` -> 401;
  dashboard -> 200 with CSP; a wrong admin token -> 401 `bad-token`.
* The worker writes to D1 on its own: `schema=2`, `last_maintenance_at` set by
  the `*/5` cron with no local process, and real `job-created` / `login` /
  `maintenance` rows. Over the 2.5 days after the deploy it recorded **10
  maintenance events** (one per 6 h retention run) with the worker never touched
  by hand.
* Free-plan usage after 2.5 days: D1 **86 kB** (limit 500 MB), last 24 h
  **4,784 read queries / 573 write queries / 3,159 rows read / 588 rows
  written** - orders of magnitude inside the free limits.
* Goal confidentiality in the live database: the stored column starts `enc1.`
  while the authenticated API returns the plaintext.
* A job created through the cloud API persists as `queued`; dispatch is blocked
  only by the missing `OC24_GITHUB_TOKEN` (see Known gaps).
* The first request after the deploy failed with `SQLITE_ERROR: incomplete
  input` because D1's `exec()` splits on newlines. Fixed, redeployed and
  re-verified; the D1 call-shape test now rejects multi-line `exec` input.

24 h soak (measured, not claimed):

* 9 scheduled slices, `2026-10-19T22:53Z` -> `2026-10-22T05:33Z` (3280 min
  window): **5740/5740 samples answered**, every invariant green, 9 real jobs,
  $0 - but only **87.51 % wall coverage**, so the verdict stayed `pending`
  (needs >= 98 %). Root cause: GitHub's scheduled triggers arrived 9-60 min
  late, turning the designed 2-minute handoffs into ~47-minute gaps.
* Those 9 jobs: 1 succeeded, 8 failed **verification** with `npm test` exiting 1.
  The cause was a test time bomb, not the agent or the controller: the
  lease-expiry test hardcoded `2026-10-19`, which fell outside the 24 h grace
  after a day, so the suite went red for every job on `main`. Fixed in
  `37ad7a0` (relative timestamp) and the suite is green again.
* A new chain (5 x 300 min, back-to-back) was started on 2026-10-22
  (first slice: run `39739170179`) to measure a window without scheduler gaps.
  Until that window closes the verdict is **PENDING**.

Not verified:

* **24 h verdict** - PENDING: the chain is running; this file needs the measured
  numbers when it closes.
* Cloud dispatch **from the worker** - `OC24_GITHUB_TOKEN` is not registered
  (creating a fine-grained PAT needs the account owner in the browser). The
  workflow token can dispatch: every soak slice created a real job with
  `workflow_dispatch`, which is the event `GITHUB_TOKEN` may create.
* Cloud runner -> public controller report at load (the advisory callback is
  wired to the deployed URL but not exercised at scale).
* Sustained load at the free-plan edges (many jobs/day, D1 row counts).
* Codex/Claude/Gemini adapters are declarations only.

## Known gaps

* Cloud dispatch waits for the fine-grained PAT (`actions: write`,
  `contents: read`, repository `naeishuu-collab/opencode-24-7`). The dashboard is
  fully usable without it.
* `wrangler login` is an OAuth session that expires after ~1 h; prefer
  `CLOUDFLARE_API_TOKEN` for unattended deploys.
* `compatibility_date = 2025-09-01` must be re-checked at deploy time.
* Encrypted goals cannot be searched by text (ids still match).
* If the Actions cache is evicted between soak slices, the accumulated runtime
  restarts from zero and the verdict stays `pending` - the honest failure mode.
* The chain is finite (five slices). If the 5th still misses 98 %, the report
  says why and the chain stops; there is no silent retry.
