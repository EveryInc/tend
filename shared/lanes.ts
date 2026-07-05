import type { AgentPresence, ThreadBinding, WorkAgent, WorkItem } from "./types";

export function effectiveWorkLane(work: Pick<WorkItem, "assignee">, thread: Pick<ThreadBinding, "drainAgent">): WorkAgent {
  return work.assignee ?? thread.drainAgent ?? "codex";
}

export function agentLabel(agent: WorkAgent): string {
  return agent === "claude" ? "Claude" : "Codex";
}

export function parseWorkAgent(value: unknown): WorkAgent {
  if (value === "codex" || value === "claude") return value;
  throw new Error(`Unsupported agent: ${String(value)}`);
}

export function parseOptionalWorkAgent(value: unknown): WorkAgent | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return parseWorkAgent(value);
}

export function parseAgentPresence(value: unknown): AgentPresence["agent"] {
  if (value === "claude") return value;
  throw new Error(`Unsupported agent presence: ${String(value)}`);
}
