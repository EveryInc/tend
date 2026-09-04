import type { Tab } from "../app/types";
import { groupReadingCards, sameReadingMembers, type ReadingCardGroup } from "../../shared/readingGroups";
import type { ReadingGroupMember, ReadingPreferenceState, ReadingProgressState } from "../../shared/types";
import type { Card, CardAction, FeedView, RoutineActionGroup, WorkItemView } from "../types";
import { safeConfiguredCardActions } from "../../shared/cardActions";

export function visibleCards(feed: FeedView, tab: Tab): Card[] {
  const pass = feed.config.currentPass;
  if (tab === "read") {
    const readIds = new Set(groupReadingCards(feed.cards, feed.readingComparisons)
      .filter((group) => currentReadingProgress(group, feed.readingProgress)?.read)
      .flatMap((group) => group.cards.map((card) => card.id)));
    return feed.cards.filter((card) => card.reading && !card.routineActionGroupId
      && (card.status === "done" || readIds.has(card.id))
      && !["queued", "working", "approved_blocked"].includes(card.status));
  }
  if (tab === "review") {
    return feed.cards
      .filter((card) => (card.status === "to_review_new" || card.status === "to_review_updated") && card.readyForPass <= pass && !card.sweep?.hidden && !card.routineActionGroupId)
      .sort((left, right) => {
        if (left.sweep?.rank !== undefined || right.sweep?.rank !== undefined) return (left.sweep?.rank ?? Number.MAX_SAFE_INTEGER) - (right.sweep?.rank ?? Number.MAX_SAFE_INTEGER);
        if (left.status !== right.status) return left.status === "to_review_updated" ? -1 : 1;
        return (right.completedAt ?? right.updatedAt).localeCompare(left.completedAt ?? left.updatedAt);
      });
  }
  if (tab === "queued") return feed.cards.filter((card) => (card.status === "queued" || card.status === "approved_blocked") && !card.routineActionGroupId);
  if (tab === "working") return feed.cards.filter((card) => card.status === "working" && !card.routineActionGroupId);
  return feed.cards.filter((card) => card.status === "done" && !card.routineActionGroupId);
}

export interface VisibleCardGroup extends ReadingCardGroup {
  visibleCards: Card[];
}

// Tab eligibility stays unchanged. A visible idea also carries its archived alternatives so a
// previous Like does not remove a version from a later comparison.
export function visibleCardGroups(feed: FeedView, tab: Tab): VisibleCardGroup[] {
  const byCard = new Map<string, ReadingCardGroup>();
  for (const group of groupReadingCards(feed.cards, feed.readingComparisons)) {
    for (const card of group.cards) byCard.set(card.id, group);
  }
  const visible = new Map<string, VisibleCardGroup>();
  for (const card of visibleCards(feed, tab)) {
    const group = byCard.get(card.id)!;
    if (tab === "review" && currentReadingProgress(group, feed.readingProgress)?.read
      && !group.cards.some((member) => feed.work.some((work) => work.cardId === member.id && ["queued", "working", "approved_blocked"].includes(work.status)))) continue;
    const existing = visible.get(group.id);
    if (existing) existing.visibleCards.push(card);
    else visible.set(group.id, { ...group, visibleCards: [card] });
  }
  const groups = [...visible.values()];
  return tab === "read" ? groups.sort((left, right) => {
    const at = (group: VisibleCardGroup) => currentReadingProgress(group, feed.readingProgress)?.at
      ?? group.visibleCards.reduce((latest, card) => (card.completedAt ?? card.updatedAt) > latest ? card.completedAt ?? card.updatedAt : latest, "");
    return at(right).localeCompare(at(left));
  }) : groups;
}

export function currentReadingProgress(group: ReadingCardGroup, progress?: FeedView["readingProgress"]): ReadingProgressState | undefined {
  const state = progress?.[group.id];
  return state && sameReadingMembers(state.members, readingMembers(group)) ? state : undefined;
}

export function readingMembers(group: ReadingCardGroup): ReadingGroupMember[] {
  return group.cards.flatMap((card) => card.reading ? [{ cardId: card.id, contentRevision: card.reading.contentRevision }] : []);
}

export function currentReadingPreference(group: ReadingCardGroup, preferences?: FeedView["readingPreferences"]): ReadingPreferenceState | undefined {
  const preference = preferences?.[group.id];
  return preference && group.cards.length > 1 && preference.runId === group.runId
    && preference.comparisonId === group.comparisonId
    && preference.topicKey === group.topicKey && sameReadingMembers(preference.members, readingMembers(group))
    ? preference : undefined;
}

export function selectedGroupCard(group: VisibleCardGroup, selectedId?: string, preferences?: FeedView["readingPreferences"]): Card {
  const preferredId = currentReadingPreference(group, preferences)?.preferredCardId;
  return group.cards.find((card) => card.id === selectedId)
    ?? group.cards.find((card) => card.id === preferredId)
    ?? group.cards.find((card) => group.visibleCards.some((visible) => visible.id === card.id))
    ?? group.cards[0];
}

export function visibleRoutineActions(feed: FeedView, tab: Tab): RoutineActionGroup[] {
  if (tab === "read") return [];
  const status = tab === "review" ? "proposed" : tab === "done" ? "completed" : tab;
  return feed.routineActions.filter((group) => group.status === status);
}

export function visibleFeedWork(feed: FeedView, tab: Tab): WorkItemView[] {
  if (tab === "review" || tab === "read") return [];
  const status = tab === "done" ? "completed" : tab;
  return feed.work.filter((work) => work.cardId === "__feed__" && work.status === status);
}

export function countFor(feed: FeedView, tab: Tab): number {
  return visibleCardGroups(feed, tab).length + visibleRoutineActions(feed, tab).length + visibleFeedWork(feed, tab).length;
}

export function visibleCardActions(card: Card): CardAction[] {
  // Reading reactions are local; never inherit a proposed action or source-cleanup shortcut.
  if (card.reading) return [];
  const dismiss: CardAction = { id: "dismiss-card", label: "Dismiss card", behavior: "dismiss_card", variant: "secondary", shortcut: "d" };
  const configuredActions = safeConfiguredCardActions(card.actions);
  if (configuredActions.length) {
    // Local dismissal is always available unless the card author supplied a custom local-dismiss
    // control. Source cleanup remains a separate, explicitly configured action.
    return configuredActions.some((action) => action.behavior === "dismiss_card") ? configuredActions : [dismiss, ...configuredActions];
  }
  if (!card.proposedAction || card.proposedAction.label === "Decide disposition") return [dismiss];
  if (card.proposedAction.label === "Archive" || card.proposedAction.label === "Archive this thread") {
    // The card explicitly proposes archiving the source, so surface the connector cleanup.
    return [dismiss, { id: "default-cleanup", label: "Archive", behavior: "default_cleanup", variant: "primary", shortcut: "x" }];
  }
  return [
    dismiss,
    {
      id: "proposed-action",
      label: card.proposedAction.label,
      behavior: "approve_action",
      instruction: card.proposedAction.instruction,
      artifactBlockId: card.proposedAction.artifactBlockId,
      externalMutation: card.proposedAction.externalMutation,
      mailboxPolicy: card.proposedAction.mailboxPolicy,
      variant: "primary",
      shortcut: "a",
    },
  ];
}
