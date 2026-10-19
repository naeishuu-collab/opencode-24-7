// Agent adapters: the only agent-specific data the controller needs.
//
// Adding Codex CLI / Claude Code / Gemini CLI means adding an entry here and a
// workflow that produces the same artifact contract (`job.json`, `summary.md`,
// `diff.patch`, `log.txt`). The state machine, the independent verification and
// the cost/allowlist policy in engine.mjs stay shared and unchanged.
//
// The controller never holds agent credentials. `authSecret` names the runner
// secret the workflow reads, so each agent's auth stays in its own workflow.
const OPENCODE = {
  id: "opencode",
  label: "OpenCode",
  available: true,
  workflow: "agent-job.yml",
  authSecret: "OPENCODE_AUTH_JSON",
  // "free-models" = runner/config/free-models.json, verified on 2026-10-18.
  modelsFrom: "free-models",
  limits: { timeoutSecMax: 3600, maxAttempts: 3 },
};

const PLANNED = [
  {
    id: "codex",
    label: "Codex CLI",
    available: false,
    workflow: null,
    authSecret: null,
    modelsFrom: null,
    limits: { timeoutSecMax: 3600, maxAttempts: 3 },
    reason: "adapter defined; free-tier availability, auth and terms not verified yet",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    available: false,
    workflow: null,
    authSecret: null,
    modelsFrom: null,
    limits: { timeoutSecMax: 3600, maxAttempts: 3 },
    reason: "adapter defined; free-tier availability, auth and terms not verified yet",
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    available: false,
    workflow: null,
    authSecret: null,
    modelsFrom: null,
    limits: { timeoutSecMax: 3600, maxAttempts: 3 },
    reason: "adapter defined; free-tier availability, auth and terms not verified yet",
  },
];

export const AGENTS = [OPENCODE, ...PLANNED];

export function getAgent(id) {
  return AGENTS.find((agent) => agent.id === id) ?? null;
}

// What the dashboard may show: no secrets, no workflow internals beyond the name.
export function agentList({ freeModels = [] } = {}) {
  return AGENTS.map((agent) => ({
    id: agent.id,
    label: agent.label,
    available: agent.available,
    reason: agent.reason ?? null,
    workflow: agent.workflow,
    models: agent.available && agent.modelsFrom === "free-models" ? freeModels : [],
    limits: agent.limits,
  }));
}

export function modelsFor(agent, { freeModels = [] } = {}) {
  return agent?.available && agent.modelsFrom === "free-models" ? freeModels : [];
}
