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
| Windows 11, node 24.21.0 | 76 tests: 73 pass, 0 fail, 3 skipped (2 integration + SIGINT cancel) | both tests pass |
| Ubuntu on WSL2 (Linux 6.18), node 22.22.1 | 76 tests: 73 pass, 0 fail, 3 skipped (integration only) | both tests pass |

Phase 2D (2026-10-19) added the controller suites to that same command, so the
numbers above include them: 34 controller unit tests, 9 controller E2E tests
(real child process, fake GitHub over loopback) and 2 runner-report tests. The
controller suites were green on both platforms on the first cross-platform run;
no platform-specific behaviour was found (`node:sqlite`, `DecompressionStream`,
`AbortSignal.timeout`, `Headers.getSetCookie` all behave the same on Node 22 and
24).

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
- No load/soak test: concurrency, long jobs and artifact growth at scale are
  unmeasured; the log/patch caps are the only protection today.
- Phase 2D controller gaps (see `docs/PHASE2D.md` for the full list): the
  Cloudflare worker, its D1 binding and the 10 ms CPU/request budget are written
  and unit-tested through the D1 call shape, but never deployed; a cloud runner
  has never reported back to a controller (needs a public URL); controller events
  are never pruned; the job goal is stored verbatim (not encrypted at rest).
