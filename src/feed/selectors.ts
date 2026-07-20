import type { Tab } from "../app/types";
import type { Card, CardAction, FeedView, RoutineActionGroup, WorkItemView } from "../types";

export function visibleCards(feed: FeedView, tab: Tab): Card[] {
  const pass = feed.config.currentPass;
  const activeWorkStatus = new Map<string, "queued" | "working" | "approved_blocked">();
  for (const work of feed.work) {
    if (work.cardId === "__feed__" || work.cardId === "__routine__") continue;
    if (work.status !== "queued" && work.status !== "working" && work.status !== "approved_blocked") continue;
    const current = activeWorkStatus.get(work.cardId);
    if (!current || work.status === "working" || (work.status === "approved_blocked" && current === "queued")) {
      activeWorkStatus.set(work.cardId, work.status);
    }
  }
  const effectiveStatus = (card: Card) => activeWorkStatus.get(card.id) ?? card.status;
  if (tab === "review") {
    return feed.cards
      .filter((card) => (effectiveStatus(card) === "to_review_new" || effectiveStatus(card) === "to_review_updated") && card.readyForPass <= pass && !card.sweep?.hidden && !card.routineActionGroupId)
      .sort((left, right) => {
        if (left.sweep?.rank !== undefined || right.sweep?.rank !== undefined) return (left.sweep?.rank ?? Number.MAX_SAFE_INTEGER) - (right.sweep?.rank ?? Number.MAX_SAFE_INTEGER);
        if (feed.config.id === "inbox") {
          if (left.sourceLatestMessageAt || right.sourceLatestMessageAt) {
            if (!left.sourceLatestMessageAt) return 1;
            if (!right.sourceLatestMessageAt) return -1;
            const chronology = Date.parse(right.sourceLatestMessageAt) - Date.parse(left.sourceLatestMessageAt);
            if (chronology !== 0) return chronology;
          }
          if (left.sourceLatestMessageAt === right.sourceLatestMessageAt) return left.id.localeCompare(right.id);
        }
        if (left.status !== right.status) return left.status === "to_review_updated" ? -1 : 1;
        return (right.completedAt ?? right.updatedAt).localeCompare(left.completedAt ?? left.updatedAt);
      });
  }
  if (tab === "queued") return feed.cards.filter((card) => (effectiveStatus(card) === "queued" || effectiveStatus(card) === "approved_blocked") && !card.routineActionGroupId);
  if (tab === "working") return feed.cards.filter((card) => effectiveStatus(card) === "working" && !card.routineActionGroupId);
  return feed.cards.filter((card) => card.status === "done" && !card.routineActionGroupId);
}

export function visibleRoutineActions(feed: FeedView, tab: Tab): RoutineActionGroup[] {
  const status = tab === "review" ? "proposed" : tab === "done" ? "completed" : tab;
  return feed.routineActions.filter((group) => group.status === status);
}

export function visibleFeedWork(feed: FeedView, tab: Tab): WorkItemView[] {
  if (tab === "review") return [];
  const status = tab === "done" ? "completed" : tab;
  return feed.work.filter((work) => work.cardId === "__feed__" && work.status === status);
}

export function countFor(feed: FeedView, tab: Tab): number {
  return visibleCards(feed, tab).length + visibleRoutineActions(feed, tab).length + visibleFeedWork(feed, tab).length;
}

export function latestReviewCard(feed: FeedView): Card | undefined {
  return visibleCards(feed, "review")[0];
}

export function visibleCardActions(card: Card): CardAction[] {
  const archive: CardAction = { id: "default-cleanup", label: "Archive", behavior: "default_cleanup", variant: "secondary", shortcut: "x" };
  if (card.actions?.length) {
    return card.actions.some((action) => action.behavior === "default_cleanup" || action.label.trim().toLowerCase() === "archive")
      ? card.actions
      : [archive, ...card.actions];
  }
  if (!card.proposedAction || card.proposedAction.label === "Decide disposition") return [archive];
  if (card.proposedAction.label === "Archive" || card.proposedAction.label === "Archive this thread") {
    return [{ ...archive, variant: "primary" }];
  }
  return [
    archive,
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
