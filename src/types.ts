export type FeedId = string;
export type CardStatus = "to_review_new" | "to_review_updated" | "queued" | "working" | "approved_blocked" | "done";
export type CardKind = "attention" | "feed_improvement";
export type WorkStatus = "queued" | "working" | "approved_blocked" | "completed" | "failed" | "stale" | "cancelled";
export type RoutineActionStatus = "proposed" | "queued" | "working" | "completed" | "failed" | "stale";
export type VoiceTarget =
  | { kind: "card"; feedId: string; cardId: string }
  | { kind: "sweep"; feedId: string; batchId?: string }
  | { kind: "feed"; feedId: string }
  | { kind: "source_recipe"; feedId: string; sourceId: string }
  | { kind: "prompt_layer"; feedId: string; promptId: string }
  | { kind: "global_prompt"; promptId: string }
  | { kind: "attention" };
export type BlockType =
  | "rich_text"
  | "evidence"
  | "editable_text"
  | "memo"
  | "options"
  | "checklist"
  | "diff"
  | "clarification"
  | "email_thread"
  | "profile"
  | "receipt";

export interface SourceRecipe {
  id: string;
  name: string;
  filename: string;
  checkpointFilename: string;
  summary: string;
}

export interface ThreadBinding {
  homeThreadId: string | null;
  boundAt: string | null;
  heartbeat: {
    status: "not_proposed" | "proposed" | "installed";
    cadence: string | null;
    automationId: string | null;
  };
}

export interface DictationCapability {
  provider: "monologue" | null;
  status: "not_checked" | "not_installed" | "detected_default" | "detected_configured" | "detected_unsupported";
  activationCode: string;
  activationLabel: string;
  source: "fallback" | "monologue_default" | "monologue_settings";
  detectedAt: string | null;
  note: string;
}

export interface FeedConfig {
  id: FeedId;
  name: string;
  purpose: string;
  defaultCleanup: string;
  currentPass: number;
  createdAt: string;
  updatedAt: string;
}

export interface CardBlock {
  id: string;
  type: BlockType;
  label?: string;
  title?: string;
  text?: string;
  value?: string;
  items?: Array<string | { label: string; detail?: string; checked?: boolean }>;
  before?: string;
  after?: string;
  editable?: boolean;
  profile?: {
    name: string;
    subtitle?: string;
    href: string;
    imageUrl: string;
    fallbackImageUrl?: string;
    links?: Array<{ label: string; href: string }>;
  };
}

export interface ProposedAction {
  label: string;
  instruction: string;
  artifactBlockId?: string;
  externalMutation?: boolean;
  mailboxPolicy?: "reply_from_source";
}

export interface CardAction {
  id: string;
  label: string;
  behavior: "queue_instruction" | "approve_action" | "default_cleanup";
  instruction?: string;
  artifactBlockId?: string;
  externalMutation?: boolean;
  mailboxPolicy?: "reply_from_source";
  variant?: "primary" | "secondary";
  shortcut?: string;
}

export interface Card {
  id: string;
  feedId: FeedId;
  kind: CardKind;
  status: CardStatus;
  title: string;
  eyebrow: string;
  why: string;
  sourceMailbox?: string;
  blocks: CardBlock[];
  proposedAction?: ProposedAction;
  actions?: CardAction[];
  readyForPass: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  routineActionGroupId?: string;
  history: Array<{ at: string; type: string; detail?: string }>;
  sweep?: {
    rank: number;
    hidden: boolean;
    feedbackId: string;
  };
}

export interface RoutineActionItem {
  id: string;
  cardId?: string;
  title: string;
  detail?: string;
  reason: string;
  sourceRefs?: Array<{ label: string; href: string }>;
}

export interface RoutineActionGroup {
  id: string;
  feedId: FeedId;
  label: string;
  summary: string;
  proposedAction: ProposedAction;
  items: RoutineActionItem[];
  status: RoutineActionStatus;
  createdAt: string;
  updatedAt: string;
  workId?: string;
  completedAt?: string;
  error?: string;
}

export interface WorkItem {
  id: string;
  feedId: FeedId;
  cardId: string;
  kind: "instruction" | "scoped_instruction" | "execute_approved_action" | "default_cleanup" | "routine_action_batch" | "compound_learnings";
  instruction: string;
  target?: VoiceTarget;
  intent?: "voice_instruction" | "sweep_rejudge" | "recollect_sources";
  feedbackId?: string;
  startingBatchId?: string | null;
  previousSweepState?: SweepState;
  status: WorkStatus;
  capabilityToken: string;
  approvalDigest?: string;
  cardActionId?: string;
  routineActionGroupId?: string;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  completedAt?: string;
  response?: string;
  error?: string;
  verifiedAt?: string;
  verifiedApprovalDigest?: string;
  verifiedMailbox?: string;
}

export interface FeedEvent {
  id: string;
  type: string;
  at: string;
  feedId: FeedId;
  cardId?: string;
  workId?: string;
  detail?: unknown;
}

export interface SweepState {
  currentBatchId: string | null;
  lastFeedbackId: string | null;
  recollectionOffered: boolean;
  statusMessage: string | null;
}

export interface SweepFeedbackTrace {
  id: string;
  feedId: FeedId;
  batchId?: string;
  instruction: string;
  visibleCardIds: string[];
  orderedCardIds: string[];
  removedCardIds: string[];
  createdAt: string;
  rejudgedAt?: string;
}

export interface SweepBatch {
  id: string;
  feedId: FeedId;
  sourceRunIds: string[];
  triggerWorkId?: string;
  createdAt: string;
}

export interface RevisionProposal {
  id: string;
  anchorFeedId: FeedId;
  target: VoiceTarget;
  label: string;
  instruction: string;
  previous: string;
  next: string;
  source: "voice" | "compound";
  status: "proposed" | "applied" | "rejected";
  createdAt: string;
  updatedAt?: string;
  appliedAt?: string;
  appliedRevisionId?: string;
  rejectedAt?: string;
}

export interface WorkspaceRevision {
  id: string;
  anchorFeedId: FeedId;
  target: VoiceTarget;
  previous: string;
  next: string;
  reason: string;
  source: "manual_edit" | "voice_proposal";
  status: "applied" | "reverted";
  createdAt: string;
  revertedAt?: string;
}

export interface PolicyRevision {
  id: string;
  feedId: FeedId;
  previous: string;
  next: string;
  reason: string;
  source: "micro_learning" | "compound" | "user_instruction" | "import";
  status: "applied" | "reverted";
  createdAt: string;
  revertedAt?: string;
}

export interface FeedView {
  config: FeedConfig;
  thread: ThreadBinding;
  sources: SourceRecipe[];
  policy: string;
  cards: Card[];
  routineActions: RoutineActionGroup[];
  work: WorkItem[];
  sweep: SweepState;
  readyNextPass: number;
}

export interface WorkspaceView {
  feeds: Array<{ id: string; name: string; purpose: string }>;
  active: FeedView;
  dictation: DictationCapability;
  proposals: RevisionProposal[];
}
