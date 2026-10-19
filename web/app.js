// Dashboard for the OpenCode 24/7 controller.
//
// Everything shown here comes from the controller API (jobs, attempts, events,
// artifact-verified metrics). There is no simulated progress: when a value is
// unknown the UI says so. All text is inserted with textContent, never as HTML.
"use strict";

const $ = (id) => document.getElementById(id);
const STATE_FILTERS = ["all", "queued", "awaiting_approval", "running", "unknown", "succeeded", "failed", "cancelled"];

const state = {
  signedIn: false,
  filter: "all",
  q: "",
  offset: 0,
  total: 0,
  pageSize: 50,
  hasMore: false,
  agents: [],
  jobs: [],
  selected: null,
  config: null,
  poll: null,
  lastUpdated: null,
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function pill(value) {
  return el("span", `pill ${value}`, value);
}

function fmtTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function fmtDuration(fromIso, toIso) {
  if (!fromIso) return "-";
  const start = Date.parse(fromIso);
  const end = toIso ? Date.parse(toIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return "-";
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 90) return `${s}秒`;
  if (s < 5400) return `${Math.round(s / 60)}分`;
  return `${(s / 3600).toFixed(1)}時間`;
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (res.status === 401) {
    signedOut();
    throw new Error("セッションが切れました。再度サインインしてください。");
  }
  if (!res.ok) throw new Error(json?.message ?? `${res.status} ${res.statusText}`);
  return json;
}

function setConn(ok, detail) {
  const dot = $("conn-dot");
  dot.classList.toggle("ok", ok === true);
  dot.classList.toggle("bad", ok === false);
  $("updated").textContent = detail ?? "";
}

function signedOut() {
  state.signedIn = false;
  state.selected = null;
  if (state.poll) {
    clearInterval(state.poll);
    state.poll = null;
  }
  for (const id of ["stats", "new-job", "jobs", "detail"]) $(id).classList.add("hidden");
  $("logout").classList.add("hidden");
  $("login").classList.remove("hidden");
  setConn(null, "未接続");
}

function signedIn() {
  state.signedIn = true;
  $("login").classList.add("hidden");
  $("logout").classList.remove("hidden");
  for (const id of ["stats", "new-job", "jobs"]) $(id).classList.remove("hidden");
  if (!state.poll) state.poll = setInterval(() => refresh().catch(() => {}), 5000);
  return refresh();
}

async function login() {
  const token = $("token").value.trim();
  $("login-error").textContent = "";
  if (!token) {
    $("login-error").textContent = "トークンを入力してください。";
    return;
  }
  try {
    await api("/api/session", { method: "POST", body: { token } });
    $("token").value = "";
    await signedIn();
  } catch (e) {
    $("login-error").textContent = e.message;
  }
}

async function logout() {
  try {
    await api("/api/session", { method: "DELETE" });
  } catch {
    /* the local session is dropped either way */
  }
  signedOut();
}

function renderFilters() {
  const box = $("filters");
  box.textContent = "";
  for (const name of STATE_FILTERS) {
    const b = el("button", name === state.filter ? "active" : "", name);
    b.type = "button";
    b.addEventListener("click", () => {
      state.filter = name;
      state.offset = 0;
      renderFilters();
      refresh().catch((e) => setConn(false, e.message));
    });
    box.appendChild(b);
  }
}

function renderStats(stats) {
  const body = $("stats-body");
  body.textContent = "";
  const byState = stats.jobsByState ?? {};
  const cells = [
    ["実行中", stats.activeAttempts ?? 0],
    ["待機", (byState.queued ?? 0) + (byState.awaiting_approval ?? 0)],
    ["要確認(unknown)", byState.unknown ?? 0],
    ["成功", byState.succeeded ?? 0],
    ["失敗", byState.failed ?? 0],
    ["本日のジョブ", stats.jobsToday ?? 0],
    ["本日のdispatch", `${stats.dispatchesToday ?? 0}/${stats.caps?.max_dispatch_per_day ?? "?"}`],
    ["イベント保存", stats.events?.count ?? 0],
    ["Goal 保存", stats.goal_storage === "encrypted" ? "暗号化" : "平文"],
    ["GitHubトークン", stats.github_token === "configured" ? "設定済み" : "未設定(dispatch不可)"],
  ];
  for (const [label, value] of cells) {
    const card = el("div", "stat");
    card.appendChild(el("b", null, value));
    card.appendChild(el("span", null, label));
    body.appendChild(card);
  }
  $("footer-config").textContent = `${stats.repo} · ${stats.workflow}@${stats.ref} · 同時実行上限 ${stats.caps?.max_concurrent ?? "?"} · コスト上限 $${stats.caps?.max_cost_usd ?? "?"} · イベント保持 ${stats.retention?.events_days ?? "?"}日 · コールバックURL ${stats.controller_url ?? "未設定"}`;
}

function jobRow(job) {
  const row = el("div", "job");
  row.appendChild(pill(job.state));
  const middle = el("div");
  middle.appendChild(el("div", "goal", job.goal));
  const bits = [
    job.agent ?? "opencode",
    job.model,
    `試行 ${job.attempt_count}/${job.max_attempts}`,
    job.cost_usd ? `$${job.cost_usd}` : "$0",
    job.tokens_total ? `${job.tokens_total} tokens` : null,
    fmtDuration(job.created_at, job.finished_at),
    job.last_error ? `⚠ ${job.last_error}` : null,
  ].filter(Boolean);
  middle.appendChild(el("div", "meta", bits.join(" · ")));
  row.appendChild(middle);
  row.appendChild(el("div", "meta", fmtTime(job.created_at)));
  row.addEventListener("click", () => showDetail(job.id));
  return row;
}

function renderJobs() {
  const list = $("job-list");
  list.textContent = "";
  if (!state.jobs.length) {
    list.appendChild(el("p", "muted", "このフィルタのジョブはありません。"));
    return;
  }
  for (const job of state.jobs) list.appendChild(jobRow(job));
}

function kv(pairs) {
  const dl = el("dl", "kv");
  for (const [k, v] of pairs) {
    if (v === null || v === undefined || v === "") continue;
    dl.appendChild(el("dt", null, k));
    const dd = el("dd");
    if (v instanceof HTMLElement) dd.appendChild(v);
    else dd.textContent = String(v);
    dl.appendChild(dd);
  }
  return dl;
}

function link(href, text) {
  const a = el("a", null, text ?? href);
  a.href = href;
  a.target = "_blank";
  a.rel = "noreferrer noopener";
  return a;
}

function renderMetrics(metrics) {
  if (!metrics) return el("p", "muted", "指標はまだありません（Artifact 検証後に反映されます）。");
  const box = el("div");
  box.appendChild(
    kv([
      ["指標の出所", metrics.source === "artifact-verified" ? "Artifact 検証済み（信頼）" : "ランナー報告（参考情報・未検証）"],
      ["モデル", metrics.model],
      ["opencode", metrics.opencodeVersion],
      ["状態", metrics.status],
      ["exit code", metrics.exitCode],
      ["理由", metrics.reason],
      ["手順数", metrics.steps],
      ["トークン", metrics.tokens],
      ["コスト", metrics.costUsd === null || metrics.costUsd === undefined ? null : `$${metrics.costUsd}`],
      ["検証", metrics.verification ? `${metrics.verification.cmd} → exit ${metrics.verification.exitCode} (${metrics.verification.status})` : null],
      ["変更ファイル", (metrics.changedPaths ?? []).join(", ")],
      ["契約チェック", metrics.contract ? (metrics.contract.ok ? "合格" : `不合格: ${metrics.contract.reasons.join("; ")}`) : null],
    ]),
  );
  if (metrics.summary) {
    const d = el("details");
    d.appendChild(el("summary", null, "summary.md"));
    d.appendChild(el("pre", "pane", metrics.summary));
    box.appendChild(d);
  }
  if (metrics.diff) {
    const d = el("details");
    d.appendChild(el("summary", null, `diff.patch（${metrics.diff.length} 文字まで表示）`));
    d.appendChild(el("pre", "pane", metrics.diff));
    box.appendChild(d);
  }
  return box;
}

function renderAttempt(attempt) {
  const box = el("div", "attempt");
  const head = el("div", "attempt-head");
  head.appendChild(pill(attempt.state));
  head.appendChild(el("span", "muted", `#${attempt.n} · ${attempt.marker}`));
  if (attempt.run_url) head.appendChild(link(attempt.run_url, `run ${attempt.run_id}`));
  if (attempt.conclusion) head.appendChild(el("span", "muted", `conclusion: ${attempt.conclusion}`));
  box.appendChild(head);
  if (attempt.error) box.appendChild(el("p", "error", attempt.error));
  box.appendChild(el("p", "muted", `dispatch: ${fmtTime(attempt.dispatched_at)} · heartbeat: ${fmtTime(attempt.heartbeat_at)}`));
  box.appendChild(renderMetrics(attempt.metrics));
  return box;
}

function renderEvents(events) {
  const box = el("div");
  for (const event of [...events].reverse()) {
    const row = el("div", "event");
    row.appendChild(el("span", "muted", `${fmtTime(event.at)} · ${event.kind}${event.message ? " · " : ""}`));
    if (event.message) row.appendChild(el("span", null, event.message));
    box.appendChild(row);
  }
  return box;
}

async function showDetail(id) {
  state.selected = id;
  $("detail").classList.remove("hidden");
  try {
    const view = await api(`/api/jobs/${encodeURIComponent(id)}`);
    const job = view.job;
    $("detail-title").textContent = job.id;
    const body = $("detail-body");
    body.textContent = "";

    body.appendChild(
      kv([
        ["状態", pill(job.state)],
        ["ゴール", job.goal],
        ["エージェント", job.agent ?? "opencode"],
        ["モデル", job.model],
        ["検証コマンド", job.verify_cmd],
        ["タイムアウト", `${job.timeout_sec}秒`],
        ["試行", `${job.attempt_count}/${job.max_attempts}`],
        ["作成", fmtTime(job.created_at)],
        ["終了", job.finished_at ? fmtTime(job.finished_at) : null],
        ["所要", fmtDuration(job.created_at, job.finished_at)],
        ["コスト", `$${job.cost_usd ?? 0}`],
        ["トークン", job.tokens_total],
        ["run", job.run_url ? link(job.run_url, job.run_url) : null],
        ["Artifact", job.artifact_name],
        ["外部操作", job.allow_external ? `承認待ち機能あり（${job.approved_at ? `承認済み ${fmtTime(job.approved_at)} by ${job.approved_by}` : "未承認"}）` : null],
        ["最終エラー", job.last_error],
        ["独立検証", job.verification ? (job.verification.ok ? "合格" : `不合格: ${job.verification.reasons.join("; ")}`) : null],
      ]),
    );

    const actions = el("div", "actions");
    const addAction = (label, className, fn) => {
      const b = el("button", className, label);
      b.type = "button";
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          await fn();
          await showDetail(id);
          await refresh();
        } catch (e) {
          alert(e.message);
        } finally {
          b.disabled = false;
        }
      });
      actions.appendChild(b);
    };
    if (job.state === "awaiting_approval") {
      addAction("承認してキューへ", null, () => api(`/api/jobs/${job.id}/approve`, { method: "POST", body: {} }));
    }
    if (!["succeeded", "failed", "cancelled"].includes(job.state)) {
      addAction("キャンセル", "danger", () => {
        if (!confirm("このジョブをキャンセルしますか？")) throw new Error("cancel aborted");
        return api(`/api/jobs/${job.id}/cancel`, { method: "POST", body: {} });
      });
    }
    if (job.state === "unknown") {
      addAction("再試行を許可（新しい試行）", null, () => api(`/api/jobs/${job.id}/resolve`, { method: "POST", body: { outcome: "retry" } }));
      addAction("成功として確定", null, () => api(`/api/jobs/${job.id}/resolve`, { method: "POST", body: { outcome: "succeeded", note: "dashboard での人手確認" } }));
      addAction("失敗として確定", "danger", () => api(`/api/jobs/${job.id}/resolve`, { method: "POST", body: { outcome: "failed", note: "dashboard での人手確認" } }));
    }
    body.appendChild(actions);

    const attemptsTitle = el("h3", null, `試行 (${view.attempts.length})`);
    body.appendChild(attemptsTitle);
    for (const attempt of view.attempts) body.appendChild(renderAttempt(attempt));

    const eventsTitle = el("h3", null, `イベント (${view.events.length})`);
    body.appendChild(eventsTitle);
    body.appendChild(renderEvents(view.events));
  } catch (e) {
    $("detail-body").textContent = e.message;
  }
}

function renderConfig(config) {
  state.config = config;
  state.agents = (config.agents ?? []).length
    ? config.agents
    : [
        {
          id: "opencode",
          label: "OpenCode",
          available: true,
          models: config.free_models ?? [],
        },
      ];

  // Rebuild only when the data changed: a 5 s poll must not reset a choice the
  // user is in the middle of making.
  const agentSelect = $("agent");
  const signature = state.agents.map((a) => `${a.id}:${a.available}:${(a.models ?? []).length}`).join("|");
  if (agentSelect.dataset.signature !== signature) {
    const previous = agentSelect.value;
    agentSelect.textContent = "";
    for (const agent of state.agents) {
      const option = el("option", null, agent.available ? agent.label : `${agent.label}（未対応）`);
      option.value = agent.id;
      option.disabled = !agent.available;
      if (agent.reason) option.title = agent.reason;
      agentSelect.appendChild(option);
    }
    const keep = state.agents.find((a) => a.id === previous && a.available);
    const first = state.agents.find((a) => a.available);
    if (keep) agentSelect.value = keep.id;
    else if (first) agentSelect.value = first.id;
    agentSelect.dataset.signature = signature;
    renderModelOptions();
  }
}

function renderModelOptions() {
  const agent = state.agents.find((a) => a.id === $("agent").value);
  const models = agent?.models ?? [];
  const select = $("model");
  const previous = select.value;
  select.textContent = "";
  for (const model of models) {
    const option = el("option", null, model);
    option.value = model;
    select.appendChild(option);
  }
  if (previous && models.includes(previous)) select.value = previous;
  if (!models.length) {
    const option = el("option", null, "無料モデルの allowlist がありません");
    option.value = "";
    option.disabled = true;
    select.appendChild(option);
  }
}

async function createJob(event) {
  event.preventDefault();
  $("job-error").textContent = "";
  const body = {
    goal: $("goal").value.trim(),
    agent: $("agent").value,
    model: $("model").value,
    verify_cmd: $("verify").value.trim() || null,
    timeout_sec: Number($("timeout").value),
    max_attempts: Number($("attempts").value),
    allow_external: $("external").checked,
  };
  try {
    const created = await api("/api/jobs", { method: "POST", body });
    $("goal").value = "";
    $("verify").value = "";
    $("external").checked = false;
    await refresh();
    await showDetail(created.job.id);
  } catch (e) {
    $("job-error").textContent = e.message;
  }
}

function renderPager() {
  const from = state.total === 0 ? 0 : state.offset + 1;
  const to = state.offset + state.jobs.length;
  $("page-info").textContent = `${from}-${to} / ${state.total} 件`;
  $("prev-page").disabled = state.offset <= 0;
  $("next-page").disabled = !state.hasMore;
}

async function refresh() {
  if (!state.signedIn) return;
  const params = new URLSearchParams();
  if (state.filter !== "all") params.set("state", state.filter);
  if (state.q) params.set("q", state.q);
  params.set("limit", String(state.pageSize));
  params.set("offset", String(state.offset));
  const [stats, list, config] = await Promise.all([api("/api/stats"), api(`/api/jobs?${params}`), api("/api/config")]);
  state.jobs = list.jobs;
  state.total = list.total ?? list.jobs.length;
  state.hasMore = Boolean(list.has_more);
  if (!state.jobs.length && state.offset > 0) {
    // The page emptied under us (jobs pruned or filter changed): step back once.
    state.offset = Math.max(0, state.offset - state.pageSize);
    return refresh();
  }
  renderStats(stats);
  renderJobs();
  renderPager();
  renderConfig(config);
  state.lastUpdated = new Date();
  setConn(true, `最終更新 ${state.lastUpdated.toLocaleTimeString()}`);
  if (state.selected && !$("detail").classList.contains("hidden")) await showDetail(state.selected);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("oc24-theme", theme);
  } catch {
    /* private mode: keep the in-memory theme only */
  }
}

function init() {
  let theme = "dark";
  try {
    theme = localStorage.getItem("oc24-theme") ?? "dark";
  } catch {
    theme = "dark";
  }
  applyTheme(theme);
  $("theme-toggle").addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
  $("login-btn").addEventListener("click", login);
  $("token").addEventListener("keydown", (e) => {
    if (e.key === "Enter") login();
  });
  $("logout").addEventListener("click", logout);
  $("job-form").addEventListener("submit", createJob);
  $("agent").addEventListener("change", renderModelOptions);
  let searchTimer = null;
  $("search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    // Debounce: one request after the typing stops, not one per keystroke.
    searchTimer = setTimeout(() => {
      state.q = $("search").value.trim();
      state.offset = 0;
      refresh().catch((e) => setConn(false, e.message));
    }, 300);
  });
  $("prev-page").addEventListener("click", () => {
    state.offset = Math.max(0, state.offset - state.pageSize);
    refresh().catch((e) => setConn(false, e.message));
  });
  $("next-page").addEventListener("click", () => {
    state.offset += state.pageSize;
    refresh().catch((e) => setConn(false, e.message));
  });
  $("close-detail").addEventListener("click", () => {
    $("detail").classList.add("hidden");
    state.selected = null;
  });
  renderFilters();
  // An existing session cookie means the dashboard opens straight into data.
  fetch("/api/stats", { credentials: "same-origin" })
    .then((res) => (res.ok ? signedIn() : signedOut()))
    .catch(() => signedOut());
}

init();
