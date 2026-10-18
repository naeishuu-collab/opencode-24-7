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
| silent agent | `silent` | exit 20, "no events", never success |
| provider error | `fail` | exit 10, error captured, no retry by default |
| transient error | `transient` | exit 10 with `--max-attempts 1`; two attempts with `--max-attempts 2` |
| flaky provider | `flaky` | exit 0 on the second attempt |
| dirty workspace | stray untracked file | exit 13, agent never starts |
| timeout | `hang`, `--timeout-sec 1` | exit 11, `killReason=timeout` |
| token budget | `tokens`, `--max-tokens 1500000` | exit 12, `killReason=max-tokens` |
| cost guard | `cost`, default `--max-cost-usd 0` | exit 12, `killReason=max-cost` |
| redaction | `leaky` + `OC24_TEST_SECRET` | no secret in job.json/summary/diff/logs, `[REDACTED]` present, `redactions > 0` |
| verify pass/fail/timeout | `ok` + `--verify-cmd` | exit 0 / exit 15 / exit 15 (`timedOut`) |
| config merge | repo `opencode.json` with its own policy | both policies visible to the agent, repo file restored byte-for-byte |
| config rejection | `.jsonc` with comments, or `.json` + `.jsonc` | exit 13, file untouched |
| version floor | `OC24_STUB_VERSION=2.0.26` | exit 14; `--skip-version-check` proceeds |
| missing binary | `--opencode-bin <nonexistent>` | exit 14 |
| bad arguments | unknown flag, `--max-tokens abc`, missing prompt/model | exit 13 |
| cancel | `hang` + SIGINT | exit 21 (skipped on win32) |

## Integration coverage (`tests/integration.test.mjs`)

1. **Real fix**: `tests/fixtures/sample-repo` has `add(a, b) => a - b` and a
   failing `src/calc.test.mjs`. A real free model fixes `src/calc.mjs`, must not
   touch the test, and `--verify-cmd 'node --test "src/*.test.mjs"'` must pass.
2. **Real policy**: the agent is told to run `git push origin main`; the runner's
   appended policy must deny it (`tools.blockedByPolicy >= 1`).

Both were run successfully against `opencode/deepseek-v4.1-flash-free` with
opencode v2.0.32 on Windows (Oct 2026).

## Known gaps

- CI (`.github/workflows/ci.yml`, `agent-job.yml`) is written but has never run:
  no GitHub remote exists yet. Windows and Linux CI behaviour is therefore
  asserted only by local runs.
- The stub cannot represent real provider quirks (partial JSON lines, late cost
  reporting, very large token counts).
- Integration test 2 depends on the model obeying an explicit instruction to try
  `git push`; a model that refuses on its own would fail the assertion even
  though the policy works. Verify manually if it ever fails.
- No load/soak test: concurrency, long jobs and artifact growth at scale are
  unmeasured; the log/patch caps are the only protection today.
