# Test plan and status

## Suites

| suite | command | needs network | what it proves |
| --- | --- | --- | --- |
| stub | `npm test` | no | all exit codes, retries, budget kills, redaction, config merge/restore, argument validation |
| integration | `RUN_OPENCODE_INTEGRATION=1 OC24_OPENCODE_BIN=<bin> node --test tests/integration.test.mjs` | yes (free model) | real event parsing, real bug fix + `node --test` verification, real policy denial of `git push` |

The stub suite replaces opencode with `tests/stubs/fake-opencode.mjs`, a
deterministic emitter of the verified JSON event shape. Integration tests are
opt-in because they depend on a model and a network.

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

| platform | stub suite (`npm test`) | integration suite |
| --- | --- | --- |
| Windows 11, node 24.21.0 | 30 tests: 27 pass, 0 fail, 3 skipped (2 integration + SIGINT cancel) | both tests pass |
| Ubuntu on WSL2 (Linux 6.18), node 22.22.1 | 30 tests: 27 pass, 0 fail, 3 skipped (integration only) | both tests pass |

### Cloud runs (public repo `naeishuu-collab/opencode-24-7`, GitHub-hosted runners)

Every real-model run used the free tier only (`--max-cost-usd 0` and
`--require-cost-report`); all reported $0.

| run | what it proved |
| --- | --- |
| `ci` 39241810441 | first run: windows-latest found the forward-slash workspace bug (see Known gaps) |
| `ci` 39243252048, 39247275598 | stub suite green on ubuntu-24.04 and windows-latest after the fixes |
| `integration` 39246293549 | real model in the cloud: bug fix + real `node --test`, and a real `git push` denied by policy; artifact `oc24-integration-<id>` passed the scan gate and uploaded |
| `integration` 39247295054 | re-run after the node-test-marker fix: `verify.log` shows the 2 tests really ran (previously the child `node --test` skipped every file and still exited 0) |
| `agent-job` 39248464928 | self-hosted job: the agent fixed the fixture bug, exactly 1 file changed, 24,989 tokens, $0, verification really ran and passed; the log shows the workflow token has `"push":false`; artifact `oc24-job-<id>` uploaded after a clean scan |
| `agent-job` 39248686377 | failure propagation: `--verify-cmd false` -> exit 15 (`verification command exited with code 1`), the run fails, and the artifacts are still uploaded as evidence |

The Linux verification found a real bug: opencode resolves its project root from
the `PWD` environment variable on POSIX, so a forwarded `PWD` made the agent
read, edit and load config from the *caller's* repository - the policies were
never applied and the verify step ran against the wrong tree. The runner now sets
`PWD` to the workspace for the agent and for the verify command, and the stub
suite carries a regression test for it.

## Known gaps

- The first cloud runs (2026-10-19, public repo) found four real bugs. All are
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
