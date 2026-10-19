// GitHub Actions REST client for the controller.
//
// Failure kinds decide what the engine may do next, so they are explicit:
//   permanent     the call failed without any side effect (bad token, missing
//                 workflow, rejected input) - safe to fail the job
//   rate-limited  GitHub refused before doing anything (429 / 403+remaining 0)
//                 - safe to hold the job and try later
//   transient     the request may or may not have reached GitHub (network
//                 error, timeout, 5xx) - the outcome is UNKNOWN and the engine
//                 must not simply re-run it
//
// The token never appears in an error message; the artifact download follows
// the signed redirect without forwarding the Authorization header.
import { redact, withTimeout } from "./util.mjs";

export const KIND_PERMANENT = "permanent";
export const KIND_RATE_LIMITED = "rate-limited";
export const KIND_TRANSIENT = "transient";

export class GithubError extends Error {
  constructor(kind, message, { status = null, retryAfterSec = null } = {}) {
    super(message);
    this.name = "GithubError";
    this.kind = kind;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

export function createGithub({
  token = null,
  repo,
  fetchImpl = globalThis.fetch,
  apiBase = "https://api.github.com",
  timeoutMs = 20000,
  maxArtifactBytes = 32 * 1024 * 1024,
} = {}) {
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) throw new Error(`invalid repo: ${repo}`);

  async function request(path, { method = "GET", body = null, accept = "application/vnd.github+json" } = {}) {
    const headers = {
      accept,
      "x-github-api-version": "2022-11-28",
      "user-agent": "opencode-24-7-controller",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== null) headers["content-type"] = "application/json";

    let res;
    try {
      res = await withTimeout(
        fetchImpl(`${apiBase}${path}`, { method, headers, body: body === null ? undefined : JSON.stringify(body) }),
        timeoutMs,
        `GitHub ${method} ${path}`,
      );
    } catch (e) {
      throw new GithubError(KIND_TRANSIENT, redact(`GitHub request failed: ${e.message}`));
    }

    if (res.status === 204 || res.status === 201 || res.status === 202) return { status: res.status, json: null };
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      const retryAfter = Number(res.headers.get("retry-after"));
      const kind = res.status === 429 || (res.status === 403 && (remaining === "0" || Number.isFinite(retryAfter) && retryAfter > 0))
        ? KIND_RATE_LIMITED
        : res.status >= 500
          ? KIND_TRANSIENT
          : KIND_PERMANENT;
      throw new GithubError(kind, redact(`GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`), {
        status: res.status,
        retryAfterSec: Number.isFinite(retryAfter) ? retryAfter : null,
      });
    }
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new GithubError(KIND_TRANSIENT, `GitHub ${method} ${path} -> unparsable JSON body`);
      }
    }
    return { status: res.status, json };
  }

  return {
    repo,
    hasToken: Boolean(token),

    async dispatchWorkflow({ workflow, ref, inputs }) {
      await request(`/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
        method: "POST",
        body: { ref, inputs },
      });
      return { ok: true };
    },

    // workflow_dispatch does not return the created run, so runs are matched by
    // the marker the workflow puts in its run name.
    async findRunByMarker({ workflow, marker, sinceIso, perPage = 30 }) {
      const { json } = await request(
        `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=${perPage}`,
      );
      const runs = (json?.workflow_runs ?? []).filter(
        (r) => typeof r.name === "string" && r.name.includes(marker) && (!sinceIso || r.created_at >= sinceIso),
      );
      if (!runs.length) return null;
      runs.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return runs[0];
    },

    async getRun(runId) {
      const { json } = await request(`/repos/${repo}/actions/runs/${runId}`);
      return json;
    },

    async listArtifacts(runId) {
      const { json } = await request(`/repos/${repo}/actions/runs/${runId}/artifacts`);
      return json?.artifacts ?? [];
    },

    async downloadArtifact(artifactId) {
      const url = `${apiBase}/repos/${repo}/actions/artifacts/${artifactId}/zip`;
      const headers = { accept: "application/vnd.github+json", "user-agent": "opencode-24-7-controller" };
      if (token) headers.authorization = `Bearer ${token}`;
      let res;
      try {
        // manual redirect: the signed URL lives on another host and must never
        // receive the Authorization header
        res = await withTimeout(
          fetchImpl(url, { headers, redirect: "manual" }),
          timeoutMs,
          `GitHub artifact download ${artifactId}`,
        );
      } catch (e) {
        throw new GithubError(KIND_TRANSIENT, redact(`artifact download failed: ${e.message}`));
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) throw new GithubError(KIND_TRANSIENT, "artifact download redirect without a location header");
        try {
          res = await withTimeout(
            fetchImpl(location, { headers: { accept: "application/octet-stream", "user-agent": "opencode-24-7-controller" } }),
            timeoutMs,
            `GitHub artifact fetch ${artifactId}`,
          );
        } catch (e) {
          throw new GithubError(KIND_TRANSIENT, redact(`artifact fetch failed: ${e.message}`));
        }
      }
      if (!res.ok) {
        throw new GithubError(
          res.status >= 500 ? KIND_TRANSIENT : KIND_PERMANENT,
          `artifact download -> ${res.status}`,
          { status: res.status },
        );
      }
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > maxArtifactBytes) throw new GithubError(KIND_PERMANENT, `artifact is ${declared} bytes, over the ${maxArtifactBytes} cap`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > maxArtifactBytes) throw new GithubError(KIND_PERMANENT, `artifact is ${buf.byteLength} bytes, over the ${maxArtifactBytes} cap`);
      return buf;
    },

    async cancelRun(runId) {
      await request(`/repos/${repo}/actions/runs/${runId}/cancel`, { method: "POST" });
      return { ok: true };
    },
  };
}
