import type {
  CardBlock,
  CardContextInfluence,
  CardKind,
  CardStatus,
  MindContextHealth,
  MindContextHistoryItem,
  MindContextObservation,
  MindContextSignal,
  RoutineActionStatus,
  WorkStatus,
} from "./types";

export const MOBILE_SCHEMA_VERSION = 1;

export type MobileItemKind = CardKind | "routine_action_group";
export type MobileCommandKind =
  | "archive"
  | "dismiss"
  | "instruction"
  | "approve_action"
  | "approve_routine_action"
  | "edit_queued_instruction"
  | "return_to_review";
export type MobileCommandState = "pending" | "claimed" | "applied" | "rejected" | "cancelled";

export interface MobileEvidenceItem {
  label: string;
  detail?: string;
  checked?: boolean;
  href?: string;
  linkAvailability?: "external" | "mac_only";
}

export type MobileCardBlock = Omit<CardBlock, "items" | "profile" | "video"> & {
  items?: Array<string | MobileEvidenceItem>;
  profile?: {
    name: string;
    subtitle?: string;
    href?: string;
    imageUrl?: string;
    fallbackImageUrl?: string;
    links?: Array<{ label: string; href?: string; linkAvailability?: "external" | "mac_only" }>;
  };
  video?: {
    title: string;
    href?: string;
    linkAvailability?: "external" | "mac_only";
  };
};

export interface MobileActionConfirmation {
  kind: "external_recipient";
  title: string;
  message: string;
  recipients: string[];
}

export interface MobileActionProjection {
  id: string;
  label: string;
  behavior: "queue_instruction" | "approve_action" | "default_cleanup" | "dismiss_card";
  digest: string;
  artifactBlockId?: string;
  externalMutation?: boolean;
  variant?: "primary" | "secondary";
  confirmation?: MobileActionConfirmation;
}

export interface MobileWorkProjection {
  id: string;
  kind: string;
  status: WorkStatus;
  instruction?: string;
  digest: string;
  createdAt: string;
  updatedAt: string;
  response?: string;
  error?: string;
}

export interface MobileCardProjection {
  key: string;
  itemKind: MobileItemKind;
  feedId: string;
  cardId: string;
  routineActionGroupId?: string;
  feedGeneration: string;
  cardDigest: string;
  status: CardStatus | RoutineActionStatus;
  reviewPosition?: number;
  reviewable: boolean;
  title: string;
  eyebrow: string;
  why: string;
  sourceMailbox?: string;
  contextInfluence?: CardContextInfluence;
  blocks: MobileCardBlock[];
  actions: MobileActionProjection[];
  activeWork?: MobileWorkProjection;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  completionDisposition?: "completed" | "dismissed";
}

export interface MobileFeedProjection {
  id: string;
  name: string;
  purpose: string;
  position: number;
  currentPass: number;
  generation: string;
  reviewCount: number;
  queuedCount: number;
  workingCount: number;
  doneCount: number;
  latestCardTitle?: string;
  latestCardUpdatedAt?: string;
  updatedAt: string;
}

export interface MobileMindUpdate {
  id: string;
  state: "fresh";
  publishedAt: string;
  observedFrom: string;
  observedTo: string;
  summary: string;
  signals: MindContextSignal[];
  observations: MindContextObservation[];
  contentDigest: string;
  freshUntil?: string;
}

export interface MobileMindProjection {
  health: MindContextHealth;
  current: MobileMindUpdate | null;
  lastFresh: MindContextHistoryItem | null;
  history: MindContextHistoryItem[];
}

export interface MobileWorkspaceSnapshot {
  schemaVersion: typeof MOBILE_SCHEMA_VERSION;
  generation: string;
  generatedAt: string;
  feeds: MobileFeedProjection[];
  cards: MobileCardProjection[];
  mind: MobileMindProjection;
}

export interface MobileCommand {
  id: string;
  userId: string;
  clientRequestId: string;
  deviceId: string;
  feedId: string;
  cardId: string;
  feedGeneration: string;
  expectedCardDigest: string;
  kind: MobileCommandKind;
  actionId?: string;
  expectedActionDigest?: string;
  routineActionGroupId?: string;
  instruction?: string;
  edits?: Record<string, string>;
  targetWorkId?: string;
  expectedWorkDigest?: string;
  riskConfirmation?: {
    kind: "external_recipient";
    recipients: string[];
  };
  state: MobileCommandState;
  createdAt: string;
  availableAt: string;
  claimedAt?: string;
  leaseExpiresAt?: string;
}

export interface MobileCommandReceipt {
  commandId: string;
  feedId: string;
  cardId: string;
  kind: MobileCommandKind;
  state: "applied" | "rejected";
  appliedAt: string;
  workId?: string;
  error?: string;
}

export interface MobileCommandResult {
  receipt: MobileCommandReceipt;
  workId?: string;
}

export interface MobileSyncStatus {
  enabled: boolean;
  workerId?: string;
  lastPushAt?: string;
  lastPullAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  snapshotGeneration?: string;
}

export interface MobileCommandProgress {
  commandId: string;
  workId: string;
  workStatus: WorkStatus;
  response?: string;
  error?: string;
  updatedAt: string;
}
