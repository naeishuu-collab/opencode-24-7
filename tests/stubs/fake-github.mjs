// A stand-in for the GitHub Actions REST API, served over real HTTP so the
// controller talks to it through controller/lib/github.mjs unchanged.
//
// Tests steer it through `fake.state` and inspect `fake.calls`.
import http from "node:http";

export async function startFakeGithub() {
  const state = {
    dispatchStatus: 204, // 204 = accepted, 500 = "may or may not have happened", 429 = rate limited, 422 = rejected
    createRunOnFailure: false, // true = the run starts even though the dispatch call fails
    dispatchFails: false,
    rateLimited: false,
    runs: new Map(),
    artifacts: new Map(), // runId -> { id, name, expired, bytes }
    calls: [],
    nextRunId: 5000,
    nextArtifactId: 900,
    runStatus: "queued",
    artifactRedirect: true,
    artifactStatus: 200,
    authorizationOnSignedUrl: null,
    authorizationSeen: [],
    runLookupFails: false,
  };

  const url = {
    base: null,
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const parsed = new URL(req.url, "http://127.0.0.1");
      const p = parsed.pathname;
      const call = { method: req.method, path: p, search: parsed.search, body: bodyText ? safeJson(bodyText) : null, authorization: req.headers.authorization ?? null };
      state.calls.push(call);
      if (req.headers.authorization) state.authorizationSeen.push(p);

      const json = (status, value, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(value));
      };

      // POST /repos/:o/:r/actions/workflows/:file/dispatches
      if (req.method === "POST" && /\/actions\/workflows\/[^/]+\/dispatches$/.test(p)) {
        if (state.rateLimited) {
          return json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "retry-after": "60" });
        }
        const marker = call.body?.inputs?.job_marker ?? "no-marker";
        // `createRunOnFailure` models the nasty case: the request failed (5xx)
        // but GitHub did start the run anyway.
        if (state.dispatchStatus !== 204 && !state.createRunOnFailure) {
          return json(state.dispatchStatus, { message: state.dispatchStatus === 422 ? "Workflow does not have workflow_dispatch trigger" : "server error" });
        }
        const id = String(state.nextRunId++);
        state.runs.set(id, {
          id: Number(id),
          name: `agent-job ${marker}`,
          event: "workflow_dispatch",
          status: state.runStatus,
          conclusion: null,
          html_url: `${url.base}/runs/${id}`,
          created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
          inputs: call.body?.inputs ?? null,
        });
        if (state.dispatchStatus !== 204) {
          return json(state.dispatchStatus, { message: "server error after creating the run" });
        }
        res.writeHead(204);
        return res.end();
      }

      // GET /repos/:o/:r/actions/workflows/:file/runs
      if (req.method === "GET" && /\/actions\/workflows\/[^/]+\/runs$/.test(p)) {
        if (state.runLookupFails) return json(500, { message: "server error" });
        return json(200, { workflow_runs: [...state.runs.values()] });
      }

      // GET /repos/:o/:r/actions/runs/:id/artifacts
      const artifactsMatch = p.match(/\/actions\/runs\/(\d+)\/artifacts$/);
      if (req.method === "GET" && artifactsMatch) {
        const artifact = state.artifacts.get(artifactsMatch[1]);
        return json(200, {
          artifacts: artifact
            ? [{ id: artifact.id, name: artifact.name, expired: Boolean(artifact.expired), size_in_bytes: artifact.bytes?.length ?? 0, created_at: new Date().toISOString() }]
            : [],
        });
      }

      // GET /repos/:o/:r/actions/artifacts/:id/zip (+ the signed redirect)
      const zipMatch = p.match(/\/actions\/artifacts\/(\d+)\/zip$/);
      if (req.method === "GET" && zipMatch) {
        const found = [...state.artifacts.values()].find((a) => String(a.id) === zipMatch[1]);
        if (!found) return json(404, { message: "artifact not found" });
        if (state.artifactRedirect) {
          res.writeHead(302, { location: `${url.base}/signed/artifacts/${found.id}` });
          return res.end();
        }
        return sendBytes(res, state, found);
      }
      const signedMatch = p.match(/\/signed\/artifacts\/(\d+)$/);
      if (req.method === "GET" && signedMatch) {
        state.authorizationOnSignedUrl = req.headers.authorization ?? null;
        const found = [...state.artifacts.values()].find((a) => String(a.id) === signedMatch[1]);
        if (!found) return json(404, { message: "artifact not found" });
        return sendBytes(res, state, found);
      }

      // POST /repos/:o/:r/actions/runs/:id/cancel
      const cancelMatch = p.match(/\/actions\/runs\/(\d+)\/cancel$/);
      if (req.method === "POST" && cancelMatch) {
        const run = state.runs.get(cancelMatch[1]);
        if (run) {
          run.status = "completed";
          run.conclusion = "cancelled";
        }
        res.writeHead(202);
        return res.end();
      }

      // GET /repos/:o/:r/actions/runs/:id
      const runMatch = p.match(/\/actions\/runs\/(\d+)$/);
      if (req.method === "GET" && runMatch) {
        const run = state.runs.get(runMatch[1]);
        if (!run) return json(404, { message: "Not Found" });
        return json(200, run);
      }

      return json(404, { message: `fake-github: no route for ${req.method} ${p}` });
    });
  });

  function sendBytes(res, st, artifact) {
    if (st.artifactStatus !== 200) {
      res.writeHead(st.artifactStatus, { "content-type": "application/json" });
      return res.end(JSON.stringify({ message: "artifact error" }));
    }
    res.writeHead(200, { "content-type": "application/zip", "content-length": artifact.bytes.length });
    res.end(artifact.bytes);
  }

  function safeJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Never hold the test process open: the controller under test is what the
  // test is waiting for, not this stub.
  server.unref();
  url.base = `http://127.0.0.1:${server.address().port}`;

  const api = {
    state,
    url: `${url.base}`,
    calls: state.calls,
    dispatchCalls: () => state.calls.filter((c) => /\/dispatches$/.test(c.path)),
    lastDispatchInputs: () => {
      const calls = api.dispatchCalls();
      return calls.length ? calls[calls.length - 1].body?.inputs ?? null : null;
    },
    runIds: () => [...state.runs.keys()],
    completeRun(runId, conclusion, { status = "completed" } = {}) {
      const run = state.runs.get(String(runId));
      if (!run) throw new Error(`fake-github: no run ${runId}`);
      run.status = status;
      run.conclusion = conclusion;
      return run;
    },
    setRunStatus(runId, status) {
      const run = state.runs.get(String(runId));
      if (!run) throw new Error(`fake-github: no run ${runId}`);
      run.status = status;
      return run;
    },
    attachArtifact(runId, bytes, { name = null, expired = false } = {}) {
      const id = state.nextArtifactId++;
      state.artifacts.set(String(runId), { id, name: name ?? `oc24-job-${runId}`, expired, bytes });
      return id;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
  return api;
}
