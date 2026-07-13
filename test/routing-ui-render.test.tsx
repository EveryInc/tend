import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InboxSweepStatus, ParkedClaudeWorkNotice, parkedClaudeWorkItems } from "../src/App";
import { Dock } from "../src/shell/Dock";
import { TopBar } from "../src/shell/TopBar";
import type { Card, FeedView, WorkItemView, WorkspaceView } from "../shared/types";

function feed(overrides: Partial<FeedView> = {}): FeedView {
  return {
    config: {
      id: "inbox",
      name: "Inbox",
      purpose: "Review inbox attention.",
      defaultCleanup: "Archive when done.",
      currentPass: 1,
      createdAt: "2026-07-05T12:00:00.000Z",
      updatedAt: "2026-07-05T12:00:00.000Z",
    },
    thread: {
      homeThreadId: "thread-codex",
      boundAt: "2026-07-05T12:00:00.000Z",
      heartbeat: { status: "not_proposed", cadence: null, automationId: null },
      agents: { claude: { threadId: "claude-lane_123", boundAt: "2026-07-05T12:00:00.000Z" } },
    },
    sources: [],
    policy: "",
    cards: [],
    runs: [],
    routineActions: [],
    work: [],
    sweep: { currentBatchId: null, lastFeedbackId: null, recollectionOffered: false, statusMessage: null },
    drain: { status: "idle", consecutiveFailures: 0 },
    readyNextPass: 0,
    ...overrides,
  };
}

function workspace(active = feed(), overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    feeds: [{ id: "inbox", name: "Inbox", purpose: "Review inbox attention." }],
    active,
    agents: {
      claude: {
        liveness: "live",
        lastSeenAt: "2026-07-05T12:00:00.000Z",
        label: "Preview",
        sessionId: "session-a",
      },
    },
    dictation: {
      provider: null,
      status: "not_checked",
      activationCode: "AltRight",
      activationLabel: "Right Option",
      source: "fallback",
      detectedAt: null,
      note: "",
    },
    proposals: [],
    ...overrides,
  };
}

test("TopBar renders Claude presence liveness and label", () => {
  const html = renderToStaticMarkup(
    <TopBar state={workspace()} onMind={() => {}} onFeed={() => {}} />,
  );

  expect(html).toContain("Claude live · Preview");
  expect(html).toContain("tend-agent-live");
});

test("Inbox sweep status renders page progress and verified coverage", () => {
  const collection = {
    id: "collection-1",
    sourceId: "gmail-inbox",
    query: "in:inbox" as const,
    collectedAt: "2026-07-05T12:00:00.000Z",
    pages: [
      { receiptId: "page-1", requestPageToken: null, nextPageToken: "next", threadIds: ["one"] },
      { receiptId: "page-2", requestPageToken: "next", nextPageToken: null, threadIds: ["two"] },
    ],
  };
  const active = feed({
    sweep: { currentBatchId: "batch-1", lastFeedbackId: null, recollectionOffered: false, statusMessage: null },
    inboxStatus: {
      latestCollection: collection,
      coverage: {
        sourceId: "gmail-inbox",
        threadCount: 2,
        cardCount: 2,
        removedCardIds: [],
        threadCardMap: [{ threadId: "one", cardId: "inbox-thread-one" }, { threadId: "two", cardId: "inbox-thread-two" }],
        collection,
        verifiedAt: "2026-07-05T12:01:00.000Z",
      },
    },
  });

  const html = renderToStaticMarkup(<InboxSweepStatus feed={active} />);
  expect(html).toContain("Inbox coverage verified");
  expect(html).toContain("2 threads across 2 pages");
  expect(html).toContain("Batch batch-1");
});

test("Dock renders Claude routing toggle and agent-aware placeholder", () => {
  const active = feed();
  const html = renderToStaticMarkup(
    <Dock
      state={workspace(active)}
      feed={active}
      target={{ kind: "feed", feedId: "inbox" }}
      ladder={[{ kind: "feed", feedId: "inbox" }, { kind: "attention" }]}
      targetVersion={0}
      canRouteToClaude
      routeToClaude
      onRouteToClaude={() => {}}
      onTarget={() => {}}
      onSubmit={() => {}}
      onRecollect={() => {}}
    />,
  );

  expect(html).toContain("Tell Claude what to notice, change, or do");
  expect(html).toContain("agent-toggle active");
  expect(html).toContain("Claude");
});

test("Dock hides Claude routing toggle when feed is unbound", () => {
  const active = feed({ thread: { ...feed().thread, agents: undefined } });
  const html = renderToStaticMarkup(
    <Dock
      state={workspace(active)}
      feed={active}
      target={{ kind: "feed", feedId: "inbox" }}
      ladder={[{ kind: "feed", feedId: "inbox" }, { kind: "attention" }]}
      targetVersion={0}
      canRouteToClaude={false}
      routeToClaude={false}
      onTarget={() => {}}
      onSubmit={() => {}}
      onRecollect={() => {}}
    />,
  );

  expect(html).toContain("Tell Codex what to notice, change, or do");
  expect(html).not.toContain("agent-toggle");
});

test("parked Claude notice includes card-scoped queued work with reassign affordances", () => {
  const card: Card = {
    id: "card-1",
    feedId: "inbox",
    kind: "attention",
    status: "queued",
    title: "Reply to Ada",
    eyebrow: "Inbox",
    why: "A reply is waiting.",
    blocks: [],
    readyForPass: 1,
    createdAt: "2026-07-05T12:00:00.000Z",
    updatedAt: "2026-07-05T12:00:00.000Z",
    history: [],
  };
  const cardScoped: WorkItemView = {
    id: "work-card",
    feedId: "inbox",
    cardId: "card-1",
    status: "queued",
    kind: "scoped_instruction",
    instruction: "Handle this card.",
    assignee: "claude",
    createdAt: "2026-07-05T12:01:00.000Z",
    updatedAt: "2026-07-05T12:01:00.000Z",
  };
  const feedScoped: WorkItemView = {
    id: "work-feed",
    feedId: "inbox",
    cardId: "__feed__",
    status: "queued",
    kind: "instruction",
    instruction: "Refresh the feed.",
    assignee: "claude",
    createdAt: "2026-07-05T12:02:00.000Z",
    updatedAt: "2026-07-05T12:02:00.000Z",
  };
  const active = feed({ cards: [card], work: [cardScoped, feedScoped] });
  const items = parkedClaudeWorkItems(active, "offline");
  const html = renderToStaticMarkup(<ParkedClaudeWorkNotice items={items} onReassign={() => {}} />);

  expect(items.map((item) => item.work.id)).toEqual(["work-card", "work-feed"]);
  expect(html).toContain("these instructions are parked");
  expect(html).toContain("Reply to Ada");
  expect(html).toContain("Feed instruction");
  expect((html.match(/Reassign to Codex/g) ?? [])).toHaveLength(2);
});

test("queued card footer attributes the lane it waits on", () => {
  const { CardView } = require("../src/feed/CardView");
  const card: Card = {
    id: "card-queued",
    feedId: "inbox",
    kind: "attention",
    status: "queued",
    title: "Reply to the payroll thread.",
    eyebrow: "Inbox",
    why: "Queued for the Claude lane.",
    blocks: [],
    history: [],
    createdAt: "2026-07-05T12:00:00.000Z",
    updatedAt: "2026-07-05T12:00:00.000Z",
  } as unknown as Card;
  const base = { card, active: false, onActivate: () => {}, onChanged: () => {}, onAction: () => {}, onReturnToReview: () => {} };
  const claudeHtml = renderToStaticMarkup(<CardView {...base} queuedFor="Claude" />);
  expect(claudeHtml).toContain("Queued for Claude");
  expect(claudeHtml).toContain("Waiting for Claude");
  const legacyHtml = renderToStaticMarkup(<CardView {...base} />);
  expect(legacyHtml).toContain("Queued for Codex");
});
