import type { Card, CardBlock, FeedConfig, ProposedAction, RoutineActionGroup, SweepFeedbackTrace, WorkClaimResult, WorkClaimedByReport, WorkItem, WorkItemView } from "../shared/types";
import { actionEmailRecipients } from "../shared/emailRecipients";
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

export interface ClaimedWorkOutput extends Omit<WorkItem, "emailDeliveryPreparation" | "emailDeliveryReceipt"> {
  operatorGuidance?: {
    replyDraftSender?: string;
    userAuthorization?: UserAuthorizationReceipt;
    requiredWriteBack?: string;
    completionPrerequisite?: string;
    visibleCardIds?: string[];
    sourceRunRule?: string;
    postActionRule?: string;
    voicePreparationRule?: string;
    emailDeliveryRule?: string;
    readingCardRule?: string;
    readingFeedbackRule?: string;
  };
}

export interface WorkClaimContext {
  card?: Card;
  feedConfig?: Pick<FeedConfig, "defaultCleanup">;
  routineActionGroup?: RoutineActionGroup;
  sweepFeedback?: Pick<SweepFeedbackTrace, "visibleCardIds">;
}

export interface UserAuthorizationReceipt {
  kind: "tend_action_click" | "tend_voice_instruction";
  scope: "tend_workflow";
  connectorAuthorization: "not_attested";
  statement: string;
  // Final within Tend; this does not waive a connector's own approval requirement.
  noSecondChatConfirmationNeeded: true;
  actionLabel: string;
  approvedAt: string;
  approvalDigest: string;
  approvalInstruction?: string;
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
  exactApprovedAttachments?: CardBlock[];
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

const RECEIPT_AUTHORITY = "This is final approval within Tend. A second Tend confirmation is unnecessary; this receipt does not attest connector authorization or override a connector denial.";

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

function riskConfirmation(card: Card, action: ProposedAction, approvalSource: WorkItem["approvalSource"]): UserAuthorizationReceipt["riskConfirmation"] | undefined {
  if (!action.externalMutation) return undefined;
  const recipients = actionEmailRecipients(card, action);
  if (!recipients.length) return undefined;
  const verb = /\bforward/i.test(`${action.label} ${action.instruction}`) ? "forwarding" : "sending";
  return {
    kind: "external_recipient",
    recipients,
    statement: `The approved Tend action snapshot named recipient(s) ${recipients.join(", ")}. The user's ${approvalSource === "voice_instruction" ? "explicit card-scoped instruction" : "click"} recorded approval in Tend for ${verb} the exact content to those recipient(s) while action:verify still matches. This does not establish a connector-native risk confirmation.`,
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
    const risk = riskConfirmation(context.card, action, work.approvalSource);
    const voiceApproval = work.approvalSource === "voice_instruction" && Boolean(work.approvalInstruction);
    return {
      kind: voiceApproval ? "tend_voice_instruction" : "tend_action_click",
      scope: "tend_workflow",
      connectorAuthorization: "not_attested",
      statement: `${voiceApproval
        ? `The user submitted the explicit card-scoped instruction "${work.approvalInstruction}" in Tend at ${approvedAt}`
        : `The user clicked "${action.label}" in Tend at ${approvedAt}`} and authorized this one external mutation for "${context.card.title}".${work.completionCleanup ? ` If the action succeeds, this approval also includes the configured completion cleanup: "${work.completionCleanup}".` : ""}${risk ? ` ${risk.statement}` : ""} ${RECEIPT_AUTHORITY}`,
      noSecondChatConfirmationNeeded: true,
      actionLabel: action.label,
      approvedAt,
      approvalDigest: work.approvalDigest,
      ...(voiceApproval ? { approvalInstruction: work.approvalInstruction } : {}),
      workKind: work.kind,
      card: cardReceipt(context.card),
      ...(context.card.sourceMailbox ? { sourceMailbox: context.card.sourceMailbox } : {}),
      ...(artifact ? { exactApprovedArtifact: artifactReceipt(artifact) } : {}),
      ...(context.card.blocks.some((block) => block.type === "image") ? { exactApprovedAttachments: context.card.blocks.filter((block) => block.type === "image") } : {}),
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
      scope: "tend_workflow",
      connectorAuthorization: "not_attested",
      statement: `The user clicked "${label}" in Tend at ${approvedAt} and authorized this one cleanup action for "${context.card.title}". ${RECEIPT_AUTHORITY}`,
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
      scope: "tend_workflow",
      connectorAuthorization: "not_attested",
      statement: `The user clicked "${context.routineActionGroup.proposedAction.label}" in Tend at ${approvedAt} and authorized this one routine-action batch. ${RECEIPT_AUTHORITY}`,
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
    if (userAuthorization.sourceMailbox && userAuthorization.exactApprovedArtifact?.type === "editable_text") {
      operatorGuidance.emailDeliveryRule = "EMAIL SEND GATE: action:verify returns emailDelivery with the only payload authorized for this send. Pass its multipart/alternative payload, fromAddress, recipients, and attachments to the connector unchanged. Then read the delivered message back and use --result-file to report its actual sender, recipients, MIME parts, and attachment metadata in emailDeliveryReadback; retain the verified version, approvalDigest, and payloadDigest, and add source=connector_readback, providerMessageId, and readAt. Never synthesize the readback from the proposed draft. Tend rejects text-only MIME or any sender, recipient, body, attachment, or approval-digest mismatch. A direct connector call outside Tend is outside this gate.";
    }
  }

  if (work.kind === "execute_approved_action" && work.completionCleanup) {
    operatorGuidance.completionPrerequisite = `After the approved action succeeds, perform the bundled completion cleanup "${work.completionCleanup}" and verify its authoritative outcome. Do not ask the user to click Archive separately.`;
    operatorGuidance.postActionRule = 'Complete with `--result \'{"response":"...","postAction":{"cleanup":{"status":"completed","detail":"fresh verification evidence"},"disposition":"done"}}\'`. Use cleanup status `not_required` only when the user asked to preserve the source or the configured cleanup genuinely does not apply. If the main action succeeded but cleanup failed, use status `blocked`; Tend will preserve the successful action and require `work:reconcile-approved` after retrying cleanup, rather than repeating the main action. Use disposition `review` only when a concrete next step remains.';
  }

  if (work.kind === "scoped_instruction" && work.intent === "voice_instruction" && work.target?.kind === "card") {
    operatorGuidance.voicePreparationRule = "This card-scoped instruction is not an approved external action. If it asks for a mutation whose exact action was not already visible, prepare the exact proposedAction/actions and complete this work with that updated card returned to review. Do not execute it, call action:verify, call work:block, or fail merely because approval is still needed. Only a later digest-bound approval may authorize the prepared action.";
  }

  if (work.intent === "sweep_rejudge") {
    operatorGuidance.requiredWriteBack = "Run `tend cli sweep:rejudge --feed <feed> --feedback <feedbackId> --ordered-cards <json-array-of-original-visible-card-ids> --removed-cards <json-array-of-original-visible-card-ids>` before `work:complete`.";
    operatorGuidance.completionPrerequisite = "The rejudge must account for the feedback trace's original visibleCardIds exactly once. Do not include cards created while handling this work unless they were already in visibleCardIds.";
    operatorGuidance.visibleCardIds = context.sweepFeedback?.visibleCardIds;
  }

  if (work.intent === "recollect_sources") {
    operatorGuidance.requiredWriteBack = "Record one or more source runs with `source:record-run --work <workId>`, then create a sweep batch with `sweep:record-batch --work <workId>` before `work:complete`.";
    operatorGuidance.sourceRunRule = feedId === "inbox"
      ? "For a full Gmail sweep, first paginate gmail_search_email_ids(query='', label_ids=['INBOX']). Treat that message-ID manifest as authoritative, direct-read every ID, and record an inboxEnumeration.messages entry mapping each messageId to its threadId. Its readThreadIds and carriedForwardThreadIds must then classify every resulting thread exactly once. gmail_search_emails results may enrich the run but cannot define the Inbox universe. Source recollection must complete with a new sweep batch recorded for this exact work item."
      : "Source recollection work must complete with a new sweep batch recorded for this exact work item.";
  }

  if (work.readingCard) {
    operatorGuidance.readingCardRule = "readingCard is the exact published face and writer for this voice instruction, even if a Like previously archived it. Preserve that immutable card. Complete feedback work with a response; any corrected card needs a new id and source-backed publication. This instruction does not change the external-action approval rules.";
  }
  if (work.kind === "compound_learnings" && work.learningContext?.readingFeedbackEvents.length) {
    operatorGuidance.readingFeedbackRule = "Review learningContext.readingFeedbackEvents, including archived Likes, exact compared-face preferences, and voice comments. A cleared reaction or an untouched card is not a dislike; neither is an alternative to a preferred version. Do not invent reasons for taps. Use the latest explicit reaction per card (highest reactionSequence), and the latest preference per run/topic group (highest preferenceSequence), scoped only to its exact member IDs and revisions. Join voice feedback by cardId and contentRevision. Return a policy proposal for approval, never an automatic policy change.";
  }

  const hasGuidance = Object.keys(operatorGuidance).length > 0;
  if (!hasGuidance && !work.emailDeliveryPreparation && !work.emailDeliveryReceipt) return work;
  const {
    emailDeliveryPreparation: _emailDeliveryPreparation,
    emailDeliveryReceipt: _emailDeliveryReceipt,
    ...claim
  } = work;
  return hasGuidance ? { ...claim, operatorGuidance } : claim;
}
