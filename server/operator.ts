import type { Card, CardBlock, FeedConfig, ProposedAction, RoutineActionGroup, SweepFeedbackTrace, WorkClaimResult, WorkClaimedByReport, WorkItem, WorkItemView } from "../shared/types";
import { actionDigest, cleanupDigest, configuredApprovalAction, routineActionDigest } from "./workflow/approvals";

export interface IdleWorkHandshake {
  status: "idle";
  next: "offer_compound_if_sweep_finished";
  message: string;
  compound: {
    meaning: string;
    ifApproved: string;
    ifApprovedWithSearch: string;
  };
}

export interface ClaimedWorkOutput extends WorkItem {
  operatorGuidance?: {
    replyDraftSender?: string;
    userAuthorization?: UserAuthorizationReceipt;
    requiredWriteBack?: string;
    completionPrerequisite?: string;
    visibleCardIds?: string[];
    sourceRunRule?: string;
    postActionRule?: string;
  };
}

export interface WorkClaimContext {
  card?: Card;
  feedConfig?: Pick<FeedConfig, "defaultCleanup">;
  routineActionGroup?: RoutineActionGroup;
  sweepFeedback?: Pick<SweepFeedbackTrace, "visibleCardIds">;
}

export interface UserAuthorizationReceipt {
  kind: "tend_action_click";
  statement: string;
  noSecondChatConfirmationNeeded: true;
  actionLabel: string;
  approvedAt: string;
  approvalDigest: string;
  workKind: WorkItem["kind"];
  card?: {
    id: string;
    title: string;
    eyebrow: string;
    sourceMailbox?: string;
  };
  routineActionGroup?: {
    id: string;
    label: string;
    summary: string;
    items: Array<{ id: string; title: string; reason: string }>;
  };
  sourceMailbox?: string;
  exactApprovedArtifact?: {
    id: string;
    type: CardBlock["type"];
    label?: string;
    value?: string;
    text?: string;
    items?: CardBlock["items"];
  };
  completionCleanup?: string;
  riskConfirmation?: {
    kind: "external_recipient";
    recipients: string[];
    statement: string;
  };
  invalidatesIf: string[];
}

const APPROVAL_INVALIDATIONS = [
  "the selected action changes",
  "the approved artifact changes",
  "the recipient or source context changes",
  "the source mailbox changes",
  "the approval digest no longer matches",
];

function artifactReceipt(block?: CardBlock): UserAuthorizationReceipt["exactApprovedArtifact"] | undefined {
  if (!block) return undefined;
  return {
    id: block.id,
    type: block.type,
    ...(block.label ? { label: block.label } : {}),
    ...(block.value !== undefined ? { value: block.value } : {}),
    ...(block.text !== undefined ? { text: block.text } : {}),
    ...(block.items !== undefined ? { items: block.items } : {}),
  };
}

function cardReceipt(card: Card): NonNullable<UserAuthorizationReceipt["card"]> {
  return {
    id: card.id,
    title: card.title,
    eyebrow: card.eyebrow,
    ...(card.sourceMailbox ? { sourceMailbox: card.sourceMailbox } : {}),
  };
}

function uniqueEmails(...values: Array<unknown>): string[] {
  const emails = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const match of value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
      emails.add(match[0].toLowerCase());
    }
  }
  return [...emails];
}

function riskConfirmation(card: Card, action: ProposedAction, artifact?: CardBlock): UserAuthorizationReceipt["riskConfirmation"] | undefined {
  if (!action.externalMutation) return undefined;
  const sourceMailbox = card.sourceMailbox?.trim().toLowerCase();
  const recipients = uniqueEmails(action.label, action.instruction, artifact?.value, artifact?.text)
    .filter((recipient) => recipient !== sourceMailbox);
  if (!recipients.length) return undefined;
  const verb = /\bforward/i.test(`${action.label} ${action.instruction}`) ? "forwarding" : "sending";
  return {
    kind: "external_recipient",
    recipients,
    statement: `The approved Tend action snapshot named external recipient(s) ${recipients.join(", ")}. The user click also confirmed the connector risk of ${verb} private inbound email to those recipient(s); no separate chat reconfirmation is required while action:verify still matches.`,
  };
}

function buildAuthorizationReceipt(work: WorkItem, context: WorkClaimContext): UserAuthorizationReceipt | undefined {
  if (!work.approvalDigest) return undefined;
  const approvedAt = work.createdAt;
  if (work.kind === "execute_approved_action") {
    if (!context.card) return undefined;
    let action: ProposedAction;
    try {
      action = configuredApprovalAction(context.card, work.cardActionId);
    } catch {
      return undefined;
    }
    if (work.approvalDigest !== actionDigest(context.card, work.cardActionId)) return undefined;
    const artifact = action.artifactBlockId ? context.card.blocks.find((block) => block.id === action.artifactBlockId) : undefined;
    const risk = riskConfirmation(context.card, action, artifact);
    return {
      kind: "tend_action_click",
      statement: `The user clicked "${action.label}" in Tend at ${approvedAt} and authorized this one external mutation for "${context.card.title}".${work.completionCleanup ? ` If the action succeeds, this approval also includes the configured completion cleanup: "${work.completionCleanup}".` : ""}${risk ? ` ${risk.statement}` : ""} This receipt is sufficient final approval; do not ask for a second chat confirmation.`,
      noSecondChatConfirmationNeeded: true,
      actionLabel: action.label,
      approvedAt,
      approvalDigest: work.approvalDigest,
      workKind: work.kind,
      card: cardReceipt(context.card),
      ...(context.card.sourceMailbox ? { sourceMailbox: context.card.sourceMailbox } : {}),
      ...(artifact ? { exactApprovedArtifact: artifactReceipt(artifact) } : {}),
      ...(work.completionCleanup ? { completionCleanup: work.completionCleanup } : {}),
      ...(risk ? { riskConfirmation: risk } : {}),
      invalidatesIf: APPROVAL_INVALIDATIONS,
    };
  }

  if (work.kind === "default_cleanup") {
    if (!context.card || !context.feedConfig) return undefined;
    if (work.instruction !== context.feedConfig.defaultCleanup || work.approvalDigest !== cleanupDigest(context.card, context.feedConfig.defaultCleanup)) return undefined;
    const label = context.card.actions?.find((action) => action.behavior === "default_cleanup")?.label ?? "Default cleanup";
    return {
      kind: "tend_action_click",
      statement: `The user clicked "${label}" in Tend at ${approvedAt} and authorized this one cleanup action for "${context.card.title}". This receipt is sufficient final approval; do not ask for a second chat confirmation.`,
      noSecondChatConfirmationNeeded: true,
      actionLabel: label,
      approvedAt,
      approvalDigest: work.approvalDigest,
      workKind: work.kind,
      card: cardReceipt(context.card),
      ...(context.card.sourceMailbox ? { sourceMailbox: context.card.sourceMailbox } : {}),
      invalidatesIf: APPROVAL_INVALIDATIONS,
    };
  }

  if (work.kind === "routine_action_batch") {
    if (!context.routineActionGroup) return undefined;
    if (work.approvalDigest !== routineActionDigest(context.routineActionGroup)) return undefined;
    return {
      kind: "tend_action_click",
      statement: `The user clicked "${context.routineActionGroup.proposedAction.label}" in Tend at ${approvedAt} and authorized this one routine-action batch. This receipt is sufficient final approval; do not ask for a second chat confirmation.`,
      noSecondChatConfirmationNeeded: true,
      actionLabel: context.routineActionGroup.proposedAction.label,
      approvedAt,
      approvalDigest: work.approvalDigest,
      workKind: work.kind,
      routineActionGroup: {
        id: context.routineActionGroup.id,
        label: context.routineActionGroup.label,
        summary: context.routineActionGroup.summary,
        items: context.routineActionGroup.items.map((item) => ({ id: item.id, title: item.title, reason: item.reason })),
      },
      invalidatesIf: APPROVAL_INVALIDATIONS,
    };
  }

  return undefined;
}

export function idleWorkHandshake(feedId: string): IdleWorkHandshake {
  return {
    status: "idle",
    next: "offer_compound_if_sweep_finished",
    message: 'If you completed or refreshed this feed during this turn, ask the user: "Want me to compound what I learned from this sweep?" If this wake began idle, stop quietly rather than repeating the question.',
    compound: {
      meaning: "Review this sweep's cards, feedback, outcomes, and prior policy. Distill an editable feed-policy proposal. Never apply it without user approval.",
      ifApproved: `Run \`tend cli learning:request --feed ${feedId}\`, drain the resulting compound_learnings job, and return the editable proposal for review.`,
      ifApprovedWithSearch: "Compound first. Recollect only after the reviewed policy proposal is applied, or after the user explicitly says to continue without applying it.",
    },
  };
}

export function formatWorkListOutput(feedId: string, work: WorkItemView[]): WorkItemView[] | IdleWorkHandshake {
  return work.length > 0 ? work : idleWorkHandshake(feedId);
}

export function formatWorkClaimOutput(feedId: string, work: WorkClaimResult, context: WorkClaimContext = {}): ClaimedWorkOutput | WorkClaimedByReport | IdleWorkHandshake {
  if (!work) return idleWorkHandshake(feedId);
  if ("claim" in work) return work;
  const operatorGuidance: NonNullable<ClaimedWorkOutput["operatorGuidance"]> = {};

  if (feedId === "inbox" && context.card?.sourceMailbox) {
    operatorGuidance.replyDraftSender = `Write any reply draft as the owner of sourceMailbox (${context.card.sourceMailbox}). Preserve that sender's voice and signature. Do not sign as an assistant or delegate unless the user's instruction explicitly changes sender.`;
  }

  const userAuthorization = buildAuthorizationReceipt(work, context);
  if (userAuthorization) {
    operatorGuidance.userAuthorization = userAuthorization;
  }

  if (work.kind === "execute_approved_action" && work.completionCleanup) {
    operatorGuidance.completionPrerequisite = `After the approved action succeeds, perform the bundled completion cleanup "${work.completionCleanup}" and verify its authoritative outcome. Do not ask the user to click Archive separately.`;
    operatorGuidance.postActionRule = 'Complete with `--result \'{"response":"...","postAction":{"cleanup":{"status":"completed","detail":"fresh verification evidence"},"disposition":"done"}}\'`. Use cleanup status `not_required` only when the user asked to preserve the source or the configured cleanup genuinely does not apply. If the main action succeeded but cleanup failed, use status `blocked`; Tend will preserve the successful action and require `work:reconcile-approved` after retrying cleanup, rather than repeating the main action. Use disposition `review` only when a concrete next step remains.';
  }

  if (work.intent === "sweep_rejudge") {
    operatorGuidance.requiredWriteBack = "Run `tend cli sweep:rejudge --feed <feed> --feedback <feedbackId> --ordered-cards <json-array-of-original-visible-card-ids> --removed-cards <json-array-of-original-visible-card-ids>` before `work:complete`.";
    operatorGuidance.completionPrerequisite = "The rejudge must account for the feedback trace's original visibleCardIds exactly once. Do not include cards created while handling this work unless they were already in visibleCardIds.";
    operatorGuidance.visibleCardIds = context.sweepFeedback?.visibleCardIds;
  }

  if (work.intent === "recollect_sources") {
    operatorGuidance.requiredWriteBack = "Record one or more source runs with `source:record-run --work <workId>`, then create a sweep batch with `sweep:record-batch --work <workId>` before `work:complete`.";
    operatorGuidance.sourceRunRule = "Source recollection work must complete with a new sweep batch recorded for this exact work item.";
  }

  return Object.keys(operatorGuidance).length ? { ...work, operatorGuidance } : work;
}
