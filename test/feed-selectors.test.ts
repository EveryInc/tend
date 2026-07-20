import { describe, expect, test } from "bun:test";
import { countFor, latestReviewCard, visibleCards } from "../src/feed/selectors";
import type { Card, FeedView, WorkItemView } from "../shared/types";
import { projectQueuedCardAction } from "../src/state/optimistic";

function card(index: number, overrides: Partial<Card> = {}): Card {
  const timestamp = "2026-07-13T12:00:00.000Z";
  return {
    id: `card-${String(index).padStart(4, "0")}`,
    feedId: "inbox",
    kind: "attention",
    status: "to_review_new",
    title: `Inbox card ${index}`,
    eyebrow: "Inbox",
    why: "It needs review.",
    blocks: [],
    readyForPass: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    history: [],
    ...overrides,
  };
}

function feed(cards: Card[], work: WorkItemView[] = []): FeedView {
  return {
    config: {
      id: "inbox",
      name: "Inbox",
      purpose: "Review inbox attention.",
      defaultCleanup: "Archive the email thread.",
      currentPass: 1,
      createdAt: "2026-07-13T12:00:00.000Z",
      updatedAt: "2026-07-13T12:00:00.000Z",
    },
    thread: {
      homeThreadId: "thread-codex",
      boundAt: "2026-07-13T12:00:00.000Z",
      heartbeat: { status: "not_proposed", cadence: null, automationId: null },
    },
    sources: [],
    policy: "",
    cards,
    runs: [],
    routineActions: [],
    work,
    sweep: { currentBatchId: null, lastFeedbackId: null, recollectionOffered: false, statusMessage: null },
    drain: { status: "idle", consecutiveFailures: 0 },
    readyNextPass: 0,
  };
}

describe("feed card projection", () => {
  test("projects rapid archive work into the queued tab even while card mirrors lag", () => {
    const cards = Array.from({ length: 1_770 }, (_, index) => card(index));
    const work: WorkItemView[] = cards.slice(0, 16).map((item, index) => ({
      id: `work-${index}`,
      feedId: "inbox",
      cardId: item.id,
      kind: "default_cleanup",
      instruction: "Archive the email thread.",
      status: "queued",
      createdAt: "2026-07-13T12:01:00.000Z",
      updatedAt: "2026-07-13T12:01:00.000Z",
    }));
    const state = feed(cards, work);

    expect(visibleCards(state, "review")).toHaveLength(1_754);
    expect(visibleCards(state, "queued").map((item) => item.id)).toEqual(cards.slice(0, 16).map((item) => item.id));
    expect(countFor(state, "review")).toBe(1_754);
    expect(countFor(state, "queued")).toBe(16);
  });

  test("moves a successful card action immediately before the server refresh completes", () => {
    const reviewCard = card(1);
    const active = feed([reviewCard]);
    const work: WorkItemView = {
      id: "work-immediate",
      feedId: "inbox",
      cardId: reviewCard.id,
      kind: "default_cleanup",
      instruction: "Archive the email thread.",
      status: "queued",
      createdAt: "2026-07-13T12:01:00.000Z",
      updatedAt: "2026-07-13T12:01:00.000Z",
    };
    const state = projectQueuedCardAction({ active } as never, reviewCard.id, work);

    expect(countFor(state.active, "review")).toBe(0);
    expect(countFor(state.active, "queued")).toBe(1);
    expect(state.active.work).toContainEqual(work);
  });

  test("sorts Inbox review cards by authoritative latest-message time with deterministic ties", () => {
    const state = feed([
      card(3, { id: "inbox-thread-z", sourceLatestMessageAt: "2026-07-12T09:00:00.000Z" } as Partial<Card>),
      card(2, { id: "inbox-thread-b", sourceLatestMessageAt: "2026-07-13T09:00:00.000Z" } as Partial<Card>),
      card(1, { id: "inbox-thread-a", sourceLatestMessageAt: "2026-07-13T09:00:00.000Z" } as Partial<Card>),
    ]);

    expect(visibleCards(state, "review").map((item) => item.id)).toEqual([
      "inbox-thread-a",
      "inbox-thread-b",
      "inbox-thread-z",
    ]);
    expect(latestReviewCard(state)?.id).toBe("inbox-thread-a");
  });

  test("keeps explicit sweep rank ahead of Inbox source chronology", () => {
    const state = feed([
      card(1, {
        id: "rank-two",
        sourceLatestMessageAt: "2026-07-13T12:00:00.000Z",
        sweep: { rank: 2, hidden: false, feedbackId: "feedback-1" },
      } as Partial<Card>),
      card(2, {
        id: "rank-one",
        sourceLatestMessageAt: "2026-07-01T12:00:00.000Z",
        sweep: { rank: 1, hidden: false, feedbackId: "feedback-1" },
      } as Partial<Card>),
    ]);

    expect(visibleCards(state, "review").map((item) => item.id)).toEqual(["rank-one", "rank-two"]);
  });
});
