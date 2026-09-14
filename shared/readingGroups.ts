import type { Card, ReadingComparison, ReadingGroupMember } from "./types";

export interface ReadingCardGroup {
  id: string;
  runId?: string;
  comparisonId?: string;
  topicKey?: string;
  cards: Card[];
}

/** Opaque key within one feed. Cross-run grouping requires an explicitly validated comparison. */
export function readingGroupKey(runId: string, topicKey: string, comparisonId?: string): string {
  if (comparisonId) return `reading-comparison:${JSON.stringify([comparisonId, topicKey])}`;
  return `reading:${JSON.stringify([runId, topicKey])}`;
}

export function sameReadingMembers(left: ReadingGroupMember[], right: ReadingGroupMember[]): boolean {
  if (left.length !== right.length) return false;
  const versions = new Map(left.map((member) => [member.cardId, member.contentRevision]));
  return versions.size === left.length && new Set(right.map((member) => member.cardId)).size === right.length
    && right.every((member) => versions.get(member.cardId) === member.contentRevision);
}

export function readingProgressMember(card: Card): ReadingGroupMember | undefined {
  const contentRevision = card.readingPresentation?.contentRevision ?? card.reading?.contentRevision;
  return contentRevision ? { cardId: card.id, contentRevision } : undefined;
}

/** Shape-level safety boundary used by the server to project passive presentation for old cards. */
export function canPresentAsPassiveReading(card: Card): boolean {
  return card.kind === "attention" && !card.proposedAction
    && !(card.actions?.length) && !card.routineActionGroupId
    && !card.blocks.some((block) => block.type === "editable_text" || block.editable);
}

/** Only revision-bound passive cards may disappear on scroll; actions keep explicit review. */
export function isPassiveReadingCard(card: Card): boolean {
  return Boolean(readingProgressMember(card)) && canPresentAsPassiveReading(card)
    && ["to_review_new", "to_review_updated", "done"].includes(card.status);
}

function orderHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}

/** Pass all cards in a feed so archived variants remain part of the comparison. */
export function groupReadingCards(cards: Card[], comparisons: ReadingComparison[] = []): ReadingCardGroup[] {
  const groups = new Map<string, ReadingCardGroup>();
  for (const card of cards) {
    const reading = card.reading;
    const topicKey = reading?.topicKey;
    const matched = Boolean(reading && typeof topicKey === "string" && topicKey.trim());
    const comparison = matched ? comparisons.find((item) => item.feedId === card.feedId
      && item.topicKey === topicKey && item.runIds.includes(reading!.runId)) : undefined;
    const runId = comparison?.anchorRunId ?? reading?.runId;
    const id = matched ? readingGroupKey(runId!, topicKey!, comparison?.id) : `card:${card.id}`;
    const group = groups.get(id);
    if (group) group.cards.push(card);
    else groups.set(id, { id, ...(matched ? { runId, topicKey } : {}),
      ...(comparison ? { comparisonId: comparison.id } : {}), cards: [card] });
  }
  for (const group of groups.values()) {
    // Stable across reloads, but neither author nor input-array position determines version 1.
    group.cards.sort((left, right) => orderHash(`${group.id}\0${left.id}`) - orderHash(`${group.id}\0${right.id}`)
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }
  return [...groups.values()];
}
