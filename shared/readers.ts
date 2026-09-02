/** A reader composes from one frozen packet; it never operates the feed. */
export interface ReaderConfig {
  id: string;
  label: string;
  adapter: "codex" | "claude";
  model: string;
  effort: string;
}

export type ReaderStatus = "queued" | "running" | "complete" | "failed" | "interrupted";

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
}

/** Minimal saved draft shape required before a reader card can be published. */
export interface ReaderDraft {
  id: string;
  title: string;
  face: string;
  [key: string]: unknown;
}
