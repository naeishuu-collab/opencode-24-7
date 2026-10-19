// Optional advisory reporting to the controller (heartbeats + a final result).
//
// Off unless the workflow supplies a controller URL, an attempt id and an
// attempt token. Reports are advisory only: the controller's verdict comes from
// the uploaded artifact, so a lost or forged report can never turn a failure
// into a success. A reporting error never fails the job.
export function createReporter({ url, attemptId, token, intervalMs = 60_000, timeoutMs = 10_000, fetchImpl = globalThis.fetch, log = () => {} }) {
  const enabled = Boolean(url && attemptId && token);
  const endpoint = enabled
    ? `${String(url).replace(/\/+$/, "")}/api/attempts/${encodeURIComponent(attemptId)}/report`
    : null;
  let timer = null;

  async function send(body) {
    if (!enabled) return { ok: false, skipped: "reporting is not configured" };
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, ...body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        log(`report failed: HTTP ${res.status}`);
        return { ok: false, status: res.status };
      }
      return { ok: true };
    } catch (e) {
      // Advisory: log (the caller redacts) and carry on.
      log(`report failed: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  function stopHeartbeat() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    enabled,
    endpoint,
    send,
    startHeartbeat(phase = "running") {
      if (!enabled || timer) return;
      timer = setInterval(() => send({ phase, message: "heartbeat", metrics: { phase } }), intervalMs);
      timer.unref?.();
    },
    stopHeartbeat,
    async finish(result) {
      stopHeartbeat();
      return send({
        phase: "finished",
        message: `runner finished with ${result.status}`,
        metrics: {
          status: result.status,
          model: result.model,
          steps: result.usage?.steps ?? null,
          tokens: result.usage?.tokens?.total ?? null,
          costUsd: result.usage?.costUsd ?? null,
          verifyStatus: result.verification?.status ?? null,
        },
      });
    },
  };
}
