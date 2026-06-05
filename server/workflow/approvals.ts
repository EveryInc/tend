import type { Card, ProposedAction, RoutineActionGroup } from "../../shared/types";
import { digest } from "../util";

export function configuredApprovalAction(card: Card, cardActionId?: string): ProposedAction {
  if (!cardActionId) {
    if (!card.proposedAction) throw new Error("Card has no proposed action.");
    return card.proposedAction;
  }
  const action = card.actions?.find((item) => item.id === cardActionId);
  if (!action || action.behavior !== "approve_action" || !action.instruction?.trim()) {
    throw new Error("Card approval action not found.");
  }
  return {
    label: action.label,
    instruction: action.instruction,
    ...(action.artifactBlockId ? { artifactBlockId: action.artifactBlockId } : {}),
    ...(action.externalMutation !== undefined ? { externalMutation: action.externalMutation } : {}),
    ...(action.mailboxPolicy ? { mailboxPolicy: action.mailboxPolicy } : {}),
  };
}

export function requiredSourceMailbox(feedId: string, card: Card, action: ProposedAction): string | undefined {
  if (!requiresSourceMailboxMatch(feedId, action)) return undefined;
  const sourceMailbox = normalizeMailbox(card.sourceMailbox);
  if (!sourceMailbox) {
    throw new Error("Email reply is missing the mailbox that received the source email.");
  }
  return sourceMailbox;
}

export function verifySourceMailbox(feedId: string, card: Card, action: ProposedAction, authenticatedMailbox?: string): string | undefined {
  const sourceMailbox = requiredSourceMailbox(feedId, card, action);
  if (!sourceMailbox) return undefined;
  const authenticated = normalizeMailbox(authenticatedMailbox);
  if (!authenticated) {
    throw new Error(`Email reply verification requires the authenticated Gmail mailbox. Expected ${sourceMailbox}.`);
  }
  if (authenticated !== sourceMailbox) {
    throw new Error(`Authenticated Gmail mailbox mismatch: expected ${sourceMailbox}, got ${authenticated}.`);
  }
  return authenticated;
}

export function actionDigest(card: Card, cardActionId?: string): string {
  const action = configuredApprovalAction(card, cardActionId);
  const artifact = action?.artifactBlockId ? card.blocks.find((block) => block.id === action.artifactBlockId) : undefined;
  return digest({ cardActionId: cardActionId ?? null, action, artifact });
}

export function cleanupDigest(card: Card, instruction: string): string {
  return digest({
    instruction,
    card: {
      id: card.id,
      feedId: card.feedId,
      title: card.title,
      why: card.why,
      blocks: card.blocks,
      proposedAction: card.proposedAction,
      actions: card.actions,
    },
  });
}

export function routineActionDigest(group: RoutineActionGroup): string {
  return digest({
    feedId: group.feedId,
    id: group.id,
    label: group.label,
    summary: group.summary,
    proposedAction: group.proposedAction,
    items: group.items,
  });
}

function normalizeMailbox(mailbox?: string): string | undefined {
  const normalized = mailbox?.trim().toLowerCase();
  return normalized || undefined;
}

function requiresSourceMailboxMatch(feedId: string, action: ProposedAction): boolean {
  return action.mailboxPolicy === "reply_from_source" ||
    (feedId === "inbox" && action.externalMutation === true && Boolean(action.artifactBlockId));
}
