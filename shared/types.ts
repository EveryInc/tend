export type FeedId = string;
export type CardStatus = "to_review_new" | "to_review_updated" | "queued" | "working" | "approved_blocked" | "done";
export type CardKind = "attention" | "feed_improvement";
export type WorkStatus = "queued" | "working" | "approved_blocked" | "completed" | "failed" | "stale" | "cancelled";
export type WorkAgent = "codex" | "claude";
export type RoutineActionStatus = "proposed" | "queued" | "working" | "completed" | "failed" | "stale";
export type MindContextPublicationState = "fresh" | "stale" | "unavailable";
export type MindContextHealth = MindContextPublicationState | "never_published";
export type MindContextSignalKind = "changed_now" | "ongoing" | "unresolved";
export type MindContextObservationKind = "source_receipt" | "chronicle_ocr";
export type MindContextUseMode = "lens" | "research";
export type MindContextEffect = "selected" | "prioritized" | "reframed";
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
  | "video"
  | "chart"
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
  autoDrain?: {
    enabled: boolean;
    updatedAt: string;
  };
  agents?: {
    claude?: {
      threadId: string;
      boundAt: string;
    };
  };
  drainAgent?: WorkAgent;
}

export interface AgentPresence {
  agent: "claude";
  sessionId: string;
  label?: string;
  lastSeenAt: string;
}

export interface AgentWakeLine {
  seq: number;
  at: string;
  feedId: string;
  workId: string;
  kind: WorkItem["kind"];
  queued: number;
  threadId: string;
}

export type AgentPresenceLiveness = "live" | "stale" | "offline";

export interface WorkspaceAgentSummary {
  claude: {
    liveness: AgentPresenceLiveness;
    lastSeenAt: string | null;
    label?: string;
    // Agent-facing state so operators can see which Claude session last presented.
    sessionId?: string;
  };
}

export interface DrainState {
  status: "idle" | "running";
  lastDispatchedAt?: string;
  lastCompletedAt?: string;
  lastExitCode?: number;
  lastError?: string;
  consecutiveFailures?: number;
  cooldownUntil?: string;
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
  items?: Array<string | { label: string; detail?: string; checked?: boolean; href?: string }>;
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
  video?: {
    title: string;
    href: string;
  };
  chart?: {
    unit?: string;
    max: number;
    series: [{ label: string }, { label: string }];
    rows: Array<{ label: string; values: [number, number]; detail?: string }>;
    note?: string;
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

export interface MindContextObservation {
  id: string;
  kind: MindContextObservationKind;
  title: string;
  app?: string;
  artifact?: string;
  observedFrom: string;
  observedTo: string;
  excerpt: string;
  fullText?: string;
  href?: string;
  redactionCount?: number;
}

export interface MindContextSignal {
  id: string;
  kind: MindContextSignalKind;
  title: string;
  summary: string;
  observationIds: string[];
}

export interface MindContextPublicationInput {
  id: string;
  sourceThreadId: string;
  state: MindContextPublicationState;
  publishedAt: string;
  observedFrom?: string;
  observedTo?: string;
  summary?: string;
  signals?: MindContextSignal[];
  observations?: MindContextObservation[];
  reason?: string;
}

export interface MindContextUpdate extends MindContextPublicationInput {
  contentDigest: string;
  freshUntil?: string;
  lastFreshUpdateId?: string;
}

export interface MindContextPublicationReceipt {
  id: string;
  state: MindContextPublicationState;
  publishedAt: string;
  freshUntil?: string;
  summary?: string;
  reason?: string;
  signalCount: number;
  sourceCount: number;
  redactionCount: number;
  contentDigest: string;
}

export interface MindContextBinding {
  publisherThreadId: string | null;
  boundAt: string | null;
}

export interface MindContextHistoryItem {
  id: string;
  state: MindContextPublicationState;
  publishedAt: string;
  observedFrom?: string;
  observedTo?: string;
  summary?: string;
  reason?: string;
  signalCount: number;
  sourceCount: number;
}

export interface MindContextWorkspace {
  health: MindContextHealth;
  binding: MindContextBinding;
  current: MindContextUpdate | null;
  lastFresh: MindContextHistoryItem | null;
  history: MindContextHistoryItem[];
}

export type MindContextFeedObservation = Omit<MindContextObservation, "fullText">;

export interface FeedMindContextUpdate {
  id: string;
  publishedAt: string;
  observedFrom: string;
  observedTo: string;
  freshUntil: string;
  summary: string;
  signals: MindContextSignal[];
  observations: MindContextFeedObservation[];
}

export interface FeedMindContext {
  health: MindContextHealth;
  update: FeedMindContextUpdate | null;
  lastFreshPublishedAt: string | null;
  guidance: {
    boundary: string;
    lens: string;
    research: string;
  };
}

export interface SourceRunContextUse {
  updateId: string;
  mode: MindContextUseMode;
  signalIds: string[];
  researchQuestion?: string;
}

export interface CardContextInfluence {
  updateId: string;
  signalIds: string[];
  mode: MindContextUseMode;
  effect: MindContextEffect;
  summary: string;
  researchQuestion?: string;
  sourceCount?: number;
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
  sourceRunIds?: string[];
  contextInfluence?: CardContextInfluence;
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

export interface WorkClaimant {
  agent: WorkAgent;
  threadId: string;
  sessionId?: string;
}

export interface WorkItem {
  id: string;
  feedId: FeedId;
  cardId: string;
  kind: "instruction" | "scoped_instruction" | "execute_approved_action" | "default_cleanup" | "routine_action_batch" | "compound_learnings";
  instruction: string;
  assignee?: WorkAgent;
  claimedBy?: WorkClaimant;
  target?: VoiceTarget;
  intent?: "voice_instruction" | "sweep_rejudge" | "recollect_sources";
  feedbackId?: string;
  startingBatchId?: string | null;
  previousSweepState?: SweepState;
  status: WorkStatus;
  capabilityToken: string;
  approvalDigest?: string;
  completionCleanup?: string;
  cardActionId?: string;
  routineActionGroupId?: string;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  completedAt?: string;
  response?: string;
  postAction?: PostActionCompletion;
  error?: string;
  verifiedAt?: string;
  verifiedApprovalDigest?: string;
  verifiedMailbox?: string;
  sourceMobileCommandId?: string;
}

export type WorkItemView = Omit<WorkItem, "capabilityToken">;

export interface WorkClaimedByReport {
  claim: "claimed_by_other";
  workId: string;
  feedId: FeedId;
  cardId: string;
  kind: WorkItem["kind"];
  status: "working";
  assignee?: WorkAgent;
  claimedAt?: string;
  claimedBy: WorkClaimant;
  message: string;
}

export type WorkClaimResult = WorkItem | WorkClaimedByReport | null;

export interface PostActionCompletion {
  cleanup: {
    status: "completed" | "not_required" | "blocked";
    detail: string;
  };
  disposition: "done" | "review";
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
  contextUpdateId?: string;
  triggerWorkId?: string;
  createdAt: string;
}

export interface SourceRun {
  id: string;
  feedId: FeedId;
  sourceId: string;
  snapshots: number;
  judgments: unknown[];
  contextUse?: SourceRunContextUse;
  triggerWorkId?: string;
  completedAt?: string;
}

export interface AppFeedback {
  id: string;
  feedId: FeedId;
  title: string;
  detail: string;
  sourceThreadId?: string;
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt?: string;
  resolution?: string;
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
  runs: SourceRun[];
  routineActions: RoutineActionGroup[];
  work: WorkItemView[];
  sweep: SweepState;
  drain: DrainState;
  readyNextPass: number;
}

export interface WorkspaceView {
  feeds: Array<{ id: string; name: string; purpose: string }>;
  active: FeedView;
  agents?: WorkspaceAgentSummary;
  dictation: DictationCapability;
  proposals: RevisionProposal[];
}
