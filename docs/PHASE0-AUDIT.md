# Phase 0 audit (verified against the live environment, Oct 2026)

Everything below was observed on this machine or read from official documentation.
Unverified items are listed as such at the end - nothing here is an assumption
presented as fact.

## opencode CLI

- Non-interactive run: `opencode run --standalone --format json --auto -m <model> --title <job> "<prompt>"`.
  `--standalone` must come **after** the subcommand; placing it before `run`
  fails with `Unrecognized flag`. Verified: v2.0.32 and v2.0.26 on Windows.
- The project root is taken from the **`PWD` environment variable** on Linux, not
  from the real process cwd: a child started with `cwd=<workspace>` but a
  forwarded `PWD=<somewhere else>` reads, edits and runs shell commands in
  `PWD` (and loads that directory's config, so policies are lost too). Verified
  on WSL with v2.0.32; the runner therefore sets `PWD` to the workspace for the
  agent and for the verify command.
- JSON events (one per line): `step_start`, `tool_use`, `step_finish`, `text`,
  `error`. `step_finish.part` = `{reason, cost, tokens:{input, output, reasoning,
  cache:{read,write}}}`; `sessionID` is present on every event.
- Exit codes: 0 on success; non-zero on provider/model errors (e.g. 1 for
  `provider.network`, 3 for `provider.no-route`). A blocked tool call does **not**
  change the exit code - it appears as `tool_use.part.state.status == "error"`
  with `error: "Blocked by configuration policy"`.
- Ingesting an event stream that ends with `exitCode 0` but zero events must not
  be treated as success (hence exit 20 in the runner).
- Auth: credentials live in the local opencode store (SQLite `opencode.db` in
  `~/.local/share/opencode` on Windows too). `opencode auth export` prints them as
  JSON and `opencode auth import [file]` reads them back (stdin when no file).
  That pair is the CI credential path; no env-var contract is documented.
- Licenses: `@opencode/cli` (v2) and `opencode-ai` (v1) are MIT.

## Policies (the important one)

`policies` entries look like
`{"action":"tool.use","resource":"shell:git push*","effect":"deny"}`.

- **v2.0.32**: enforced. `shell:*` deny produced
  `Blocked by configuration policy` and the denial survived `--auto`.
  `provider.use` deny produced `Model unavailable` and exit 1. Repo file plus
  appended runner statements merge, last match wins.
- **v2.0.26**: silently ignored - neither tool nor provider denies took effect.
  This is why `MIN_OPENCODE_VERSION = 2.0.32`.
- Policy resources are globs over tool names and, for `shell:`, the command
  string. Glob matching can be bypassed (quoting, indirection, a script file
  written and then executed), so policies are defence in depth, not a boundary.

## Free-tier platforms (official docs)

| option | free limit | verdict |
| --- | --- | --- |
| GitHub Actions | public repo: free; private: 2,000 min/month; job max 6 h; schedule min 5 min; artifact 500 MB; public repo schedules disabled after 60 days of inactivity | **chosen** execution plane |
| Cloudflare Workers | 100k requests/day, 10 ms CPU/request, 128 MB | too little CPU for an agent |
| Cloudflare D1 | 5 M rows read/day, 100k writes/day, 5 GB | fine for Phase 2 job records |
| Cloudflare Durable Objects (SQLite backend) | 13,000 GB-s/day, 30 s CPU/request on the free plan | possible session store, needs an account to verify |
| Cloudflare Containers / Vectorize / Workflows | paid or unsuitable | excluded |
| Cloudflare Workflows | bounded steps, but CPU limits and paid tiers | excluded from MVP |

GitHub ToS note: the free Actions tier is meant for the repository that owns the
workflow. Running one account's free minutes against *other* repositories is the
configuration to avoid; self-development workflows (Renovate, Copilot agentic
workflows) are the accepted pattern. `agent-job.yml` follows it: it runs on this
repository, for this repository, with `contents: read`.

## Verified locally

- `opencode/deepseek-v4.1-flash-free` (OpenCode Console free model): replies,
  creates files, runs shell commands, reports `cost: 0` and real token counts.
  Free Console models are advertised as "free for a limited time" - no permanence
  guarantee, and a brand-new account was not tested.
- Full loop: runner + real model + real git repo fixed a planted bug in
  `tests/fixtures/sample-repo`, `node --test` verification passed, and a real
  `git push origin main` attempt was blocked by the installed policy
  (`tools.blockedByPolicy >= 1`).
- Same full loop on Linux (Ubuntu on WSL2, opencode v2.0.32, node 22):
  the integration suite passes, and a kept artifact run finished `success` in
  45 s with 16,943 tokens, `costUsd: 0`, a one-line `src/calc.mjs` diff and a
  clean `tools/scan-run-dir.mjs` scan.
- Linux also exposed the `PWD` project-root behaviour above: with the caller's
  `PWD` forwarded, the agent edited the runner's own repository instead of the
  workspace and the policies never applied. Fixed in the runner, regression
  tested in the stub suite.
- Budget guards against the stub: wall-clock kill at 1 s (exit 11), token budget
  kill (exit 12), and kill on the first reported cost > $0 (exit 12).

## Not verified (Phase 2+ work)

- The GitHub Actions workflows have never actually run: no GitHub remote and no
  `gh` CLI on this machine, so runner minutes, artifact upload, the
  least-privilege API proof, the upload gate and the CI path of
  `OPENCODE_AUTH_JSON` are unproven. `opencode auth import` was verified locally
  against a file (and `auth export` on both platforms); the stdin form used by
  the workflows is not yet exercised.
- No Cloudflare deployment; no CF account. Workers/D1 logs, limits and cron
  behaviour are doc-based only.
- Running the opencode server inside a Durable Object (`@opencode/sdk/workerd`
  exists) was not executed.
- Free-model terms for providers other than OpenCode Console (GitHub Models,
  etc.), and whether opencode reports cost for every provider (the cost guard
  cannot see what a provider does not report).
- Windows-specific kills (`taskkill /T /F`) were exercised by the timeout tests;
  POSIX process-group kills and the SIGINT cancel path were skipped on win32.

## Cost risks

- Public repo Actions minutes are free; the only billable overflow is artifact
  storage beyond 500 MB (bounded here by 7-day retention and a 20 MiB log cap).
- `--max-cost-usd 0` kills a job on the first reported cost. A provider that
  reports cost late or not at all can still spend; notes record when no cost was
  reported.
- Only free Console models are used by default. Changing `--model` to a paid one
  is the one action that can create real cost.
- Cloudflare resources in the audit table are all free-plan only; the Phase 2
  design must keep it that way (no Containers, no paid Workflows).
