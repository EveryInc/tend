import type { Tab } from "../app/types";
import type { Card, CardAction, FeedView, RoutineActionGroup, WorkItemView } from "../types";

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

export function visibleFeedWork(feed: FeedView, tab: Tab): WorkItemView[] {
  if (tab === "review") return [];
  const status = tab === "done" ? "completed" : tab;
  return feed.work.filter((work) => work.cardId === "__feed__" && work.status === status);
}

export function countFor(feed: FeedView, tab: Tab): number {
  return visibleCards(feed, tab).length + visibleRoutineActions(feed, tab).length + visibleFeedWork(feed, tab).length;
}

export function visibleCardActions(card: Card): CardAction[] {
  const dismiss: CardAction = { id: "dismiss-card", label: "Dismiss card", behavior: "dismiss_card", variant: "secondary", shortcut: "d" };
  if (card.actions?.length) {
    // Local dismissal is always available unless the card author supplied a custom local-dismiss
    // control. Source cleanup remains a separate, explicitly configured action.
    return card.actions.some((action) => action.behavior === "dismiss_card") ? card.actions : [dismiss, ...card.actions];
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
