// Controller engine: the job state machine.
//
// Design rules that the tests pin down:
//   - Dispatch is the only place with an external side effect. Before the call
//     an attempt row exists, so a crash mid-call leaves evidence, never a
//     silent retry.
//   - A dispatch whose outcome is unknown is never re-run by the system. It is
//     re-queued only after a search proves that no run exists for its marker.
//   - The final verdict of a job comes from the uploaded artifact (independent
//     verification) plus the GitHub run conclusion, never from the agent.
//   - A missing or corrupt artifact is a safe stop (unknown), not a success.
import { addSeconds, clampInt, dayKey, hexEquals, newAttemptId, newJobId, nowIso, randHex, redact, sha256Hex, truncate } from "./util.mjs";
import { GithubError, KIND_PERMANENT, KIND_RATE_LIMITED } from "./github.mjs";
import { readZipEntries } from "./zip.mjs";

export const JOB = {
  awaiting: "awaiting_approval",
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  unknown: "unknown",
};

export const ATTEMPT = {
  dispatching: "dispatching",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  unknown: "unknown",
};

export const TERMINAL_JOB_STATES = [JOB.succeeded, JOB.failed, JOB.cancelled];
const ACTIVE_RUN_STATUS = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

const GOAL_MAX = 4000;
const VERIFY_MAX = 500;
const DIFF_MAX = 20000;
const SUMMARY_MAX = 4000;
// Markers are unique per attempt, so a wide search window only guards against
// clock skew between this controller and GitHub; it cannot match a stale run.
const MARKER_LOOKBACK_SEC = 3600;

export function validateJobSpec(spec, { freeModels }) {
  const bad = (code, message) => ({ ok: false, code, message });
  if (!spec || typeof spec !== "object") return bad("invalid", "body must be a JSON object");
  const goal = typeof spec.goal === "string" ? spec.goal.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim() : "";
  if (goal.length < 3) return bad("invalid-goal", "goal must be at least 3 characters");
  if (goal.length > GOAL_MAX) return bad("invalid-goal", `goal must be at most ${GOAL_MAX} characters`);

  const model = typeof spec.model === "string" ? spec.model.trim() : "";
  if (!model) return bad("invalid-model", "model is required");
  if (!freeModels.has(model)) {
    return bad("model-not-allowlisted", `model "${model}" is not on the verified-free allowlist (runner/config/free-models.json)`);
  }

  let verify_cmd = spec.verify_cmd ?? null;
  if (verify_cmd !== null) {
    if (typeof verify_cmd !== "string") return bad("invalid-verify", "verify_cmd must be a string");
    verify_cmd = verify_cmd.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
    if (!verify_cmd) verify_cmd = null;
    else if (verify_cmd.length > VERIFY_MAX) return bad("invalid-verify", `verify_cmd must be at most ${VERIFY_MAX} characters`);
  }

  return {
    ok: true,
    value: {
      goal,
      model,
      verify_cmd,
      timeout_sec: clampInt(spec.timeout_sec, 60, 3600, 1800),
      max_attempts: clampInt(spec.max_attempts, 1, 3, 1),
      // Jobs whose goal implies an external effect (push, PR, deploy) wait for
      // an explicit human approval before they are dispatched.
      allow_external: spec.allow_external === true,
    },
  };
}

export function extractMetrics(jobJson, entries = new Map()) {
  const byPattern = (re, max) => {
    for (const [name, data] of entries) {
      if (re.test(name)) return truncate(new TextDecoder().decode(data), max);
    }
    return null;
  };
  return {
    source: "artifact-verified",
    status: jobJson.status ?? null,
    exitCode: jobJson.exitCode ?? null,
    reason: truncate(jobJson.reason ?? "", 400),
    model: jobJson.model ?? null,
    agent: jobJson.agent ?? null,
    opencodeVersion: jobJson.opencode?.version ?? null,
    attempts: jobJson.attempts ?? null,
    maxAttempts: jobJson.maxAttempts ?? null,
    steps: jobJson.usage?.steps ?? null,
    tokens: jobJson.usage?.tokens?.total ?? null,
    tokensDetail: jobJson.usage?.tokens ?? null,
    costUsd: jobJson.usage?.costUsd ?? null,
    costReported: jobJson.usage?.costReported ?? null,
    costPolicy: jobJson.costPolicy ?? null,
    verification: jobJson.verification ?? null,
    changedPaths: (jobJson.target?.changedPaths ?? []).slice(0, 50),
    commitBefore: jobJson.target?.commitBefore ?? null,
    commitAfter: jobJson.target?.commitAfter ?? null,
    dirtyAfter: jobJson.target?.dirtyAfter ?? null,
    sessionId: jobJson.session?.id ?? null,
    notes: (jobJson.notes ?? []).slice(0, 10),
    finalText: truncate(jobJson.finalText ?? "", 1000),
    diff: byPattern(/diff\.patch$/, DIFF_MAX),
    summary: byPattern(/summary\.md$/, SUMMARY_MAX),
  };
}

// The independent verification: the agent's own report is checked against the
// policy the controller set, not trusted.
export function contractCheck(job, jobJson, metrics, { maxCostUsd = 0 } = {}) {
  const reasons = [];
  if (jobJson.schema !== 1) reasons.push(`unexpected job.json schema: ${jobJson.schema}`);
  if (jobJson.status !== "success") reasons.push(`artifact reports status "${jobJson.status}" (reason: ${jobJson.reason ?? "none"})`);
  const cost = Number(jobJson.usage?.costUsd ?? 0);
  if (!Number.isFinite(cost) || cost > maxCostUsd) reasons.push(`reported cost $${cost} exceeds the allowed $${maxCostUsd}`);
  if (jobJson.costPolicy?.modelAllowlisted !== true) reasons.push("artifact does not confirm the model was on the free allowlist");
  if (jobJson.model !== job.model) reasons.push(`artifact ran model "${jobJson.model}" but the job requested "${job.model}"`);
  const before = jobJson.target?.commitBefore ?? null;
  const after = jobJson.target?.commitAfter ?? null;
  if (!before || before !== after) reasons.push(`repository was committed to during the job (${before} -> ${after}); jobs must stay read-only`);
  if (job.verify_cmd) {
    if (!jobJson.verification) reasons.push("job required a verify command but the artifact has no verification result");
    else {
      if (jobJson.verification.status !== "passed") reasons.push(`verification status is "${jobJson.verification.status}"`);
      if ((jobJson.verification.cmd ?? "").trim() !== job.verify_cmd.trim()) {
        reasons.push("verification command in the artifact does not match the job's verify_cmd");
      }
    }
  }
  if (metrics?.diff && /^(<<<<<<<|>>>>>>>)/m.test(metrics.diff)) reasons.push("diff artifact contains unresolved merge conflict markers");
  return { ok: reasons.length === 0, reasons };
}

export function createEngine({ store, github, config, now = () => nowIso() }) {
  const cfg = {
    repo: config.repo,
    ref: config.ref ?? "main",
    workflow: config.workflow ?? "agent-job.yml",
    freeModels: new Set(config.freeModels ?? []),
    maxConcurrent: config.maxConcurrent ?? 2,
    maxDispatchesPerTick: config.maxDispatchesPerTick ?? 2,
    maxPollsPerTick: config.maxPollsPerTick ?? 10,
    maxDispatchPerDay: config.maxDispatchPerDay ?? 20,
    maxJobsPerDay: config.maxJobsPerDay ?? 50,
    maxCostUsd: config.maxCostUsd ?? 0,
    controllerUrl: config.controllerUrl ?? null,
    leaseSec: config.leaseSec ?? 900,
    noRunGraceSec: config.noRunGraceSec ?? 1800,
    tickLeaseSec: config.tickLeaseSec ?? 60,
    artifactPrefix: config.artifactPrefix ?? "oc24-job-",
  };

  const ev = (kind, { job_id = null, attempt_id = null, message = null, data = null, at = now() } = {}) =>
    store.appendEvent({ kind, job_id, attempt_id, message: message === null ? null : redact(message), data, at });

  async function getJobOrFail(id) {
    const job = await store.getJob(id);
    return job ?? null;
  }

  async function createJob(spec, { actor = "api" } = {}) {
    const at = now();
    const v = validateJobSpec(spec, { freeModels: cfg.freeModels });
    if (!v.ok) return v;
    const jobsToday = await store.getCounter("job", dayKey(at));
    if (jobsToday >= cfg.maxJobsPerDay) {
      await ev("job-cap-reached", { message: `daily job cap of ${cfg.maxJobsPerDay} reached` });
      return { ok: false, code: "daily-job-cap", message: `daily job cap of ${cfg.maxJobsPerDay} reached; try again tomorrow` };
    }
    const job = await store.createJob({
      id: newJobId(),
      created_at: at,
      state: v.value.allow_external ? JOB.awaiting : JOB.queued,
      goal: v.value.goal,
      verify_cmd: v.value.verify_cmd,
      model: v.value.model,
      timeout_sec: v.value.timeout_sec,
      max_attempts: v.value.max_attempts,
      repo: cfg.repo,
      ref: cfg.ref,
      workflow: cfg.workflow,
      allow_external: v.value.allow_external,
    });
    await store.bumpCounter("job", 1, dayKey(at));
    await ev(v.value.allow_external ? "job-awaiting-approval" : "job-created", {
      job_id: job.id,
      message: `created by ${actor}`,
      data: { model: job.model, verify: job.verify_cmd, allow_external: v.value.allow_external },
    });
    const created = await store.getJob(job.id);
    return { ok: true, job: created };
  }

  async function approveJob(id, { actor = "api" } = {}) {
    const job = await getJobOrFail(id);
    if (!job) return { ok: false, code: "not-found", message: `no job ${id}` };
    if (job.state !== JOB.awaiting) return { ok: false, code: "not-awaiting-approval", message: `job is ${job.state}` };
    const at = now();
    const updated = await store.updateJob(id, { state: JOB.queued, approved_at: at, approved_by: actor });
    await ev("job-approved", { job_id: id, message: `approved by ${actor}`, at });
    return { ok: true, job: updated };
  }

  async function requestCancel(id, { actor = "api" } = {}) {
    const job = await getJobOrFail(id);
    if (!job) return { ok: false, code: "not-found", message: `no job ${id}` };
    if (TERMINAL_JOB_STATES.includes(job.state)) return { ok: false, code: "already-finished", message: `job is ${job.state}` };
    const at = now();
    if (job.state === JOB.queued || job.state === JOB.awaiting) {
      const updated = await store.updateJob(id, { state: JOB.cancelled, cancel_requested: 1, finished_at: at });
      await ev("job-cancelled", { job_id: id, message: `cancelled by ${actor} before dispatch`, at });
      return { ok: true, job: updated };
    }
    const updated = await store.updateJob(id, { cancel_requested: 1 });
    await ev("cancel-requested", { job_id: id, message: `cancellation requested by ${actor}`, at });
    return { ok: true, job: updated, note: "the running attempt is cancelled on the next controller tick" };
  }

  // Human decision for a job the system refused to guess about.
  async function resolveUnknown(id, { outcome, actor = "api", note = null } = {}) {
    const job = await getJobOrFail(id);
    if (!job) return { ok: false, code: "not-found", message: `no job ${id}` };
    if (job.state !== JOB.unknown) return { ok: false, code: "not-unknown", message: `job is ${job.state}; only unknown jobs can be resolved` };
    const at = now();
    const attempts = await store.listAttempts(id);
    if (outcome === "retry") {
      if (attempts.length >= job.max_attempts) {
        return { ok: false, code: "no-attempt-budget", message: `job already used ${attempts.length}/${job.max_attempts} attempts; create a new job instead` };
      }
      const updated = await store.updateJob(id, { state: JOB.queued, last_error: null, cancel_requested: 0 });
      await ev("unknown-resolved-retry", { job_id: id, message: `retry approved by ${actor}${note ? `: ${note}` : ""}`, at });
      return { ok: true, job: updated };
    }
    if (!["succeeded", "failed", "cancelled"].includes(outcome)) {
      return { ok: false, code: "bad-outcome", message: "outcome must be retry, succeeded, failed or cancelled" };
    }
    const updated = await store.updateJob(id, { state: outcome, finished_at: at, last_error: note ?? job.last_error });
    await ev(`unknown-resolved-${outcome}`, { job_id: id, message: `marked ${outcome} by ${actor}${note ? `: ${note}` : ""}`, at });
    return { ok: true, job: updated };
  }

  async function report(attemptId, token, body = {}) {
    const attempt = await store.getAttempt(attemptId);
    if (!attempt) return { ok: false, code: "unknown-attempt", message: `no attempt ${attemptId}` };
    if (typeof token !== "string" || !hexEquals(attempt.token_hash, await sha256Hex(token))) {
      return { ok: false, code: "bad-token", message: "attempt token mismatch" };
    }
    const at = now();
    const patch = { heartbeat_at: at, lease_expires_at: addSeconds(at, cfg.leaseSec) };
    if (body.metrics && typeof body.metrics === "object") {
      // Advisory only: a report can never change a verdict, so it is stored
      // separately from the artifact-verified metrics.
      patch.metrics = truncate(JSON.stringify({ source: "runner-report", ...compactReport(body.metrics) }), 40000);
    }
    await store.updateAttempt(attemptId, patch);
    await store.appendEvent({
      kind: "attempt-report",
      job_id: attempt.job_id,
      attempt_id: attemptId,
      message: redact(typeof body.message === "string" ? body.message : "runner report"),
      data: body.phase ? { phase: String(body.phase).slice(0, 40) } : null,
      at,
    });
    return { ok: true, advisory: true, note: "reports are advisory; the final state comes from the run and its artifact" };
  }

  function compactReport(metrics) {
    const out = {};
    for (const key of ["status", "phase", "steps", "model", "tokens", "costUsd", "verifyStatus", "message"]) {
      if (metrics[key] !== undefined) out[key] = typeof metrics[key] === "string" ? truncate(metrics[key], 200) : metrics[key];
    }
    return out;
  }

  async function expireDispatchLeases(out, at) {
    const stuck = (await store.listAttemptsByState([ATTEMPT.dispatching])).filter(
      (a) => a.lease_expires_at && a.lease_expires_at < at,
    );
    for (const attempt of stuck) {
      const message = "dispatch lease expired without confirmation; the dispatch outcome is unknown";
      await store.updateAttempt(attempt.id, { state: ATTEMPT.unknown, error: message });
      const job = await getJobOrFail(attempt.job_id);
      if (job && !TERMINAL_JOB_STATES.includes(job.state)) {
        await store.updateJob(job.id, { state: JOB.unknown, last_error: message });
      }
      await ev("dispatch-lease-expired", { job_id: attempt.job_id, attempt_id: attempt.id, message, at });
      out.expired.push(attempt.id);
    }
  }

  // Dispatch outcomes that were never confirmed are re-queued only when a
  // marker search proves no run exists; if a run exists it is adopted, never
  // re-executed.
  async function resolveAmbiguousDispatch(out, at) {
    const candidates = (await store.listAttemptsByState([ATTEMPT.unknown])).filter(
      (a) => !a.run_id && a.dispatched_at && addSeconds(a.dispatched_at, cfg.noRunGraceSec) <= at,
    );
    for (const attempt of candidates.slice(0, cfg.maxPollsPerTick)) {
      const job = await getJobOrFail(attempt.job_id);
      if (!job || TERMINAL_JOB_STATES.includes(job.state)) continue;
      let run = null;
      try {
        run = await github.findRunByMarker({ workflow: job.workflow, marker: attempt.marker, sinceIso: addSeconds(attempt.dispatched_at, -MARKER_LOOKBACK_SEC) });
      } catch (e) {
        if (!(e instanceof GithubError)) throw e;
        continue; // unreadable now, try again on a later tick
      }
      if (run) {
        await store.updateAttempt(attempt.id, {
          state: ATTEMPT.running,
          run_id: String(run.id),
          run_url: run.html_url ?? null,
          lease_expires_at: addSeconds(at, cfg.leaseSec),
        });
        await store.updateJob(job.id, { state: JOB.running, run_id: String(run.id), run_url: run.html_url ?? null, last_error: null });
        await ev("ambiguous-dispatch-adopted", {
          job_id: job.id,
          attempt_id: attempt.id,
          message: `unconfirmed dispatch turned out to have run ${run.id}; adopting it instead of retrying`,
          at,
        });
        out.resolvedDispatches.push({ attempt: attempt.id, action: "adopted", run: run.id });
        continue;
      }
      const attempts = await store.listAttempts(job.id);
      if (attempts.length < job.max_attempts) {
        // Prove-then-retry: no run exists for this marker, so nothing to duplicate.
        await store.deleteAttempt(attempt.id);
        await store.updateJob(job.id, { state: JOB.queued, last_error: null });
        await ev("ambiguous-dispatch-cleared", {
          job_id: job.id,
          message: "no run exists for the ambiguous dispatch; requeued (nothing was executed)",
          at,
        });
        out.resolvedDispatches.push({ attempt: attempt.id, action: "requeued" });
      } else {
        const message = "dispatch outcome unknown and no attempt budget left to retry";
        await store.updateJob(job.id, { state: JOB.failed, last_error: message, finished_at: at });
        await ev("ambiguous-dispatch-exhausted", { job_id: job.id, attempt_id: attempt.id, message, at });
        out.resolvedDispatches.push({ attempt: attempt.id, action: "failed" });
      }
    }
  }

  // Cancel: link the run first when the dispatch is not linked yet, otherwise
  // the GitHub run would keep burning minutes after the job was cancelled.
  async function processCancels(out, at) {
    const active = await store.listAttemptsByState([ATTEMPT.dispatching, ATTEMPT.running]);
    for (const attempt of active) {
      const job = await getJobOrFail(attempt.job_id);
      if (!job || !job.cancel_requested) continue;
      let current = attempt;
      if (!current.run_id) {
        try {
          const run = await github.findRunByMarker({
            workflow: job.workflow,
            marker: current.marker,
            sinceIso: addSeconds(current.dispatched_at ?? current.created_at, -MARKER_LOOKBACK_SEC),
          });
          if (run) {
            await store.updateAttempt(current.id, { run_id: String(run.id), run_url: run.html_url ?? null });
            await store.updateJob(job.id, { run_id: String(run.id), run_url: run.html_url ?? null });
            current = await store.getAttempt(current.id);
          }
        } catch (e) {
          if (!(e instanceof GithubError)) throw e;
          // fall through: cancel locally and say so
        }
      }
      if (!current.run_id) {
        await store.updateAttempt(current.id, { state: ATTEMPT.cancelled });
        await store.updateJob(job.id, { state: JOB.cancelled, finished_at: at });
        await ev("job-cancelled", {
          job_id: job.id,
          attempt_id: current.id,
          message: "cancelled before a run was confirmed; no run was cancelled (verify the Actions tab if a run appears)",
          at,
        });
        out.cancelled.push(job.id);
        continue;
      }
      try {
        await github.cancelRun(current.run_id);
      } catch (e) {
        if (!(e instanceof GithubError)) throw e;
        await store.updateAttempt(current.id, { error: redact(e.message) });
        continue; // retry on the next tick
      }
      await store.updateAttempt(current.id, { state: ATTEMPT.cancelled });
      await store.updateJob(job.id, { state: JOB.cancelled, finished_at: at, run_url: current.run_url });
      await ev("job-cancelled", { job_id: job.id, attempt_id: current.id, message: `run ${current.run_id} cancelled`, at });
      out.cancelled.push(job.id);
    }
  }

  function pickArtifact(artifacts, runId) {
    const live = artifacts.filter((a) => !a.expired);
    const exact = live.find((a) => a.name === `${cfg.artifactPrefix}${runId}`);
    if (exact) return exact;
    const prefixed = live.filter((a) => typeof a.name === "string" && a.name.startsWith(cfg.artifactPrefix));
    prefixed.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return prefixed[0] ?? null;
  }

  async function finalizeFromRun(job, attempt, run, at, out) {
    const conclusion = run.conclusion ?? null;
    let artifact = null;
    let metrics = null;
    let artifactError = null;
    try {
      artifact = pickArtifact(await github.listArtifacts(run.id), run.id);
    } catch (e) {
      if (!(e instanceof GithubError)) throw e;
      artifactError = redact(e.message);
    }
    if (artifact) {
      try {
        const entries = await readZipEntries(await github.downloadArtifact(artifact.id));
        const jobJsonEntries = [...entries.keys()].filter((n) => /(^|\/)job\.json$/.test(n));
        if (jobJsonEntries.length !== 1) {
          artifactError = `expected exactly one job.json in the artifact, found ${jobJsonEntries.length}`;
        } else {
          const jobJson = JSON.parse(new TextDecoder().decode(entries.get(jobJsonEntries[0])));
          metrics = extractMetrics(jobJson, entries);
          const check = contractCheck(job, jobJson, metrics, { maxCostUsd: cfg.maxCostUsd });
          metrics.contract = check;
        }
      } catch (e) {
        artifactError = redact(`artifact unreadable: ${e.message}`);
      }
    } else if (!artifactError) {
      artifactError = "the run produced no artifact";
    }

    const finish = async (state, message, { attemptState = state, extra = {} } = {}) => {
      if (metrics) {
        metrics = { ...metrics, diff: redact(metrics.diff ?? ""), summary: redact(metrics.summary ?? "") };
      }
      const attemptPatch = {
        state: attemptState,
        conclusion,
        run_id: String(run.id),
        run_url: run.html_url ?? null,
        artifact_name: artifact?.name ?? null,
        metrics: metrics ? truncate(JSON.stringify(metrics), 60000) : null,
        verification: metrics?.contract ? JSON.stringify(metrics.contract) : null,
        error: state === JOB.failed || state === JOB.unknown ? message : null,
      };
      await store.updateAttempt(attempt.id, attemptPatch);
      const jobPatch = {
        state,
        finished_at: at,
        run_id: String(run.id),
        run_url: run.html_url ?? null,
        artifact_name: artifact?.name ?? null,
        last_error: state === JOB.failed || state === JOB.unknown ? message : null,
        verification: metrics?.contract ? JSON.stringify({ ...metrics.contract }) : null,
        cost_usd: Number(job.cost_usd ?? 0) + Number(metrics?.costUsd ?? 0),
        tokens_total: Number(job.tokens_total ?? 0) + Number(metrics?.tokens ?? 0),
        ...extra,
      };
      await store.updateJob(job.id, jobPatch);
      await ev(`job-${state}`, {
        job_id: job.id,
        attempt_id: attempt.id,
        message,
        data: { run: String(run.id), conclusion, artifact: artifact?.name ?? null },
        at,
      });
      out.finalized.push({ job: job.id, state, message });
    };

    if (conclusion === "cancelled") {
      await finish(JOB.cancelled, `run ${run.id} was cancelled`, { attemptState: ATTEMPT.cancelled });
      return;
    }
    if (conclusion !== "success") {
      await finish(JOB.failed, `run concluded "${conclusion}"${artifactError ? ` (artifact: ${artifactError})` : ""}`, { attemptState: ATTEMPT.failed });
      return;
    }
    if (!metrics) {
      // Safe stop: a successful run without a readable artifact cannot be verified.
      await finish(JOB.unknown, `run succeeded but its artifact could not be verified: ${artifactError}`, { attemptState: ATTEMPT.unknown });
      return;
    }
    if (!metrics.contract.ok) {
      await finish(JOB.failed, `independent verification failed: ${metrics.contract.reasons.join("; ")}`, { attemptState: ATTEMPT.failed });
      return;
    }
    await finish(JOB.succeeded, `verified: ${metrics.status}, cost $${metrics.costUsd ?? 0}, verification ${metrics.verification?.status ?? "n/a"}`, {
      attemptState: ATTEMPT.succeeded,
    });
  }

  async function pollRunning(out, at) {
    const active = (await store.listAttemptsByState([ATTEMPT.running])).slice(0, cfg.maxPollsPerTick);
    for (const attempt of active) {
      const job = await getJobOrFail(attempt.job_id);
      if (!job || TERMINAL_JOB_STATES.includes(job.state) || job.cancel_requested) continue;
      let current = attempt;

      if (!current.run_id) {
        let run = null;
        try {
          run = await github.findRunByMarker({
            workflow: job.workflow,
            marker: current.marker,
            sinceIso: addSeconds(current.dispatched_at ?? current.created_at, -MARKER_LOOKBACK_SEC),
          });
        } catch (e) {
          if (!(e instanceof GithubError)) throw e;
          await store.updateAttempt(current.id, { error: redact(e.message) });
          continue;
        }
        if (!run) {
          if (addSeconds(current.dispatched_at ?? current.created_at, cfg.noRunGraceSec) <= at) {
            const message = "no workflow run appeared for this dispatch within the grace period; outcome unknown";
            await store.updateAttempt(current.id, { state: ATTEMPT.unknown, error: message });
            await store.updateJob(job.id, { state: JOB.unknown, last_error: message });
            await ev("run-never-appeared", { job_id: job.id, attempt_id: current.id, message, at });
          }
          continue;
        }
        await store.updateAttempt(current.id, { run_id: String(run.id), run_url: run.html_url ?? null, lease_expires_at: addSeconds(at, cfg.leaseSec) });
        await store.updateJob(job.id, { run_id: String(run.id), run_url: run.html_url ?? null, state: JOB.running });
        await ev("run-linked", { job_id: job.id, attempt_id: current.id, message: `run ${run.id} matched by marker`, at });
        current = await store.getAttempt(current.id);
      }

      let run;
      try {
        run = await github.getRun(current.run_id);
      } catch (e) {
        if (!(e instanceof GithubError)) throw e;
        await store.updateAttempt(current.id, { error: redact(e.message) });
        continue;
      }
      if (!run) continue;
      if (ACTIVE_RUN_STATUS.has(run.status)) {
        await store.updateAttempt(current.id, { heartbeat_at: at, lease_expires_at: addSeconds(at, cfg.leaseSec) });
        continue;
      }
      if (run.status !== "completed") {
        await store.updateAttempt(current.id, { error: `unexpected run status: ${run.status}` });
        continue;
      }
      await finalizeFromRun(job, current, run, at, out);
    }
  }

  async function dispatchQueued(out, at) {
    if (!github.hasToken) {
      out.notes.push("no GitHub token configured; dispatch is disabled");
      return;
    }
    const pauseUntil = await store.getMeta("dispatch_pause_until");
    if (pauseUntil && pauseUntil > at) {
      out.notes.push(`dispatch paused until ${pauseUntil}`);
      return;
    }
    const queued = (await store.listJobs({ states: [JOB.queued], limit: 50 })).sort((a, b) =>
      a.created_at < b.created_at ? -1 : 1,
    );
    if (!queued.length) return;
    let active = await store.countActiveAttempts();
    let dispatchesToday = await store.getCounter("dispatch", dayKey(at));

    for (const job of queued) {
      if (out.dispatched.length >= cfg.maxDispatchesPerTick) {
        out.notes.push("per-tick dispatch cap reached");
        break;
      }
      if (active >= cfg.maxConcurrent) {
        out.notes.push(`concurrency cap of ${cfg.maxConcurrent} reached`);
        break;
      }
      if (dispatchesToday >= cfg.maxDispatchPerDay) {
        out.notes.push(`daily dispatch cap of ${cfg.maxDispatchPerDay} reached`);
        break;
      }
      const attempts = await store.listAttempts(job.id);
      if (attempts.length >= job.max_attempts) {
        const message = `attempt budget exhausted (${attempts.length}/${job.max_attempts}) before dispatch`;
        await store.updateJob(job.id, { state: JOB.failed, last_error: message, finished_at: at });
        await ev("job-failed", { job_id: job.id, message, at });
        continue;
      }

      const n = attempts.length + 1;
      const attemptId = newAttemptId();
      const token = `oc24_${randHex(24)}`;
      const marker = `oc24-${job.id}-a${n}-${randHex(2)}`;
      await store.createAttempt({
        id: attemptId,
        job_id: job.id,
        n,
        marker,
        token_hash: await sha256Hex(token),
        state: ATTEMPT.dispatching,
        created_at: at,
      });
      await store.updateAttempt(attemptId, { dispatched_at: at, lease_expires_at: addSeconds(at, cfg.leaseSec) });

      let err = null;
      try {
        await github.dispatchWorkflow({
          workflow: job.workflow,
          ref: job.ref,
          inputs: {
            prompt: job.goal,
            model: job.model,
            verify_cmd: job.verify_cmd ?? "",
            timeout_sec: String(job.timeout_sec),
            max_attempts: String(job.max_attempts),
            job_marker: marker,
            controller_url: cfg.controllerUrl ?? "",
            attempt_id: attemptId,
            attempt_token: token,
          },
        });
      } catch (e) {
        err = e;
      }

      if (!err) {
        await store.updateAttempt(attemptId, { state: ATTEMPT.running, lease_expires_at: addSeconds(at, cfg.leaseSec) });
        await store.updateJob(job.id, { state: JOB.running, attempt_count: n, last_error: null });
        await store.bumpCounter("dispatch", 1, dayKey(at));
        dispatchesToday++;
        active++;
        await ev("dispatched", {
          job_id: job.id,
          attempt_id: attemptId,
          message: `dispatched attempt ${n}/${job.max_attempts} (marker ${marker})`,
          data: { marker, model: job.model },
          at,
        });
        out.dispatched.push({ job: job.id, attempt: attemptId, marker });
        continue;
      }

      if (!(err instanceof GithubError)) throw err;

      if (err.kind === KIND_PERMANENT) {
        // Definite failure with no side effect: the attempt row is removed so
        // the budget is not consumed by a call that never started a run.
        await store.deleteAttempt(attemptId);
        const canRetry = attempts.length + 1 < job.max_attempts;
        const state = canRetry ? JOB.queued : JOB.failed;
        await store.updateJob(job.id, {
          state,
          last_error: canRetry ? null : `dispatch rejected: ${err.message}`,
          finished_at: canRetry ? null : at,
        });
        await ev("dispatch-rejected", {
          job_id: job.id,
          message: `dispatch rejected (${err.status ?? "no status"}): ${err.message}${canRetry ? "; will retry" : ""}`,
          at,
        });
        if (err.status === 401 || err.status === 403 || err.status === 404) {
          await store.setMeta("dispatch_pause_until", addSeconds(at, 600));
          out.notes.push(`dispatch paused 10m after ${err.status}`);
        }
        continue;
      }

      if (err.kind === KIND_RATE_LIMITED) {
        await store.deleteAttempt(attemptId);
        await store.updateJob(job.id, { state: JOB.queued, last_error: null });
        const pause = err.retryAfterSec ?? 900;
        await store.setMeta("dispatch_pause_until", addSeconds(at, Math.min(pause, 3600)));
        await ev("dispatch-rate-limited", {
          job_id: job.id,
          message: `GitHub rate limit; holding the job for ${pause}s (nothing was dispatched)`,
          at,
        });
        out.notes.push("rate limited");
        break;
      }

      // Transient: the request may or may not have reached GitHub.
      const message = `dispatch outcome unknown: ${err.message}`;
      await store.updateAttempt(attemptId, { state: ATTEMPT.unknown, error: message });
      await store.updateJob(job.id, { state: JOB.unknown, last_error: message });
      await ev("dispatch-outcome-unknown", { job_id: job.id, attempt_id: attemptId, message, at });
      out.notes.push(`dispatch outcome unknown for ${job.id}`);
    }
  }

  async function tick({ at = now() } = {}) {
    const held = await store.getMeta("tick_lock_until");
    if (held && held > at) return { at, skipped: "tick-lock", until: held };
    await store.setMeta("tick_lock_until", addSeconds(at, cfg.tickLeaseSec));
    const out = { at, expired: [], resolvedDispatches: [], finalized: [], dispatched: [], cancelled: [], notes: [] };
    try {
      await expireDispatchLeases(out, at);
      await resolveAmbiguousDispatch(out, at);
      await processCancels(out, at);
      await pollRunning(out, at);
      await dispatchQueued(out, at);
    } finally {
      await store.setMeta("tick_lock_until", "1970-01-01T00:00:00Z");
    }
    return out;
  }

  async function jobView(id) {
    const job = await store.getJob(id);
    if (!job) return null;
    const attempts = await store.listAttempts(id);
    const events = await store.listEvents({ job_id: id, limit: 200 });
    return { job, attempts, events };
  }

  return { config: cfg, createJob, approveJob, requestCancel, resolveUnknown, report, tick, jobView, ev };
}
