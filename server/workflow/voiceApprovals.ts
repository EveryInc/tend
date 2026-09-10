import { safeConfiguredCardActions } from "../../shared/cardActions";
import type { Card } from "../../shared/types";

export interface VoiceApprovalMatch {
  actionLabel: string;
  cardActionId?: string;
}

const DEFERRED_OR_UNCERTAIN = /\b(?:not yet|hold off|wait|later|after approval|after (?:i|we) (?:review|check|confirm)|before (?:i|we) (?:review|check|confirm))\b/;
const GENERIC_APPROVAL = /^(?:(?:yes|yep|yeah)[, ]+)?(?:(?:this|that|it)\s+)?(?:(?:is|looks|seems)\s+)?(?:fine|good|great|right|correct|okay|ok|approved)[.! ]*$/;
const GENERIC_COMMAND = /^(?:(?:yes|yep|yeah)[, ]+)?(?:go ahead|do it|approve it|you can do that|proceed)(?: now)?[.! ]*$/;

const ACTION_VERB_GROUPS: Array<{ label: RegExp; verbs: string[] }> = [
  { label: /\b(?:calendar|reminder|schedule|hold|book)\b/, verbs: ["add", "create", "schedule", "book", "put"] },
  { label: /\b(?:send|reply|email)\b/, verbs: ["send", "reply", "email"] },
  { label: /\bforward\b/, verbs: ["forward", "send"] },
  { label: /\b(?:post|publish)\b/, verbs: ["post", "publish"] },
  { label: /\b(?:share|invite)\b/, verbs: ["share", "invite"] },
  { label: /\b(?:buy|purchase)\b/, verbs: ["buy", "purchase"] },
  { label: /\b(?:sign|submit|file)\b/, verbs: ["sign", "submit", "file"] },
  { label: /\b(?:apply|update|move|upload|create|add|delete|remove|cancel|archive)\b/, verbs: [] },
];

const ACTION_VERBS = new Set([
  "add", "apply", "archive", "book", "buy", "cancel", "create", "delete", "email", "file",
  "forward", "invite", "move", "post", "publish", "purchase", "remove", "reply", "schedule",
  "send", "share", "sign", "submit", "update", "upload",
]);

export function matchExplicitVoiceApproval(card: Card, instruction: string): VoiceApprovalMatch | undefined {
  if (card.status !== "to_review_new" && card.status !== "to_review_updated") return undefined;
  const candidates = approvalCandidates(card);
  if (candidates.length !== 1) return undefined;

  const normalized = normalize(instruction);
  if (!normalized || DEFERRED_OR_UNCERTAIN.test(normalized)) return undefined;
  const candidate = candidates[0];

  if ((GENERIC_APPROVAL.test(normalized) || GENERIC_COMMAND.test(normalized)) && candidate.artifactBlockId) {
    const artifactExists = card.blocks.some((block) => block.id === candidate.artifactBlockId);
    if (artifactExists) return { actionLabel: candidate.actionLabel, ...(candidate.cardActionId ? { cardActionId: candidate.cardActionId } : {}) };
  }

  const verbs = actionVerbs(candidate.actionLabel);
  const clauses = normalizeClauses(instruction);
  if (!verbs.some((verb) => clauses.some((clause) => isDirectCommand(clause, verb) && !isNegated(clause, verb)))) return undefined;
  return { actionLabel: candidate.actionLabel, ...(candidate.cardActionId ? { cardActionId: candidate.cardActionId } : {}) };
}

export function hasVoiceApprovalCandidate(card: Card): boolean {
  return approvalCandidates(card).length > 0;
}

function approvalCandidates(card: Card): Array<VoiceApprovalMatch & { artifactBlockId?: string }> {
  const configured = safeConfiguredCardActions(card.actions);
  if (configured.length) {
    return configured
      .filter((action) => action.behavior === "approve_action" && action.instruction?.trim())
      .map((action) => ({
        actionLabel: action.label,
        cardActionId: action.id,
        ...(action.artifactBlockId ? { artifactBlockId: action.artifactBlockId } : {}),
      }));
  }
  if (!card.proposedAction || !card.proposedAction.instruction.trim()) return [];
  if (["Decide disposition", "Archive", "Archive this thread"].includes(card.proposedAction.label)) return [];
  return [{
    actionLabel: card.proposedAction.label,
    ...(card.proposedAction.artifactBlockId ? { artifactBlockId: card.proposedAction.artifactBlockId } : {}),
  }];
}

function actionVerbs(label: string): string[] {
  const normalized = normalize(label);
  const verbs = new Set(normalized.split(" ").filter((word) => ACTION_VERBS.has(word)));
  for (const group of ACTION_VERB_GROUPS) {
    if (!group.label.test(normalized)) continue;
    for (const verb of group.verbs) verbs.add(verb);
  }
  return [...verbs];
}

function isDirectCommand(instruction: string, verb: string): boolean {
  const escaped = escapeRegex(verb);
  return new RegExp(`^(?:(?:yes|yep|yeah)[, ]+)?(?:(?:please|just)\\s+|go ahead(?:\\s+and)?\\s+|you can\\s+|can you\\s+|i (?:want|need|would like) you to\\s+|let'?s\\s+)?${escaped}\\b`).test(instruction)
    || new RegExp(`\\b(?:please|just|go ahead(?:\\s+and)?|you can|can you|i (?:want|need|would like) you to|let'?s)\\s+${escaped}\\b`).test(instruction);
}

function isNegated(instruction: string, verb: string): boolean {
  return new RegExp(`\\b(?:do not|don'?t|dont'?|never|cannot|can'?t|not)\\s+(?:[a-z0-9]+\\s+){0,2}${escapeRegex(verb)}\\b`).test(instruction);
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9'.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeClauses(value: string): string[] {
  return value
    .split(/[,;.!?]+/)
    .map(normalize)
    .filter(Boolean);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
