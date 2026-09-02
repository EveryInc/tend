/** A reader composes from one frozen packet; it never operates the feed. */
export interface ReaderConfig {
  id: string;
  label: string;
  adapter: "codex" | "claude";
  model: string;
  effort: string;
}

export type ReaderStatus = "queued" | "running" | "complete" | "failed" | "interrupted";
export type ReaderFailureCode = "subscription_login_required";

export function readerLoginGuidance(adapter: ReaderConfig["adapter"]): { message: string; command: string } {
  const account = adapter === "claude" ? "Claude subscription" : "Codex ChatGPT account";
  return {
    message: `Sign in again to your ${account}, then explicitly retry only this reader. No automatic retry, model switch, or API-key fallback was attempted.`,
    command: adapter === "claude" ? "claude auth login" : "codex login",
  };
}

/** Stored on the existing SourceRun, with artifacts in its immutable raw snapshots. */
export interface ReaderReceipt {
  readerId: string;
  label: string;
  adapter: ReaderConfig["adapter"];
  requestedModel: string;
  requestedEffort: string;
  status: ReaderStatus;
  inputSha256: string;
  promptSha256?: string;
  inputSnapshotId: string;
  startedAt?: string;
  finishedAt?: string;
  actualModel?: string;
  actualEffort?: string;
  outputSha256?: string;
  outputSnapshotId?: string;
  authentication?: "claude_subscription" | "codex_login";
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  };
  error?: string;
  failureCode?: ReaderFailureCode;
}

/** Minimal saved draft shape required before a reader card can be published. */
export interface ReaderDraft {
  id: string;
  title: string;
  face: string;
  [key: string]: unknown;
}
