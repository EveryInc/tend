import type { Card, ReadingGroupMember } from "./types";

export interface ReadingCardGroup {
  id: string;
  runId?: string;
  topicKey?: string;
  cards: Card[];
}

/** Opaque key within one feed. Exact run/topic matches only; never infer from a meeting. */
export function readingGroupKey(runId: string, topicKey: string): string {
  return `reading:${JSON.stringify([runId, topicKey])}`;
}

export function sameReadingMembers(left: ReadingGroupMember[], right: ReadingGroupMember[]): boolean {
  if (left.length !== right.length) return false;
  const versions = new Map(left.map((member) => [member.cardId, member.contentRevision]));
  return versions.size === left.length && new Set(right.map((member) => member.cardId)).size === right.length
    && right.every((member) => versions.get(member.cardId) === member.contentRevision);
}

function orderHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}

/** Pass all cards in a feed so archived variants remain part of the comparison. */
export function groupReadingCards(cards: Card[]): ReadingCardGroup[] {
  const groups = new Map<string, ReadingCardGroup>();
  for (const card of cards) {
    const reading = card.reading;
    const topicKey = reading?.topicKey;
    const matched = Boolean(reading && typeof topicKey === "string" && topicKey.trim());
    const id = matched ? readingGroupKey(reading!.runId, topicKey!) : `card:${card.id}`;
    const group = groups.get(id);
    if (group) group.cards.push(card);
    else groups.set(id, { id, ...(matched ? { runId: reading!.runId, topicKey } : {}), cards: [card] });
  }
  for (const group of groups.values()) {
    // Stable across reloads, but neither author nor input-array position determines version 1.
    group.cards.sort((left, right) => orderHash(`${group.id}\0${left.id}`) - orderHash(`${group.id}\0${right.id}`)
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }
  return [...groups.values()];
}
