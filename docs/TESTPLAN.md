# Test plan and status

## Suites

| suite | command | needs network | what it proves |
| --- | --- | --- | --- |
| stub | `npm test` | no | all exit codes, retries, budget kills, redaction, config merge/restore, argument validation |
| controller | `node --test tests/controller.test.mjs` | loopback only | store/persistence, validation and caps, artifact contract, dispatch/verify/cancel/unknown, tick lock, auth, CSP, redaction |
| controller E2E | `node --test tests/controller-e2e.test.mjs` | loopback only | real server process: full loop, self-ticking loop, restart recovery, no duplicate dispatch, two controllers on one DB, D1 call shape |
| runner report | `node --test tests/report.test.mjs` | loopback only | a real runner reports to a real controller; a dead report target never fails a job |
| integration | `RUN_OPENCODE_INTEGRATION=1 OC24_OPENCODE_BIN=<bin> node --test tests/integration.test.mjs` | yes (free model) | real event parsing, real bug fix + `node --test` verification, real policy denial of `git push` |

`npm test` runs the stub, controller, controller-E2E and report suites
(`node --test "tests/*.test.mjs"`), so the default suite is everything except the
opt-in real-model run. The controller suites speak HTTP to
`tests/stubs/fake-github.mjs`, a stand-in GitHub Actions API, so status handling
(204/422/429/500) is exercised without touching GitHub.

The stub suite replaces opencode with `tests/stubs/fake-opencode.mjs`, a
deterministic emitter of the verified JSON event shape. Integration tests are
opt-in because they depend on a model and a network.

## Controller coverage (`tests/controller.test.mjs`)

| case | setup | expected |
| --- | --- | --- |
| store | create/update job, attempt, event, counter, session, then reopen the file | all state survives; `countActiveAttempts`/`stats` agree |
| allowlist | `opencode/paid-model`, short goal, bad `verify_cmd` | `model-not-allowlisted` / `invalid-goal` / `invalid-verify`; timeouts and attempts clamped to 60-3600 s and 1-3 |
| external effect | `allow_external: true` | `awaiting_approval`, no dispatch until `POST /api/jobs/:id/approve` |
| daily job cap | `maxJobsPerDay: 2` | third job refused with `daily-job-cap` |
| contract | cost > 0 / other model / commit changed / missing or failed verification / merge markers in the diff | each fails with its own reason |
| zip reader | deflate, store, junk bytes | entries in, `not a zip archive` for junk |
| happy path | dispatch → run in progress → artifact → tick | `succeeded` with cost, tokens, verification and diff; a further tick does nothing (idempotent) |
| paid artifact | artifact reports `costUsd: 0.03` | `failed`, reason mentions cost |
| read-only proof | artifact shows a commit | `failed`, reason mentions read-only |
| missing / corrupt artifact | no artifact, or junk bytes | `unknown` (safe stop), never success |
| failed / cancelled run | run conclusions | `failed` / `cancelled` |
| rejected dispatch | `422`, `max_attempts: 2` then `1` | attempt budget not consumed, job re-queues; with no budget left it fails |
| unknown dispatch | `500` | job `unknown`; repeated ticks never re-dispatch; only `resolve(retry)` moves it |
| adopted dispatch | `500` **and** a run for the marker | the run is adopted, never re-dispatched; it finishes `succeeded` |
| prove-then-retry | `500`, no run, grace elapsed | attempt deleted, job re-queued, retry uses a new marker |
| lease expiry | `dispatching` attempt with an expired lease | `unknown` with a lease reason |
| rate limit | `403` + `x-ratelimit-remaining: 0` | job stays `queued`, attempt row removed, dispatch paused (no call while paused) |
| caps | `maxConcurrent: 1`, `maxDispatchPerDay: 1` | one dispatch, the rest wait |
| cancel | queued job / running job / finished job | cancelled immediately / run cancelled via API / `409` |
| reports | good token, bad token, "success" claim | heartbeat and metrics stored as `runner-report`; bad token `401`; the job state never changes; artifact metrics overwrite the report |
| token hygiene | dispatch then read events, attempts, artifacts | no attempt token, no GitHub token, only a token hash in the DB |
| signed URL | artifact download through the fake's `302` | `Authorization` is not sent to the signed host |
| auth | `/healthz`, `/api/jobs` with and without a session, wrong token, 11 logins | `200`, `401`, `401`, `429`; cookie is `HttpOnly` + `SameSite=Strict` |
| input handling | broken JSON, paid model, unknown job/action, oversized or non-object body | `400`/`404` with a code, never a stack trace |
| CSP | `GET /` | `default-src 'none'` and a script policy that allows only `/app.js` |
| error path | store throws with a secret-looking string | `500` `internal-error`, the event log keeps a redacted reason |

## Controller E2E coverage (`tests/controller-e2e.test.mjs`)

| case | setup | expected |
| --- | --- | --- |
| no token | `OC24_ADMIN_TOKEN=""` | exit 1, "OC24_ADMIN_TOKEN is required" |
| print config | `--print-config` | JSON summary, neither the admin nor the GitHub token appears |
| full loop | child process + fake GitHub | login, create, dispatch, run link, artifact verification, `succeeded` with metrics, stats counters |
| self-ticking | `OC24_TICK=1`, 5 s, **no manual tick** | the job is dispatched and finished by the server's own loop |
| restart recovery | hard kill during a running job | after restart the job, attempt and run link are still there and finish normally |
| crash between dispatch and completion | kill, restart, two ticks | exactly one dispatch call in total; the existing run is adopted |
| two controllers, one database | same `OC24_DB_PATH`, simultaneous ticks | exactly one dispatch, one attempt |
| free-tier caps | `OC24_MAX_DISPATCH_PER_DAY=1`, `OC24_MAX_CONCURRENT=1`, `OC24_MAX_JOBS_PER_DAY=2` | third job `429`; dispatch cap holds the second job |
| D1 path | store over a D1-shaped executor | the same SQL drives a job to `succeeded` with metrics |

## Runner report coverage (`tests/report.test.mjs`)

| case | setup | expected |
| --- | --- | --- |
| report path | real runner + real controller server + attempt token | heartbeat recorded, `metrics.source = runner-report`, events `attempt-report`, job still `running` |
| no leaks | same run | token absent from `job.json` and `logs/runner.log` |
| dead target | `--report-url http://127.0.0.1:1/...` | exit 0, `success`, `report failed` logged, token not logged |


## Stub coverage (`tests/runner.test.mjs`)

| case | stub mode / setup | expected |
| --- | --- | --- |
| success | `ok` | exit 0, artifacts, diff contains tracked+untracked edits, `.opencode` restored and excluded |
| env PWD | `ok` run with a foreign `PWD` | the agent sees the workspace path, never the caller's (opencode takes its project root from `PWD` on POSIX) |
| verify env | `NODE_TEST_CONTEXT`/`NODE_TEST_WORKER_ID` in the caller env | the verify child never sees them (a child `node --test` would skip every file and still exit 0) |
| workspace path | win32 only: uppercase path with forward slashes | accepted; the comparison is canonical, not a raw string compare |
| silent agent | `silent` | exit 20, "no events", never success |
| provider error | `fail` | exit 10, error captured, no retry by default |
| transient error | `transient` | exit 10 with `--max-attempts 1`; two attempts with `--max-attempts 2` |
| flaky provider | `flaky` | exit 0 on the second attempt |
| dirty workspace | stray untracked file | exit 13, agent never starts |
| timeout | `hang`, `--timeout-sec 1` | exit 11, `killReason=timeout` |
| token budget | `tokens`, `--max-tokens 1500000` | exit 12, `killReason=max-tokens` |
| cost guard | `cost`, default `--max-cost-usd 0` | exit 12, `killReason=max-cost` |
| redaction | `leaky` + `OC24_TEST_SECRET` | no secret in job.json/summary/diff/logs, `[REDACTED]` present, `redactions > 0` |
| redaction | `leaky-file` | a secret the agent writes into a workspace file is redacted out of the diff |
| artifact scanner | `leaky-file` run dir | `tools/scan-run-dir.mjs` exits 1 and names the file; a clean run dir exits 0 |
| event loss | `burst` (500 lines, immediate exit) | every line is read (the adapter resolves on `close`, the stub writes synchronously) |
| model allowlist | unlisted model | exit 13 before the agent starts; `--allow-unlisted-model` proceeds but then needs a cost report |
| cost policy | `nocost`, allowlisted model | exit 0, `costPolicy.costReported=false` recorded; with `--require-cost-report` instead exit 20 |
| cost policy | `nocost`, `--allow-unlisted-model` | exit 20 (`unknown`), never success: no cost evidence for an unlisted model |
| verify pass/fail/timeout | `ok` + `--verify-cmd` | exit 0 / exit 15 / exit 15 (`timedOut`) |
| config merge | repo `opencode.json` with its own policy | both policies visible to the agent, repo file restored byte-for-byte |
| config rejection | `.jsonc` with comments, or `.json` + `.jsonc` | exit 13, file untouched |
| version floor | `OC24_STUB_VERSION=2.0.26` | exit 14; `--skip-version-check` proceeds |
| missing binary | `--opencode-bin <nonexistent>` | exit 14 |
| bad arguments | unknown flag, `--max-tokens abc`, `--run-base ""`, missing prompt/model | exit 13 |
| cancel | `hang` + SIGINT | exit 21 (skipped on win32) |

## Integration coverage (`tests/integration.test.mjs`)

1. **Real fix**: `tests/fixtures/sample-repo` has `add(a, b) => a - b` and a
   failing `src/calc.test.mjs`. A real free model fixes `src/calc.mjs`, must not
   touch the test, and `--verify-cmd 'node --test "src/*.test.mjs"'` must pass.
2. **Real policy**: the agent is told to run `git push origin main`; the runner's
   appended policy must deny it (`tools.blockedByPolicy >= 1`).

## Platform results (Oct 2026, opencode v2.0.32, `opencode/deepseek-v4.1-flash-free`)

| platform | suite (`npm test`) | integration suite |
| --- | --- | --- |
| Windows 11, node 24.21.0 | 88 tests: 85 pass, 0 fail, 3 skipped (2 integration + SIGINT cancel) | both tests pass |
| Ubuntu on WSL2 (Linux 6.18), node 22.22.1 | 88 tests: 85 pass, 0 fail, 3 skipped (integration only) | both tests pass |

Phase 2D (2026-10-19) added the controller suites to that same command, so the
numbers above include them: 34 controller unit tests, 9 controller E2E tests
(real child process, fake GitHub over loopback) and 2 runner-report tests. The
controller suites were green on both platforms on the first cross-platform run;
no platform-specific behaviour was found (`node:sqlite`, `DecompressionStream`,
`AbortSignal.timeout`, `Headers.getSetCookie` all behave the same on Node 22 and
24).

Phase 2E (2026-10-20) added `tests/phase2e.test.mjs` (12 tests) to the same
command: agent adapters and their fail-closed paths, the agent recorded on the
job and exposed by the API, pagination totals, id/goal search with 40-byte
truncation, event retention and goal pruning, maintenance throttling, encrypted
goals (ciphertext in the database, plaintext over an authenticated API), the
wrong/missing-key markers, plaintext dispatch plus the unreadable-goal refusal,
the <= 45-statement tick (D1 Free allows 50 per invocation) and an in-place
migration of a Phase 2D database. The suite has no
network dependency except the loopback fake GitHub server.

### Cloud runs (public repo `naeishuu-collab/opencode-24-7`, GitHub-hosted runners)

Every real-model run used the free tier only (`--max-cost-usd 0` and
`--require-cost-report`); all reported $0.

| run | what it proved |
| --- | --- |
| `ci` 39241810441 | first run: windows-latest found the forward-slash workspace bug (see Known gaps) |
| `ci` 39243252048, 39247275598, 39250161375 + 2 reruns | stub suite green on ubuntu-24.04 and windows-latest; the last commit was re-run three times to check the event-loss fix |
| `integration` 39246293549, 39247295054 | real model in the cloud: bug fix + real `node --test`, and a real `git push` denied by policy; artifact `oc24-integration-<id>` passed the scan gate and uploaded. The second run shows the verify tests really running after the node-test-marker fix. |
| `agent-job` 39248464928, 39250729311 | self-hosted job: the agent fixed the fixture bug, exactly 1 file changed, ~24k tokens, $0, verification really ran and passed; the log shows the workflow token has `"push":false`; artifact `oc24-job-<id>` uploaded after a clean scan |
| `agent-job` 39248686377 | failure propagation: `--verify-cmd false` -> exit 15 (`verification command exited with code 1`), the run fails, and the artifacts are still uploaded as evidence |
| `integration` 39250712404 | final revision: both real-model cases green again (fix verified, `git push` denied, `$0`, 23,686 and 17,238 tokens) with the fail-closed scan guard in place |
| `ci` 39262948350 | Phase 2D at `117594b`: 76 tests green on ubuntu-24.04 and windows-latest (controller suites included) + `node --check controller/worker.mjs` |
| `agent-job` 39263425059 | **controller-dispatched** (`workflow_dispatch`, 72 s end to end): local controller tick -> dispatch -> run matched by marker -> artifact download -> independent verification -> `succeeded`, 30,836 tokens, $0, `npm test` exit 0, no commit |
| `agent-job` 39337598363 | Phase 2E soak slice: `tools/soak.mjs` ran the real controller for 6 min with no manual tick, created one job, the controller dispatched this run (marker `oc24-job-20261019T224828Z-96ca-a1-9ad2`), polled it, verified the artifact and marked it `succeeded` - 36,482 tokens, $0, 18/18 samples, all soak invariants green, verdict `pending` (6 of 1440 min) |
| `ci` 39337977395 | Phase 2E at `58c775c`: 87 tests green on ubuntu-latest and windows-latest + `node --check` for the worker and the soak harness |
| `soak` 39338006574 | the soak workflow itself on GitHub-hosted Linux: 1-minute slice, controller in the runner, 2/2 samples, cache and evidence artifact, all invariants green, `pending` (manual smoke, not the 24 h run) |
| `soak` 39370579896 ... 39679757539 | 9 scheduled slices over 2026-10-19T22:53Z..2026-10-22T05:33Z: **5740/5740 samples**, all invariants green, 9 real jobs, $0. The measured wall coverage was **87.51 %** because GitHub's scheduled triggers arrived 9-60 min late, so the verdict correctly stayed `pending`; this is why the slices now chain instead of relying on the schedule. |
| `agent-job` 39387682370 | one of those 9 jobs: the agent changed **only** `README.md` and its final text matched the goal, but `npm test` exited 1. The artifact's `verify.log` showed `tests/controller.test.mjs:493` expecting `unknown` and getting `failed` - a test that hardcoded `2026-10-19` had fallen outside the 24 h grace. Fixed in `37ad7a0`; the suite is green again on Windows, WSL and both CI platforms. |
| `soak` 39737593336 -> 39738795097 | chained-slice smoke: five 2-minute slices, each dispatching the next one after saving its state; the last one logged `verdict=pending slices=5` and `chain stop`. The `soak` concurrency group serialized the handoffs and every slice restored the previous cache. |
| `soak` 39739170179 -> 39894071084 | **the measured 24 h chain**: five 300-minute slices chained back-to-back (last slice created 2026-10-23T03:15:51Z), window `2026-10-22T07:14:58Z`..`2026-10-23T08:16:01Z` = **1501.1 min**, **coverage 99.94 %**, **3000/3000 samples**, 15 SIGKILL restarts, **5/5 real jobs succeeded**, all invariants green, $0 -> `verdict.soak_24h = verified`. |
| `agent-job` 40173981494 | **first worker dispatch**: job `job-20261025T074212Z-0e06` created through the public API, dispatched by the Worker's `*/5` cron, run succeeded in 236 s, controller finalized it at 502 s with `{ok:true}`, one attempt/run id, $0, 1,336,748 tokens. The artifact showed the goal had been dispatched as `enc1.*`; **that bug is the point of this row** - fixed in `3a67099`. |
| `agent-job` 40174618013 | **worker dispatch after the fix** (`3a67099`): job `job-20261025T075353Z-0d93` with goal marker `OC24-E2E-7F3A`; the run log shows the plaintext prompt, run succeeded in 401 s, controller `{ok:true}`, one attempt/run id, $0, 23,166 tokens, artifact diff contains the marker. Three extra ticks dispatched nothing; GitHub lists one run per job. |

The Linux verification found a real bug: opencode resolves its project root from
the `PWD` environment variable on POSIX, so a forwarded `PWD` made the agent
read, edit and load config from the *caller's* repository - the policies were
never applied and the verify step ran against the wrong tree. The runner now sets
`PWD` to the workspace for the agent and for the verify command, and the stub
suite carries a regression test for it.

## Known gaps

- The first cloud runs (2026-10-19, public repo) found five real bugs. All are
  fixed and regression tested:
  1. `git rev-parse --show-toplevel` answers with forward-slash paths on
     `windows-latest`, so the raw workspace comparison rejected every job with
     exit 13 (now a canonical path comparison; win32 regression test).
  2. GitHub rejects the `runner` context in a job-level `env:`, which invalidated
     `agent-job.yml` outright (a 0s "failure" run named after the file path).
     RUN_BASE is now set on each step that uses it.
  3. A child `node --test` inherited `NODE_TEST_CONTEXT` from the test process and
     skipped every file while still exiting 0, so `verify` passed without running
     anything. Children now get a clean env (PWD pinned, node test markers
     dropped) and a regression test covers it.
  4. An empty `RUN_BASE` made the artifact scan report "nothing to scan, clean":
     the gate failed open. The scan now refuses an unset, empty or missing run
     directory, and the runner rejects `--run-base ""`.
  5. The adapter resolved on `exit` and closed readline there, and the stub wrote
     events asynchronously before `process.exit()`: on a loaded `windows-latest`
     runner a run that did emit events was read as "produced no events" (exit 20,
     or worse a wrong verdict). The adapter now resolves on `close` (after the
     stdio pipes drain) and the stub writes synchronously; a `burst` test asserts
     every line of a 500-line burst is accounted for.
- The free models are "free for a limited time". The allowlist carries
  `verifiedAt` (2026-10-18) and needs re-verification when providers change; a
  revoked free model would fail closed with exit 13 until the list is updated.
- Artifacts of a public repository are downloadable by anyone for the retention
  window (7 days). The scan proves they contain no secret values, but they do
  contain model output, diffs and the runner logs.
- The stub cannot represent real provider quirks (partial JSON lines, late cost
  reporting, very large token counts).
- Integration test 2 depends on the model obeying an explicit instruction to try
  `git push`; a model that refuses on its own would fail the assertion even
  though the policy works. Verify manually if it ever fails.
- A load/soak test has **completed**: the 24 h chain measured 99.94 % uptime over
  1501 min (3000/3000 samples, 5/5 real jobs, $0, all invariants green), so
  `soak_24h` is `verified`. See `docs/PHASE2E.md`.
- Phase 2E cloud gaps (see `docs/PHASE2E.md`): the Cloudflare worker, D1, cron,
  worker dispatch, independent artifact verification and the runner callback are
  all measured (runs `40173981494`, `40174618013`). What is not measured is
  sustained multi-job load at the free-plan edges.
- Goal encryption is opt-in (`OC24_GOAL_KEY`); without the key goals are stored
  as plain text in SQLite/D1. Encrypted goals cannot be searched by text (ids
  still match), a lost key makes them unreadable by design, and the dispatched
  prompt is still visible in the Actions log of a public repository.
- Codex CLI / Claude Code / Gemini CLI are adapter declarations only; their free
  tier, authentication and terms have not been verified, so they fail closed at
  job creation.
