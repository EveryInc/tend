import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Dock } from "../src/shell/Dock";
import { TopBar } from "../src/shell/TopBar";
import type { FeedView, WorkspaceView } from "../shared/types";

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
