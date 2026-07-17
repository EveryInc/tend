import { expect, test } from "bun:test";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ParkedClaudeWorkNotice, parkedClaudeWorkItems, shouldShowReviewReady } from "../src/App";
import { Dock } from "../src/shell/Dock";
import { ReviewReadyControl } from "../src/shell/ReviewReadyControl";
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

test("review ready visibility is limited to a positive count on the feed review tab", () => {
  expect(shouldShowReviewReady("feed", "review", 2)).toBe(true);
  expect(shouldShowReviewReady("feed", "review", 0)).toBe(false);
  expect(shouldShowReviewReady("feed", "review", -1)).toBe(false);
  for (const tab of ["queued", "working", "done"] as const) {
    expect(shouldShowReviewReady("feed", tab, 2)).toBe(false);
  }
  expect(shouldShowReviewReady("workspace", "review", 2)).toBe(false);
  expect(shouldShowReviewReady("learnings", "review", 2)).toBe(false);
});

test("review ready control is absent for a non-positive count", () => {
  expect(renderToStaticMarkup(<ReviewReadyControl count={0} pending={false} onActivate={() => {}} />)).toBe("");
  expect(renderToStaticMarkup(<ReviewReadyControl count={-3} pending={false} onActivate={() => {}} />)).toBe("");
});

test("review ready control renders the compact card label, icon, count badge, and singular announcement", () => {
  const html = renderToStaticMarkup(<ReviewReadyControl count={1} pending={false} onActivate={() => {}} />);
  expect(html).toContain("Review ready cards");
  expect(html).toContain('class="review-ready-icon"');
  expect(html).toContain('class="review-ready-count"');
  expect(html).toContain(">1</span>");
  expect(html).toContain('aria-label="Review ready cards, 1 ready"');
  expect(html).toContain("1 updated card is ready for the next review pass.");
  expect(html).toContain('aria-live="polite"');
  expect(html).not.toContain("aria-busy");
});

test("review ready control group-formats a large live count in its separate badge", () => {
  const formatted = new Intl.NumberFormat().format(1234);
  const html = renderToStaticMarkup(<ReviewReadyControl count={1234} pending={false} onActivate={() => {}} />);
  expect(html).toContain(`class="review-ready-count" aria-hidden="true">${formatted}</span>`);
  expect(html).toContain(`aria-label="Review ready cards, ${formatted} ready"`);
  expect(html).toContain(`${formatted} updated cards are ready for the next review pass.`);
});

test("review ready control shows a busy, disabled opening state while pending", () => {
  const html = renderToStaticMarkup(<ReviewReadyControl count={6} pending onActivate={() => {}} />);
  expect(html).toContain("Review ready cards");
  expect(html).toContain('class="review-ready-count" aria-hidden="true">6</span>');
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain("disabled");
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("Opening 6 cards…");
});

test("review ready control activates through its button callback", () => {
  let activated = 0;
  const element = ReviewReadyControl({ count: 6, pending: false, onActivate: () => { activated += 1; } });
  if (!isValidElement<{ children?: unknown }>(element)) throw new Error("Review ready control was not rendered.");
  const button = Children.toArray(element.props.children).find((child) =>
    isValidElement<{ className?: string }>(child) && child.props.className?.includes("review-ready-button")
  );
  if (!isValidElement<{ onClick: () => void }>(button)) throw new Error("Review ready button was not rendered.");
  button.props.onClick();
  expect(activated).toBe(1);
});

test("Dock renders a floating action outside its instruction form, and nothing without one", () => {
  const active = feed();
  const withAction = renderToStaticMarkup(
    <Dock
      state={workspace(active)}
      feed={active}
      target={{ kind: "feed", feedId: "inbox" }}
      ladder={[{ kind: "feed", feedId: "inbox" }, { kind: "attention" }]}
      targetVersion={0}
      canRouteToClaude={false}
      routeToClaude={false}
      floatingAction={<button type="button" className="review-ready-button">Review ready cards</button>}
      onTarget={() => {}}
      onSubmit={() => {}}
      onRecollect={() => {}}
    />,
  );
  const withoutAction = renderToStaticMarkup(
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

  expect(withAction).toContain("dock-floating-action");
  expect(withAction).toContain("dock-floating-action-right");
  expect(withAction).toContain("Review ready cards");
  expect(withAction.indexOf("dock-floating-action")).toBeLessThan(withAction.indexOf("<form"));
  expect(withoutAction).not.toContain("dock-floating-action");
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
