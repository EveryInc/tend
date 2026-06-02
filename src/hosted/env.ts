import type {
  Card,
  CardBlock,
  FeedConfig,
  ProposedAction,
  RevisionProposal,
  RoutineActionGroup,
  SourceRecipe,
  SweepBatch,
  SweepFeedbackTrace,
  SweepState,
  ThreadBinding,
  VoiceTarget,
  WorkItem,
  WorkspaceRevision,
} from "../types";

export interface HostedEnv {
  DB: D1Database;
  ACCOUNT_DO: DurableObjectNamespace;
  FEED_DO: DurableObjectNamespace;
  ASSETS: Fetcher;
  RAW_EVIDENCE?: R2Bucket;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  ATTENTION_DEV_AUTH?: string;
}

export interface HostedSession {
  userId: string;
  accountId: string;
  email?: string;
}

export interface AccountRegistryFeed {
  id: string;
  name: string;
  purpose: string;
  doName: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountWorkspaceState {
  version: 1;
  accountId: string;
  feedIds: string[];
  globalPolicy: string;
  prompts: Record<string, string>;
  revisionProposals: Record<string, RevisionProposal>;
  workspaceRevisions: Record<string, WorkspaceRevision>;
  createdAt: string;
  updatedAt: string;
}

export interface FeedState {
  config: FeedConfig;
  thread: ThreadBinding;
  policy: string;
  sources: SourceRecipe[];
  cards: Record<string, Card>;
  routineActions: Record<string, RoutineActionGroup>;
  work: Record<string, WorkItem>;
  events: Array<{ id: string; at: string; type: string; feedId: string; cardId?: string; workId?: string; detail?: unknown }>;
  policyRevisions: Record<string, unknown>;
  checkpoints: Record<string, unknown>;
  runs: Record<string, unknown>;
  sweep: SweepState;
  sweepFeedback: Record<string, SweepFeedbackTrace>;
  sweepBatches: Record<string, SweepBatch>;
  revisionProposals: Record<string, RevisionProposal>;
  workspaceRevisions: Record<string, WorkspaceRevision>;
  prompts: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface HostedCardInput {
  id: string;
  kind?: Card["kind"];
  status?: Card["status"];
  eyebrow?: string;
  title: string;
  why: string;
  blocks: CardBlock[];
  proposedAction?: ProposedAction;
  actions?: Card["actions"];
  sourceMailbox?: string;
  routineActionGroupId?: string;
  sweep?: Card["sweep"];
  readyForPass?: number;
  completedAt?: string;
}

export type HostedRevisionTarget = VoiceTarget;
