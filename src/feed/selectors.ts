import type { Tab } from "../app/types";
import type { Card, CardAction, FeedView, RoutineActionGroup } from "../types";

export function visibleCards(feed: FeedView, tab: Tab): Card[] {
  const pass = feed.config.currentPass;
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

export function visibleRoutineActions(feed: FeedView, tab: Tab): RoutineActionGroup[] {
  const status = tab === "review" ? "proposed" : tab === "done" ? "completed" : tab;
  return feed.routineActions.filter((group) => group.status === status);
}

export function countFor(feed: FeedView, tab: Tab): number {
  const feedWork = tab === "queued" || tab === "working"
    ? feed.work.filter((work) => work.cardId === "__feed__" && work.status === tab).length
    : 0;
  return visibleCards(feed, tab).length + visibleRoutineActions(feed, tab).length + feedWork;
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
