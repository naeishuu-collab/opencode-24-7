# opencode-24-7

Free-tier, cloud-first runner for 24/7 autonomous development jobs driven by the
[opencode](https://opencode.ai) CLI. A job is: *check out a git repo → let an
agent change it → verify the change → keep the evidence (log, diff, usage)*.
It is designed to run on GitHub Actions with **zero dependencies** (Node built-ins
only) and **zero spend** (free models + `--max-cost-usd 0`).

Status: Phase 2 - the runner, the model/cost policy and the artifact scanner are
implemented and verified on Windows and Linux; the three GitHub Actions
workflows are written but have not run yet (no remote, awaiting approval). The
Cloudflare control plane is not built.

## What runs today

```
node runner/run-job.mjs \
  --workspace <git-repo> \
  --model opencode/deepseek-v4.1-flash-free \
  --prompt "Fix the failing test in src/calc.mjs" \
  --verify-cmd 'node --test "src/*.test.mjs"'
```

Everything a job produces lands in `runs/<jobId>/`:

| artifact | content |
| --- | --- |
| `job.json` | status, exit code, budgets, attempts, tokens, cost, tool stats, target commit |
| `summary.md` | human-readable one-pager |
| `diff.patch` | `git diff` of everything the agent changed (capped at 5 MiB) |
| `logs/opencode.jsonl` | raw JSON event stream of the agent (capped at 20 MiB) |
| `logs/runner.log` | runner decisions (attempts, retries, kills) |
| `logs/verify.log` | output of `--verify-cmd` |

The last stdout line is machine-readable:
`RESULT {"jobDir":...,"status":"success","exitCode":0,...}`.

## Exit codes

| code | status | meaning |
| --- | --- | --- |
| 0 | success | agent exited 0, and `--verify-cmd` (if given) exited 0 |
| 10 | agent-failed | agent exited non-zero after the allowed attempts |
| 11 | timeout | wall clock limit hit, agent killed |
| 12 | budget-exceeded | token, step or cost limit hit, agent killed |
| 13 | invalid | bad arguments, unlisted model, non-git/dirty workspace, unusable `.opencode` config |
| 14 | infra-error | opencode missing, or older than 2.0.32 |
| 15 | verify-failed | agent exited 0 but verification failed or timed out |
| 20 | unknown | agent exited 0 with no events (never treated as success) |
| 21 | cancelled | SIGINT/SIGTERM received |

## Model and cost policy

- **Verified-free allowlist** (`runner/config/free-models.json`, Phase 2): the
  runner refuses any model that is not on the list *before* the agent starts
  (exit 13). `--allow-unlisted-model` overrides it, and then an observed cost
  report becomes mandatory: an unlisted model whose provider never reports cost
  ends as `unknown` (exit 20), never as success.
- **Cost evidence**: `step_finish` events carry `cost` and token counts, but the
  CLI emits them for tool-calling steps only. A text-only answer therefore has
  no cost data at all, which is why the policy is explicit instead of implied
  (`job.json.costPolicy`).
- `--require-cost-report` forces exit 20 when no cost was observed, even for an
  allowlisted model. CI uses it for extra certainty.

## Safety model

- **Policies are the first line of defence.** The runner appends hard `tool.use`
  denies (`shell:git push*`, `sudo`, secret-file reads, `external_directory`,
  `webfetch`, `websearch`) to the target repo's `.opencode/opencode.json`,
  restores the file afterwards, and keeps it out of the diff via
  `.git/info/exclude`. `--allow-web` / `--allow-external-dir` opt back in.
- **Policies need `opencode >= 2.0.32`.** On 2.0.26 they were verified to be
  silently ignored, so the runner refuses older binaries
  (`--skip-version-check` overrides; treat that as unsafe).
- **The real boundary is the sandbox**, not the pattern matcher: policy globs can
  be bypassed. Jobs belong in an ephemeral CI runner with read-only credentials
  and secrets only in env vars (which are redacted from every artifact).
- **Retries are narrow.** Only `provider.network|transport|timeout` errors, only
  while the workspace is still clean, only up to `--max-attempts`. Timeouts,
  budget kills, unknown results and ordinary failures are never retried.
- **Redaction.** Values of env vars whose name contains
  KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL/AUTH plus common token shapes
  (`sk-…`, `AIza…`, `ghp_…`, JWT, `Bearer …`) are replaced with `[REDACTED]`
  in job.json, summary.md, diffs and logs.
- **Artifact gate.** `tools/scan-run-dir.mjs` re-scans a whole run directory for
  every known secret value and pattern. CI runs it before `upload-artifact` and
  uploads only when the scan is clean, so a leaked artifact cannot ship.

## Options

`node runner/run-job.mjs --help` lists everything:

- `--timeout-sec` (default 1800) wall clock per attempt
- `--max-tokens` (default 2,000,000) cumulative across attempts
- `--max-cost-usd` (default 0 = abort on the first reported cost > 0)
- `--max-steps` (default 80) agent steps
- `--max-attempts` (default 1)
- `--verify-cmd`, `--verify-timeout-sec` (default 600)
- `--agent` (default `build`), `--prompt-file`, `--job-id`, `--run-base`
- `--opencode-bin`, `--min-opencode-version`, `--skip-version-check`
- `--allow-web`, `--allow-external-dir`
- `--allow-unlisted-model`, `--require-cost-report`

Cost guard caveat: if a provider reports no cost at all, `job.json` says so in
`notes` and the guard has nothing to observe. Free models that report `cost: 0`
were verified to be safe under `--max-cost-usd 0`.

## Running jobs on GitHub Actions

Three workflows, all with `permissions: contents: read`:

- `ci.yml` (push/PR): the stub suite on ubuntu + windows, no secrets involved.
- `integration.yml` (manual): the real free model on ubuntu - proves a real bug
  fix plus `node --test` verification and a real policy-blocked `git push`.
- `agent-job.yml` (manual): a job against this repository. It records the actual
  opencode version, proves the workflow token cannot push (API check that
  `push` is false), imports credentials from the optional `OPENCODE_AUTH_JSON`
  secret (`opencode auth export` on your machine), runs the runner with
  `--max-cost-usd 0 --require-cost-report`, scans the run directory for secret
  leaks and only then uploads `runs/` as a 7-day artifact. The agent can
  therefore only produce a diff - never a push.

Why self-hosted in this odd sense: GitHub's Acceptable Use rules allow the free
Actions tier for developing the repository the workflow lives in (the pattern
used by Renovate and Copilot agentic workflows). Driving *other* repositories
from one account's free minutes is the configuration to avoid. See
`docs/PHASE0-AUDIT.md`.

## Tests

```
npm test                                    # stub suite: deterministic, no network
RUN_OPENCODE_INTEGRATION=1 OC24_OPENCODE_BIN=<opencode 2.0.32> node --test tests/integration.test.mjs
```

The stub suite covers every exit code, retries, budget kills, redaction, the
model/cost policy, the artifact scanner, config merge/restore and argument
validation. The opt-in integration tests run a real free model and prove that a
real bug gets fixed and that a real `git push` is blocked by policy. Test matrix,
platform results and known gaps: `docs/TESTPLAN.md`.

## Layout

```
runner/run-job.mjs            job orchestrator (artifacts, budgets, verify)
runner/lib/adapter.mjs        opencode adapter (args, events, kills, version floor)
runner/lib/util.mjs           git/node helpers, secret redactor
runner/config/agent-policies.json   policy template appended to target repos
runner/config/free-models.json      verified-free model allowlist
tools/scan-run-dir.mjs        artifact secret scanner (CI gate)
tests/runner.test.mjs         stub suite
tests/integration.test.mjs    real-model suite (opt-in)
```

MIT licensed.
