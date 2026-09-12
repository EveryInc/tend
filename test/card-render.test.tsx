import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CardView } from "../src/feed/CardView";
import { ReadingStreamCard, ReadingStreamControls } from "../src/feed/ReadingStream";
import { engagementClickTarget } from "../src/state/readingEngagement";
import App from "../src/App";
import { countFor, currentReadingPreference, readingMembers, retainReadingSessionGroups, selectedGroupCard, visibleCardActions, visibleCardGroups } from "../src/feed/selectors";
import { groupReadingCards } from "../shared/readingGroups";
import { Dock } from "../src/shell/Dock";
import { SourceRunHistory } from "../src/workspace/PromptWorkspace";
import type { Card, FeedView, ReadingComparison, ReadingPreferenceInput, ReadingPreferenceState, ReadingProgressState, SourceRun, WorkspaceView } from "../shared/types";

const ownsDom = typeof document === "undefined";
if (ownsDom) GlobalRegistrator.register();
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; globalThis.EventSource = originalEventSource; });
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });

test("renders structured evidence hrefs as clickable anchors", () => {
  const card: Card = {
    id: "linked-evidence",
    feedId: "company-attention",
    kind: "attention",
    status: "to_review_new",
    title: "Linked evidence",
    eyebrow: "Source",
    why: "The source should open from the card.",
    blocks: [{
      id: "sources",
      type: "evidence",
      label: "Sources",
      items: [{ label: "Signed agreement", href: "https://example.com/agreement" }],
    }],
    readyForPass: 1,
    createdAt: "2026-06-10T12:00:00.000Z",
    updatedAt: "2026-06-10T12:00:00.000Z",
    history: [],
  };

  const html = renderToStaticMarkup(
    <CardView
      card={card}
      active={false}
      onActivate={() => {}}
      onChanged={() => {}}
      onAction={() => {}}
      onReturnToReview={() => {}}
    />,
  );

  expect(html).toContain('href="https://example.com/agreement"');
  expect(html).toContain(">Signed agreement</a>");
});

test("renders the imported wide card image inline with a separate editable note", () => {
  const name = `card-image-${"a".repeat(64)}.png`;
  const card: Card = {
    id: "image-share", feedId: "company-attention", kind: "attention", status: "to_review_new",
    title: "Send this card", eyebrow: "Private message", why: "Review the image and note.",
    blocks: [
      { id: "image", type: "image", label: "Card image", image: {
        name, filename: "card.png", sha256: "a".repeat(64), mediaType: "image/png", byteLength: 100,
        width: 1536, height: 1024, alt: "The concrete original headline", source: { cardId: "source", contentRevision: "b".repeat(64) },
      } },
      { id: "note", type: "editable_text", label: "Your note", value: "What do you think?", editable: true },
    ],
    readyForPass: 1, createdAt: "2026-09-05T12:00:00.000Z", updatedAt: "2026-09-05T12:00:00.000Z", history: [],
  };
  const html = renderToStaticMarkup(<CardView card={card} active={false} onActivate={() => {}} onChanged={() => {}} onAction={() => {}} onReturnToReview={() => {}} />);
  expect(html).toContain(`src="/api/artifacts/${name}"`);
  expect(html).toContain('alt="The concrete original headline" width="1536" height="1024"');
  expect(html).toContain('aria-label="Your note"');
  expect(html).toContain("What do you think?");
});

test("renders a visible lens receipt for a context-influenced card", () => {
  const card: Card = {
    id: "paywall-context",
    feedId: "every-performance",
    kind: "attention",
    status: "to_review_new",
    title: "Mobile paywall behavior deserves a closer look.",
    eyebrow: "Every Performance",
    why: "A current metric now connects to the active paywall diagnosis.",
    sourceRunIds: ["run-current"],
    contextInfluence: {
      updateId: "mind-current",
      signalIds: ["paywall"],
      mode: "lens",
      effect: "prioritized",
      summary: "Prioritized because paywall diagnosis is an active decision.",
      sourceCount: 3,
    },
    blocks: [{ id: "brief", type: "memo", text: "Source-backed metric detail." }],
    readyForPass: 1,
    createdAt: "2026-06-13T12:00:00.000Z",
    updatedAt: "2026-06-13T12:00:00.000Z",
    history: [],
  };

  const html = renderToStaticMarkup(
    <CardView
      card={card}
      active={false}
      onActivate={() => {}}
      onChanged={() => {}}
      onAction={() => {}}
      onReturnToReview={() => {}}
    />,
  );

  expect(html).toContain("On your mind");
  expect(html).toContain("Prioritized because paywall diagnosis is an active decision.");
  expect(html).toContain('href="/mind/mind-current#signal-paywall"');
  expect(html).toContain("View context and 3 sources");
});

test("labels context-originated research separately from source evidence", () => {
  const card: Card = {
    id: "paywall-research",
    feedId: "company-attention",
    kind: "attention",
    status: "to_review_new",
    title: "Three evidence-backed paywall improvements.",
    eyebrow: "Company Attention",
    why: "A bounded research pass found relevant patterns.",
    sourceRunIds: ["run-research"],
    contextInfluence: {
      updateId: "mind-current",
      signalIds: ["paywall"],
      mode: "research",
      effect: "selected",
      summary: "Prompted by the active paywall work.",
      researchQuestion: "What evidence-backed paywall improvements fit Every?",
      sourceCount: 2,
    },
    blocks: [{ id: "sources", type: "evidence", items: ["Independent research source"] }],
    readyForPass: 1,
    createdAt: "2026-06-13T12:00:00.000Z",
    updatedAt: "2026-06-13T12:00:00.000Z",
    history: [],
  };

  const html = renderToStaticMarkup(
    <CardView
      card={card}
      active={false}
      onActivate={() => {}}
      onChanged={() => {}}
      onAction={() => {}}
      onReturnToReview={() => {}}
    />,
  );

  expect(html).toContain("Prompted by On Your Mind");
  expect(html).toContain("What evidence-backed paywall improvements fit Every?");
});

test("injects a local Dismiss card control by default instead of Archive", () => {
  const card: Card = {
    id: "plain",
    feedId: "inbox",
    kind: "attention",
    status: "to_review_new",
    title: "Nothing urgent",
    eyebrow: "Inbox",
    why: "You can clear this from review without touching the source.",
    blocks: [{ id: "memo", type: "memo", text: "No action needed." }],
    readyForPass: 1,
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:00:00.000Z",
    history: [],
  };

  const html = renderToStaticMarkup(
    <CardView
      card={card}
      active={false}
      onActivate={() => {}}
      onChanged={() => {}}
      onAction={() => {}}
      onReturnToReview={() => {}}
    />,
  );

  expect(html).toContain("Dismiss card");
  expect(html).not.toContain("Archive");
});

test("keeps local dismissal alongside explicitly proposed source cleanup", () => {
  const card: Card = {
    id: "cleanup",
    feedId: "inbox",
    kind: "attention",
    status: "to_review_new",
    title: "Routine notice",
    eyebrow: "Inbox",
    why: "This thread can be archived at the source.",
    blocks: [{ id: "memo", type: "memo", text: "Routine." }],
    proposedAction: { label: "Archive this thread", instruction: "Archive the email thread." },
    readyForPass: 1,
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:00:00.000Z",
    history: [],
  };

  const html = renderToStaticMarkup(
    <CardView
      card={card}
      active={false}
      onActivate={() => {}}
      onChanged={() => {}}
      onAction={() => {}}
      onReturnToReview={() => {}}
    />,
  );

  expect(html).toContain("Dismiss card");
  expect(html).toContain("Archive");
});

// Invented reading cards only. No test sends a reaction to a real feed or model.
function readingCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "fixture-reading", feedId: "fixture-company", kind: "attention", status: "to_review_new",
    title: "A fixture team found a concrete tradeoff", eyebrow: "Fixture meeting · September 2",
    why: "An exact short face. **These marks stay literal.**\nA second line remains intact.",
    blocks: [
      { id: "quote", type: "quote", text: "An exact <fixture> quote.", attribution: "Fixture speaker" },
      { id: "source", type: "evidence", items: [{ label: "Fixture transcript", href: "https://example.test/transcript" }] },
    ],
    reading: {
      runId: "fixture-run", readerId: "fixture-reader", draftId: "draft-1", contentRevision: "revision-1",
      writer: {
        readerId: "fixture-reader", label: "Fixture reader", adapter: "claude", requestedModel: "requested-fixture-model", actualModel: "confirmed-fixture-model", requestedEffort: "high", actualEffort: "high",
        status: "complete", inputSha256: "fixture-input-sha", inputSnapshotId: "fixture-input", outputSnapshotId: "fixture-output", outputSha256: "fixture-output-sha", authentication: "claude_subscription",
      },
    },
    readyForPass: 1, createdAt: "2026-09-02T12:00:00.000Z", updatedAt: "2026-09-02T12:00:00.000Z", history: [],
    ...overrides,
  };
}

function readingView(card = readingCard(), props: Partial<ComponentProps<typeof CardView>> = {}) {
  return <CardView card={card} active={false} onActivate={() => {}} onChanged={() => {}} onAction={() => {}} onReturnToReview={() => {}} onReadingFeedback={() => {}} {...props} />;
}

function readingWorkspace(cards: Card[]): WorkspaceView {
  const card = cards[0];
  const feed: FeedView = {
    config: { id: card.feedId, name: "Fixture company", purpose: "Fixture", defaultCleanup: "Archive", currentPass: 1, createdAt: card.createdAt, updatedAt: card.updatedAt },
    thread: { homeThreadId: null, boundAt: null, heartbeat: { status: "not_proposed", cadence: null, automationId: null } },
    sources: [], policy: "", cards, runs: [], routineActions: [], work: [], sweep: { currentBatchId: null, lastFeedbackId: null, recollectionOffered: false, statusMessage: null }, drain: { status: "idle" }, readyNextPass: 0,
  };
  return { feeds: [{ id: card.feedId, name: "Fixture company", purpose: "Fixture" }], active: feed, proposals: [], dictation: { provider: null, status: "not_checked", activationCode: "F8", activationLabel: "F8", source: "fallback", detectedAt: null, note: "Fixture" } };
}

function readingVersions(count = 3): Card[] {
  const base = readingCard();
  return Array.from({ length: count }, (_, index) => readingCard({
    id: `fixture-version-${index}`, title: `Fixture version ${index} has an exact title`, why: `Exact version ${index} body.\nNo editor rewrote this line.`,
    reading: { ...base.reading!, topicKey: "fixture-idea", draftId: `draft-${index}`, contentRevision: `revision-${index}`, readerId: `reader-${index}`, writer: { ...base.reading!.writer, readerId: `reader-${index}`, label: `Fixture author ${index}`, actualModel: `fixture-model-${index}` } },
  }));
}

test("neutral reading progress hides the exact topic, preserves ratings and resurfaces new versions", () => {
  const versions = readingVersions(2);
  const group = groupReadingCards(versions)[0];
  const feed = readingWorkspace(versions).active;
  const progress: ReadingProgressState = {
    groupId: group.id, members: readingMembers(group), viewedMembers: [readingMembers(group)[0]],
    read: true, eventId: "read-1", at: "2026-09-04T12:00:00Z",
  };
  feed.readingProgress = { [group.id]: progress };
  expect(visibleCardGroups(feed, "review")).toHaveLength(0);
  expect(visibleCardGroups(feed, "read")).toHaveLength(1);
  expect(countFor(feed, "done")).toBe(0);
  expect(feed.cards.every((card) => card.status === "to_review_new")).toBe(true);
  expect(feed.readingReactions).toBeUndefined();
  expect(visibleCardGroups({ ...feed, cards: readingVersions(3) }, "review")).toHaveLength(1);
  expect(visibleCardGroups({ ...feed, readingProgress: { [group.id]: { ...progress, read: false } } }, "review")).toHaveLength(1);
  expect(visibleCardGroups({ ...feed, cards: [{ ...versions[0], status: "done" }, versions[1]], readingProgress: {} }, "read")).toHaveLength(1);
});

test("reading mode is an explicit choice and manual read records only the selected carousel version", async () => {
  const modes: string[] = [];
  const controls = render(<ReadingStreamControls mode="review" busy={false} onChange={(mode) => modes.push(mode)} />);
  expect(modes).toHaveLength(0);
  fireEvent.change(controls.getByLabelText("Reading cards"), { target: { value: "stream" } });
  expect(modes).toEqual(["stream"]);
  controls.unmount();
  const group = groupReadingCards(readingVersions(2))[0];
  const selected = group.cards[1];
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "/api/session") return Response.json({ mutationToken: "fixture-token" });
    expect(String(input)).toBe(`/api/feeds/${selected.feedId}/reading-progress`);
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    return Response.json({ progress: { ...body, eventId: "read-1", at: "2026-09-04T12:00:00Z" } });
  }) as typeof fetch;
  const ui = render(<ReadingStreamCard group={group} card={selected} enabled history={false} busy={false} onRead={() => {}} onChanged={() => {}}>{readingView(selected, { readingGroup: group })}</ReadingStreamCard>);
  expect(requests).toHaveLength(0);
  fireEvent.click(ui.getByRole("button", { name: "Mark read" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toEqual({ clientEventId: expect.any(String), groupId: group.id, members: readingMembers(group), viewedMembers: [{ cardId: selected.id, contentRevision: selected.reading!.contentRevision }], read: true, expectedCardUpdatedAt: Object.fromEntries(group.cards.map((member) => [member.id, member.updatedAt])) });
  expect(requests[0]).not.toHaveProperty("reaction");
});

test("a retained visit resolves fresh groups while dropping deleted, hidden, and active-work cards", () => {
  const versions = readingVersions(2);
  const first = groupReadingCards(versions)[0];
  const action = readingCard({ id: "ordinary-action", reading: undefined, proposedAction: { label: "Send", instruction: "Send after approval." } });
  const next = readingCard({ id: "later-reading" });
  const feed = readingWorkspace([...versions, action, next]).active;
  const initial = retainReadingSessionGroups(feed, []);
  const retainedIds = initial.map((group) => group.id);
  const updated = versions.map((card) => ({ ...card, status: "done" as const, updatedAt: "2026-09-04T12:00:00Z", why: "Current saved content." }));
  const latest = { ...feed, cards: [...updated, { ...action, status: "done" as const }, next] };
  const kept = retainReadingSessionGroups(latest, retainedIds);
  expect(kept.map((group) => group.id)).toEqual(retainedIds.filter((id) => id !== `card:${action.id}`));
  expect(kept[0].cards.every((card) => updated.includes(card))).toBe(true);
  expect(retainReadingSessionGroups(latest, []).map((group) => group.id)).toEqual([`card:${next.id}`]);
  expect(retainReadingSessionGroups({ ...latest, cards: [next] }, retainedIds).map((group) => group.id)).toEqual([`card:${next.id}`]);
  const hidden = updated.map((card) => ({ ...card, sweep: { hidden: true } } as Card));
  expect(retainReadingSessionGroups({ ...latest, cards: [...hidden, next] }, retainedIds).some((group) => group.id === first.id)).toBe(false);
  const active = { cardId: versions[0].id, status: "queued" } as FeedView["work"][number];
  expect(retainReadingSessionGroups({ ...latest, work: [active] }, retainedIds).some((group) => group.id === first.id)).toBe(false);
});

test("manual read retries the same receipt and history undo is conditional on the exact read event", async () => {
  const group = groupReadingCards(readingVersions(2))[0];
  const card = group.cards[0];
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "/api/session") return Response.json({ mutationToken: "fixture-token" });
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (requests.length === 1) throw new Error("Offline fixture");
    return Response.json({ progress: { ...body, eventId: "read-1", at: "2026-09-04T12:00:00Z" } });
  }) as typeof fetch;
  const wrapper = (history: boolean, progress?: ReadingProgressState) => <ReadingStreamCard group={group} card={card} enabled={!history} history={history} progress={progress} busy={false} onRead={() => {}} onChanged={() => {}}>{readingView(card)}</ReadingStreamCard>;
  const ui = render(wrapper(false));
  fireEvent.click(ui.getByRole("button", { name: "Mark read" }));
  await waitFor(() => expect(ui.getByRole("alert").textContent).toContain("Offline fixture"));
  fireEvent.click(ui.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]).toEqual(requests[0]);
  await waitFor(() => expect(ui.queryByRole("button", { name: "Saving…" }) === null).toBe(true));
  const progress = { ...requests[0], eventId: "read-1", at: "2026-09-04T12:00:00Z" } as unknown as ReadingProgressState;
  ui.rerender(wrapper(true, progress));
  expect(ui.getByText("Read · 1 of 2 versions viewed · no rating implied")).toBeTruthy();
  fireEvent.click(ui.getByRole("button", { name: "Mark unread" }));
  await waitFor(() => expect(requests).toHaveLength(3));
  expect(requests[2]).toMatchObject({ read: false, expectedEventId: "read-1", members: progress.members, viewedMembers: progress.viewedMembers });
});

async function mountReadingApp(feedId: string) {
  const root = createRootRoute({ component: () => <App feedId={feedId} screen="feed" workspaceTab="feed" /> });
  const index = createRoute({ getParentRoute: () => root, path: "/" });
  const router = createRouter({ routeTree: root.addChildren([index]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await router.load();
  const ui = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return { ui, client, close: () => { ui.unmount(); client.clear(); } };
}

test("card-scoped voice approval sends the displayed revision and confirms the exact action", async () => {
  sessionStorage.clear();
  globalThis.EventSource = class { addEventListener() {} close() {} } as unknown as typeof EventSource;
  const card = readingCard({
    id: "voice-approval-ui",
    reading: undefined,
    title: "Review one exact reply",
    blocks: [{ id: "draft", type: "editable_text", label: "Draft", value: "Exact visible reply.", editable: true }],
    actions: [{ id: "send", label: "Send reply", behavior: "approve_action", instruction: "Send the exact visible reply.", artifactBlockId: "draft", externalMutation: true }],
  });
  const state = readingWorkspace([card]);
  const instructions: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/session") return Response.json({ mutationToken: "fixture-token" });
    if (url.startsWith("/api/state?")) return Response.json(state);
    if (url.endsWith("/native-approvals")) return Response.json([]);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url === "/api/voice/target-change") return Response.json(body.target);
    if (url === "/api/voice/instructions") {
      instructions.push(body);
      return Response.json({ kind: "approved_action", actionLabel: "Send reply", work: { id: "voice-approved-work", kind: "execute_approved_action", intent: "voice_instruction" } });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  }) as typeof fetch;

  const mounted = await mountReadingApp(card.feedId);
  try {
    await waitFor(() => expect(mounted.ui.container.querySelector(".dock-target")?.textContent).toBe(card.title));
    const input = mounted.ui.getByRole("textbox", { name: "Instruction for Codex" });
    input.focus();
    fireEvent.input(input, { target: { value: "This is fine" } });
    fireEvent.input(input, { target: { value: "This is fine" } });
    fireEvent.keyUp(input, { key: "." });
    fireEvent.click(mounted.ui.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(instructions).toHaveLength(1));
    expect(instructions[0]).toMatchObject({
      target: { kind: "card", feedId: card.feedId, cardId: card.id },
      instruction: "This is fine",
      expectedCardUpdatedAt: card.updatedAt,
    });
    await waitFor(() => expect(mounted.ui.getByText("Send reply approved and queued")).toBeTruthy());
  } finally {
    mounted.close();
    sessionStorage.clear();
  }
});

test("a neutrally read card keeps its place and feedback target; Undo restores unread without duplicating the card", async () => {
  sessionStorage.clear();
  globalThis.EventSource = class { addEventListener() {} close() {} } as unknown as typeof EventSource;
  const first = readingCard();
  const second = readingCard({ id: "next-reading", title: "The next concrete idea" });
  const state = readingWorkspace([first, second]);
  state.active.config.readingMode = "stream";
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/session") return Response.json({ mutationToken: "fixture-token" });
    if (url.startsWith("/api/state?")) return Response.json(state);
    if (url.endsWith("/native-approvals")) return Response.json([]);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url === "/api/voice/target-change") return Response.json(body.target);
    if (url.endsWith("/reading-progress")) {
      requests.push(body);
      const progress = { ...body, eventId: `progress-${requests.length}`, at: "2026-09-04T12:00:00Z" };
      state.active.readingProgress = { [body.groupId]: progress };
      return Response.json({ progress });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  }) as typeof fetch;
  const mounted = await mountReadingApp(first.feedId);
  const { ui } = mounted;
  try {
    await waitFor(() => expect(ui.queryByRole("heading", { name: first.title }) !== null).toBe(true));
    await waitFor(() => expect(ui.container.querySelector(".dock-target")?.textContent).toBe(first.title));
    const order = Array.from(ui.container.querySelectorAll("[data-reading-slot]")).map((slot) => slot.getAttribute("data-reading-slot"));
    fireEvent.click(ui.getAllByRole("button", { name: "Feedback" })[0]);
    fireEvent.click(ui.getAllByRole("button", { name: "Mark read" })[0]);
    await waitFor(() => expect(ui.container.querySelector("[data-reading-slot]")?.getAttribute("data-reading-state")).toBe("read"));
    expect(ui.queryByRole("heading", { name: first.title }) !== null).toBe(true);
    expect(Array.from(ui.container.querySelectorAll("[data-reading-slot]")).map((slot) => slot.getAttribute("data-reading-slot"))).toEqual(order);
    expect(ui.container.querySelector(".dock-target")?.textContent).toBe(first.title);
    expect(ui.container.querySelector(".tabs button")?.textContent).toBe("Feed1 unread");
    expect(state.active.cards[0].status).toBe("to_review_new");
    expect(state.active.readingReactions).toBeUndefined();
    fireEvent.click(ui.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(ui.container.querySelector("[data-reading-slot]")?.getAttribute("data-reading-state")).toBe("unread"));
    expect(requests[1]).toMatchObject({ read: false, expectedEventId: "progress-1" });
    fireEvent.click(ui.getAllByRole("button", { name: "Mark read" })[0]);
    await waitFor(() => expect(ui.container.querySelector(".reading-undo") !== null).toBe(true));
    fireEvent.click(ui.container.querySelectorAll(".tabs button")[1]);
    await waitFor(() => expect(ui.queryByRole("button", { name: "Mark unread" }) !== null).toBe(true));
    fireEvent.click(ui.getByRole("button", { name: "Mark unread" }));
    await waitFor(() => expect(ui.container.querySelector(".reading-undo") === null).toBe(true));
    expect(requests[3]).toMatchObject({ read: false, expectedEventId: "progress-3" });
  } finally { mounted.close(); sessionStorage.clear(); }
});

test("reading author details support hover, keyboard focus, Escape and touch-style clicks", () => {
  const ui = render(readingView());
  const button = ui.getByRole("button", { name: "Author information" });
  const identity = button.parentElement!;
  fireEvent.mouseEnter(identity);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  fireEvent.mouseLeave(identity);
  expect(button.getAttribute("aria-expanded")).toBe("false");
  fireEvent.focus(button);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(button, { key: "Escape" });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  fireEvent.blur(button);
  fireEvent.click(button);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(button);
  expect(button.getAttribute("aria-expanded")).toBe("false");
});

test("native group selectors count ideas, keep archived alternatives, and invalidate stale preferences", () => {
  const versions = readingVersions();
  versions[0].status = "done";
  const otherRun = { ...versions[1], id: "other-run", reading: { ...versions[1].reading!, runId: "other-run" } };
  const otherTopic = { ...versions[1], id: "other-topic", reading: { ...versions[1].reading!, topicKey: "separate-idea" } };
  const single = readingCard({ id: "unkeyed" });
  const legacy = readingCard({ id: "legacy", reading: undefined });
  const feed = readingWorkspace([...versions, otherRun, otherTopic, single, legacy]).active;
  const groups = visibleCardGroups(feed, "review");
  const group = groups.find((item) => item.cards.length === 3)!;
  expect(groups.length).toBe(5);
  expect(group.visibleCards.map((card) => card.id).sort()).toEqual(versions.slice(1).map((card) => card.id).sort());
  expect(group.cards.some((card) => card.status === "done")).toBe(true);
  expect(countFor(feed, "review")).toBe(5);
  expect(countFor(feed, "done")).toBe(1);
  expect(visibleCardGroups({ ...feed, cards: [...feed.cards].reverse() }, "review").find((item) => item.id === group.id)!.cards.map((card) => card.id)).toEqual(group.cards.map((card) => card.id));
  const preference: ReadingPreferenceState = { runId: group.runId!, topicKey: group.topicKey!, members: readingMembers(group).reverse(), preferredCardId: versions[1].id, eventId: "fixture-choice", at: "2026-09-02T12:03:00Z" };
  const preferences = { [group.id]: preference };
  expect(currentReadingPreference(group, preferences)).toEqual(preference);
  expect(selectedGroupCard(group, undefined, preferences).id).toBe(versions[1].id);
  expect(selectedGroupCard(group, versions[0].id, preferences).id).toBe(versions[0].id);
  const expanded = { ...group, cards: [...group.cards, readingVersions(4)[3]] };
  expect(currentReadingPreference(expanded, preferences)).toBeUndefined();
});

test("a three-version carousel preserves exact faces and sources, wraps, and ignores arrows in editable fields", () => {
  const versions = readingVersions();
  const group = groupReadingCards(versions)[0];
  let selected = group.cards[0];
  const show = () => readingView(selected, { active: true, readingGroup: group, onReadingVersion: (id) => { selected = group.cards.find((card) => card.id === id)!; ui.rerender(show()); } });
  const ui = render(show());
  expect(ui.container.querySelector(".reading-face")?.textContent).toBe(selected.why);
  expect(ui.getByRole("button", { name: "Like" })).toBeTruthy();
  expect(ui.getByRole("button", { name: "Not for me" })).toBeTruthy();
  expect(ui.getByText("Version 1 of 3")).toBeTruthy();
  fireEvent.click(ui.getByRole("button", { name: "Author information" }));
  expect(ui.getByText(selected.reading!.writer.actualModel!)).toBeTruthy();
  fireEvent.click(ui.getByRole("button", { name: "Next version" }));
  expect(selected.id).toBe(group.cards[1].id);
  expect(ui.queryByRole("group", { name: "Author details" }) === null).toBe(true);
  expect(ui.container.querySelector(".reading-face")?.textContent).toBe(selected.why);
  expect((ui.container.querySelector("details.reading-sources") as HTMLDetailsElement).open).toBe(false);
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(selected.id).toBe(group.cards[2].id);
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(selected.id).toBe(group.cards[0].id);
  fireEvent.click(ui.getByRole("button", { name: "Previous version" }));
  expect(selected.id).toBe(group.cards[2].id);
  for (const tag of ["input", "textarea", "select", "div"]) {
    const editable = document.createElement(tag);
    if (tag === "div") editable.setAttribute("contenteditable", "true");
    document.body.append(editable);
    fireEvent.keyDown(editable, { key: "ArrowRight" });
    expect(selected.id).toBe(group.cards[2].id);
    editable.remove();
  }
  fireEvent.keyDown(window, { key: "ArrowLeft", ctrlKey: true });
  expect(selected.id).toBe(group.cards[2].id);
});

test("preferring a version posts the complete revision-bound set and never rewrites alternative ratings", async () => {
  const versions = readingVersions();
  versions[0].status = "done";
  const group = groupReadingCards(versions)[0];
  const card = versions[0];
  const calls: Array<{ url: string; body: ReadingPreferenceInput }> = [];
  let resolveResponse: ((response: Response) => void) | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "/api/session") return Response.json({ mutationToken: "fixture-token" });
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return await new Promise<Response>((resolve) => { resolveResponse = resolve; });
  }) as typeof fetch;
  let changed = 0;
  let pinned = 0;
  const ui = render(readingView(card, { readingGroup: group, onReadingVersion: () => {}, readingReaction: { reaction: "like", contentRevision: card.reading!.contentRevision, eventId: "old-like", at: "2026-09-02T12:00:00Z" }, onChanged: () => { changed += 1; }, onReadingReaction: () => { pinned += 1; } }));
  expect(ui.getByText("This version: Liked")).toBeTruthy();
  fireEvent.click(ui.getByRole("button", { name: "Prefer this version" }));
  await waitFor(() => expect(calls.length).toBe(1));
  expect((ui.getByRole("button", { name: "Next version" }) as HTMLButtonElement).disabled).toBe(true);
  expect(changed).toBe(0);
  expect(calls[0]).toEqual({ url: "/api/feeds/fixture-company/reading-preferences", body: { clientEventId: expect.any(String), runId: group.runId!, topicKey: group.topicKey!, members: readingMembers(group), preferredCardId: card.id } });
  resolveResponse!(Response.json({ duplicate: false, cards: versions.map((version) => ({ ...version, status: "done" })) }));
  await waitFor(() => expect(changed).toBe(1));
  expect(pinned).toBe(1);
  expect(ui.getByRole("button", { name: "Prefer this version" }).getAttribute("aria-pressed")).toBe("true");
  expect(ui.getByText("This version: Liked")).toBeTruthy();
  fireEvent.click(ui.getByRole("button", { name: "Prefer this version" }));
  await waitFor(() => expect(calls.length).toBe(2));
  expect(calls[1].body.preferredCardId).toBeNull();
  expect(calls[1].body.members).toEqual(calls[0].body.members);
  expect(calls.every((call) => call.url.endsWith("/reading-preferences"))).toBe(true);
  resolveResponse!(Response.json({ duplicate: false, cards: versions.map((version) => ({ ...version, status: "done" })) }));
  await waitFor(() => expect(changed).toBe(2));
  expect(ui.getByRole("button", { name: "Prefer this version" }).getAttribute("aria-pressed")).toBe("false");
});

test("a linked retry stays in one carousel and posts its comparison identity with exact members", async () => {
  const versions = readingVersions(2);
  versions[0].status = "done";
  versions[1].reading!.runId = "retry-attempt";
  const comparison: ReadingComparison = { id: "linked-retry", feedId: versions[0].feedId, topicKey: versions[0].reading!.topicKey!,
    runIds: versions.map((card) => card.reading!.runId), anchorRunId: versions[0].reading!.runId,
    inputSha256: "a".repeat(64), promptSha256: "b".repeat(64), sequence: 1,
    members: versions.map((card) => ({ cardId: card.id, contentRevision: card.reading!.contentRevision })) };
  const feed = { ...readingWorkspace(versions).active, readingComparisons: [comparison] };
  const groups = visibleCardGroups(feed, "review");
  expect(groups).toHaveLength(1);
  expect(groups[0].cards).toHaveLength(2);
  expect(countFor(feed, "review")).toBe(1);
  const requests: ReadingPreferenceInput[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "/api/session") return Response.json({ mutationToken: "fixture-token" });
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ duplicate: false });
  }) as typeof fetch;
  const ui = render(readingView(versions[1], { readingGroup: groups[0] }));
  expect(ui.getByRole("group", { name: "Compare versions" })).toBeTruthy();
  fireEvent.click(ui.getByRole("button", { name: "Prefer this version" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toMatchObject({ comparisonId: comparison.id, runId: comparison.anchorRunId,
    topicKey: comparison.topicKey, members: readingMembers(groups[0]), preferredCardId: versions[1].id });
  const preference: ReadingPreferenceState = { ...requests[0], eventId: "fixture-linked-choice", at: versions[0].createdAt };
  const runs = versions.map((card): SourceRun => ({ id: card.reading!.runId, feedId: card.feedId,
    sourceId: "Fixture source", snapshots: 1, judgments: [], readers: [card.reading!.writer] }));
  const history = renderToStaticMarkup(<SourceRunHistory runs={runs} cards={versions} comparisons={[comparison]} preferences={{ [groups[0].id]: preference }} />);
  expect(history).toContain("Linked comparison");
  expect(history).toContain("Current comparison");
  expect(history).toContain("retry-attempt");
  expect(history).toContain(comparison.anchorRunId);
});

test("login guidance is actionable without exposing raw diagnostics or implying a bad reading", () => {
  const writer = readingCard().reading!.writer;
  for (const adapter of ["claude", "codex"] as const) {
    const run: SourceRun = { id: "login-attempt", feedId: "fixture-company", sourceId: "Fixture source", snapshots: 1, judgments: [], readers: [
      { ...writer, adapter, status: "failed", failureCode: "subscription_login_required", error: "private@example.test fixture-private-token" },
    ] };
    const html = renderToStaticMarkup(<SourceRunHistory runs={[run]} />);
    expect(html).toContain("Sign-in needed");
    expect(html).toContain(adapter === "claude" ? "claude auth login" : "codex login");
    expect(html).toContain("explicitly retry only this reader");
    expect(html).toContain("not a reader-quality rating");
    expect(html).not.toContain("private@example.test");
    expect(html).not.toContain("fixture-private-token");
    expect(html).not.toContain("0 liked");
  }
});

test("an uncertain preference retries the same event while changed membership requires a refresh", async () => {
  const group = groupReadingCards(readingVersions())[0];
  const calls: ReadingPreferenceInput[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "/api/session") return Response.json({ mutationToken: "fixture-token" });
    calls.push(JSON.parse(String(init?.body)));
    if (calls.length === 1) throw new Error("Fixture connection interrupted");
    return Response.json({ error: "Compared versions changed", code: "stale_members" }, { status: 409 });
  }) as typeof fetch;
  const ui = render(readingView(group.cards[0], { readingGroup: group }));
  fireEvent.click(ui.getByRole("button", { name: "Prefer this version" }));
  await waitFor(() => expect(ui.queryByRole("alert")?.textContent).toContain("Fixture connection interrupted"));
  fireEvent.click(ui.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(calls.length).toBe(2));
  expect(calls[1]).toEqual(calls[0]);
  await waitFor(() => expect(ui.queryByRole("alert")?.textContent).toContain("These versions changed"));
  expect((ui.getByRole("button", { name: "Prefer this version" }) as HTMLButtonElement).disabled).toBe(true);
  expect(ui.getByRole("button", { name: "Refresh versions" })).toBeTruthy();
});

test("any active group member blocks preference archival but does not block comparison or feedback", () => {
  const versions = readingVersions();
  const ui = render(readingView(versions[0]));
  for (const status of ["queued", "working", "approved_blocked"] as const) {
    const group = groupReadingCards([versions[0], { ...versions[1], status }])[0];
    ui.rerender(readingView(versions[0], { readingGroup: group, onReadingVersion: () => {} }));
    expect((ui.getByRole("button", { name: "Prefer this version" }) as HTMLButtonElement).disabled).toBe(true);
    expect((ui.getByRole("button", { name: "Next version" }) as HTMLButtonElement).disabled).toBe(false);
    expect((ui.getByRole("button", { name: "Feedback" }) as HTMLButtonElement).disabled).toBe(false);
  }
});

test("repeated version arrows stay on the explicitly selected group, while scrolling can select another group", async () => {
  sessionStorage.clear();
  globalThis.EventSource = class { addEventListener() {} close() {} } as unknown as typeof EventSource;
  const near = readingVersions(2);
  const lower = readingVersions(3).map((card) => ({ ...card, id: `lower-${card.id}`, title: `Lower ${card.title}`, reading: { ...card.reading!, topicKey: "lower-idea" } }));
  const state = readingWorkspace([...near, ...lower]);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/session") return Response.json({ mutationToken: "fixture-token" });
    if (url.startsWith("/api/state?")) return Response.json(state);
    if (url.endsWith("/native-approvals")) return Response.json([]);
    if (url === "/api/voice/target-change") return Response.json(JSON.parse(String(init?.body)).target);
    throw new Error(`Unexpected fixture request: ${url}`);
  }) as typeof fetch;
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.tagName !== "ARTICLE") return originalRect.call(this);
    const low = this.getAttribute("data-card-id")?.startsWith("lower-");
    const center = window.innerHeight * (low ? .8 : .42);
    return { x: 0, y: center - 60, top: center - 60, bottom: center + 60, left: 0, right: 600, width: 600, height: 120, toJSON: () => ({}) };
  };
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const app = await mountReadingApp(near[0].feedId);
  try {
    const ui = app.ui;
    await waitFor(() => expect(ui.queryAllByRole("button", { name: "Next version" }).length).toBe(2), { onTimeout: (error) => error });
    await frame();
    const lowerArticle = () => Array.from(ui.container.querySelectorAll<HTMLElement>("article[data-reading-group]")).find((article) => article.dataset.cardId?.startsWith("lower-"))!;
    const nearArticle = () => Array.from(ui.container.querySelectorAll<HTMLElement>("article[data-reading-group]")).find((article) => !article.dataset.cardId?.startsWith("lower-"))!;
    const nearId = nearArticle().dataset.cardId;
    const initialLowerId = lowerArticle().dataset.cardId;
    const nextButton = lowerArticle().querySelector<HTMLButtonElement>('button[aria-label="Next version"]')!;
    nextButton.focus();
    fireEvent.click(nextButton);
    await frame();
    const secondLowerId = lowerArticle().dataset.cardId;
    expect(secondLowerId).not.toBe(initialLowerId);
    expect(lowerArticle().classList.contains("is-active")).toBe(true);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await frame();
    expect(lowerArticle().dataset.cardId).not.toBe(secondLowerId);
    expect(nearArticle().dataset.cardId).toBe(nearId);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await frame();
    expect(lowerArticle().dataset.cardId).toBe(initialLowerId);
    expect(nearArticle().dataset.cardId).toBe(nearId);
    fireEvent.scroll(window);
    await frame();
    await waitFor(() => expect(nearArticle().classList.contains("is-active")).toBe(true), { onTimeout: (error) => error });
  } finally { app.close(); HTMLElement.prototype.getBoundingClientRect = originalRect; sessionStorage.clear(); }
});

test("a native reading face stays exact and blind until its separate author control is opened", () => {
  const card = readingCard({ why: "Codex was the subject of the fixture meeting, not an author label." });
  card.reading!.reviewEdit = { by: "Fixture editor", note: "This is an explicitly requested follow-up." };
  const ui = render(readingView(card));
  expect(ui.getByRole("heading", { name: card.title }).textContent).toBe(card.title);
  expect(ui.container.querySelector(".reading-face")?.textContent).toBe(card.why);
  expect((ui.container.querySelector("details.reading-sources") as HTMLDetailsElement).open).toBe(false);
  expect(ui.container.querySelector("blockquote p")?.textContent).toBe("An exact <fixture> quote.");
  expect(ui.container.textContent).not.toContain("Fixture reader");
  expect(ui.container.textContent).not.toContain("confirmed-fixture-model");
  expect(ui.container.textContent).not.toContain("Fixture editor");
  expect(ui.getByText("Edited")).toBeTruthy();
  fireEvent.click(ui.getByText("Sources", { selector: "summary" }));
  expect(ui.container.textContent).not.toContain("confirmed-fixture-model");
  fireEvent.click(ui.getByRole("button", { name: "Author information" }));
  expect(ui.getByText("Fixture reader")).toBeTruthy();
  expect(ui.getByText("Model used")).toBeTruthy();
  expect(ui.getByText("confirmed-fixture-model")).toBeTruthy();
  expect(ui.getByText("requested-fixture-model")).toBeTruthy();
  expect(ui.getByText("Edited by Fixture editor: This is an explicitly requested follow-up.")).toBeTruthy();
  fireEvent.click(ui.getByRole("button", { name: "Author information" }));
  expect(ui.queryByRole("group", { name: "Author details" }) === null).toBe(true);
  expect(ui.container.querySelectorAll("textarea").length).toBe(0);
  expect(ui.container.querySelector('a[href="/feed/fixture-company/prompts#source-run-fixture-run"]')).toBeTruthy();
});

test("reading cards never inherit cleanup or execute actions; ordinary cards still do", () => {
  const card = readingCard({
    actions: [{ id: "send", label: "Send external message", behavior: "approve_action", variant: "primary", externalMutation: true }],
    proposedAction: { label: "Send external message", instruction: "Fixture only", externalMutation: true },
    blocks: [{ id: "editable", type: "editable_text", value: "Read-only fixture text." }],
  });
  expect(visibleCardActions(card)).toEqual([]);
  const html = renderToStaticMarkup(readingView(card));
  expect(html).not.toContain("Send external message");
  expect(html).not.toContain("Next thing");
  expect(html).not.toContain(">Archive<");
  expect(html).not.toContain("<textarea");
  const legacy = { ...card, reading: undefined };
  expect(visibleCardActions(legacy).map((action) => action.label)).toEqual(["Dismiss card", "Send external message"]);
  expect(renderToStaticMarkup(readingView(legacy))).toContain("Send external message");
});

test("Done reading cards retain the reaction and route Feedback to the existing dock", () => {
  let feedbackRequests = 0;
  const card = readingCard({ status: "done", history: [{ at: "2026-09-02T12:02:00Z", type: "user.scoped_instruction", detail: "A fixture spoken comment." }] });
  const ui = render(readingView(card, {
    readingReaction: { reaction: "like", contentRevision: "revision-1", eventId: "reaction-1", at: "2026-09-02T12:01:00Z" },
    onReadingFeedback: () => { feedbackRequests += 1; },
  }));
  expect(ui.getByRole("button", { name: "Like" }).getAttribute("aria-pressed")).toBe("true");
  expect(ui.getByText("Liked · archived in Tend")).toBeTruthy();
  expect(ui.getByText("A fixture spoken comment.")).toBeTruthy();
  expect(ui.queryByRole("button", { name: "Review again" })).toBeNull();
  fireEvent.click(ui.getByRole("button", { name: "Feedback" }));
  expect(feedbackRequests).toBe(1);
  expect(ui.container.querySelectorAll("textarea").length).toBe(0);
  ui.rerender(readingView(card, { readingReaction: { reaction: "like", contentRevision: "old-revision", eventId: "old-event", at: "2026-09-02T12:01:00Z" } }));
  expect(ui.getByRole("button", { name: "Like" }).getAttribute("aria-pressed")).toBe("false");
});

test("a reading reaction waits for confirmation and posts only the revision-bound local reaction", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let resolveResponse: ((response: Response) => void) | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/session") return Response.json({ mutationToken: "fixture-token" });
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return await new Promise<Response>((resolve) => { resolveResponse = resolve; });
  }) as typeof fetch;
  let changed = 0;
  let targeted = 0;
  const ui = render(readingView(readingCard(), { onChanged: () => { changed += 1; }, onReadingReaction: () => { targeted += 1; } }));
  fireEvent.click(ui.getByRole("button", { name: "Like" }));
  await waitFor(() => expect(calls.length).toBe(1));
  expect((ui.getByRole("button", { name: "Like" }) as HTMLButtonElement).disabled).toBe(true);
  expect(ui.getByRole("button", { name: "Like" }).getAttribute("aria-pressed")).toBe("false");
  expect(changed).toBe(0);
  expect(calls[0].url).toBe("/api/feeds/fixture-company/cards/fixture-reading/reaction");
  expect(calls[0].body).toEqual({ clientEventId: expect.any(String), contentRevision: "revision-1", reaction: "like" });
  resolveResponse!(Response.json({ duplicate: false, card: readingCard({ status: "done" }) }));
  await waitFor(() => expect(changed).toBe(1));
  expect(targeted).toBe(1);
  expect(ui.getByRole("button", { name: "Like" }).getAttribute("aria-pressed")).toBe("true");
});

test("retrying an uncertain reaction reuses its event ID", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "/api/session") return Response.json({ mutationToken: "fixture-token" });
    if (!String(input).endsWith("/reaction")) throw new Error("Unexpected non-reaction request");
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) throw new Error("Connection interrupted");
    return Response.json({ duplicate: true, card: readingCard({ status: "done" }) });
  }) as typeof fetch;
  const ui = render(readingView());
  fireEvent.click(ui.getByRole("button", { name: "Not for me" }));
  await waitFor(() => expect(ui.getByRole("alert").textContent).toContain("Connection interrupted"));
  fireEvent.click(ui.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(bodies.length).toBe(2));
  expect(bodies[1]).toEqual(bodies[0]);
  await waitFor(() => expect(ui.getByRole("button", { name: "Not for me" }).getAttribute("aria-pressed")).toBe("true"));
});

test("a stale reading face cannot keep accepting reactions", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => String(input) === "/api/session"
    ? Response.json({ mutationToken: "fixture-token" })
    : Response.json({ error: "stale_content" }, { status: 409 })) as typeof fetch;
  let changed = 0;
  const ui = render(readingView(readingCard(), { onChanged: () => { changed += 1; } }));
  fireEvent.click(ui.getByRole("button", { name: "Like" }));
  await waitFor(() => expect(ui.getByRole("alert").textContent).toContain("This card changed"));
  expect((ui.getByRole("button", { name: "Like" }) as HTMLButtonElement).disabled).toBe(true);
  expect((ui.getByRole("button", { name: "Not for me" }) as HTMLButtonElement).disabled).toBe(true);
  expect(changed).toBe(1);
});

test("active reading feedback cannot be archived by a new reaction, and a busy conflict is not called stale", async () => {
  const ui = render(readingView(readingCard({ status: "queued" })));
  expect((ui.getByRole("button", { name: "Like" }) as HTMLButtonElement).disabled).toBe(true);
  expect((ui.getByRole("button", { name: "Not for me" }) as HTMLButtonElement).disabled).toBe(true);
  expect((ui.getByRole("button", { name: "Feedback" }) as HTMLButtonElement).disabled).toBe(false);
  ui.rerender(readingView(readingCard()));
  globalThis.fetch = (async (input: string | URL | Request) => String(input) === "/api/session"
    ? Response.json({ mutationToken: "fixture-token" })
    : Response.json({ error: "This card has active work. Finish that work before archiving it with a reaction.", code: "card_busy" }, { status: 409 })) as typeof fetch;
  fireEvent.click(ui.getByRole("button", { name: "Like" }));
  await waitFor(() => expect(ui.getByRole("alert").textContent).toContain("active work"));
  expect(ui.getByRole("alert").textContent).not.toContain("This card changed");
});

test("the existing dock focuses and submits a comment for a Done reading card without another input", () => {
  const card = readingCard({ status: "done" });
  const state = readingWorkspace([card]);
  const feed = state.active;
  const target = { kind: "card" as const, feedId: card.feedId, cardId: card.id };
  const submitted: string[] = [];
  const ui = render(<Dock state={state} feed={feed} target={target} ladder={[target, { kind: "feed", feedId: card.feedId }]} targetVersion={1} focusRequest={1} canRouteToClaude={false} routeToClaude={false} onRouteToClaude={() => {}} onTarget={() => {}} onSubmit={(text) => submitted.push(text)} onRecollect={() => {}} />);
  const input = ui.getByRole("textbox", { name: "Instruction for Codex" });
  expect(ui.getAllByRole("textbox").length).toBe(1);
  expect(document.activeElement).toBe(input);
  expect(ui.getByText(card.title)).toBeTruthy();
  fireEvent.change(input, { target: { value: "This fixture perspective was useful." } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(submitted).toEqual(["This fixture perspective was useful."]);
});

test("Like followed by a feed refresh keeps voice feedback on the archived card, not its replacement", async () => {
  sessionStorage.clear();
  globalThis.EventSource = class { addEventListener() {} close() {} } as unknown as typeof EventSource;
  const first = readingCard();
  const second = readingCard({ id: "fixture-second", title: "A different fixture card" });
  let state = readingWorkspace([first, second]);
  const instructions: Array<{ target: unknown; instruction: string }> = [];
  const reactions: Array<{ reaction: string; contentRevision: string }> = [];
  let refreshedAfterReaction = false;
  // Full-router updates cross several async boundaries. Keep each wait bounded and report
  // primitive assertions instead of serializing Happy DOM's circular node graph on failure.
  const waitOptions = { timeout: 5_000, onTimeout: (error: Error) => error };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/session") return Response.json({ mutationToken: "fixture-token" });
    if (url.startsWith("/api/state?")) {
      if (reactions.length) refreshedAfterReaction = true;
      return Response.json(state);
    }
    if (url.endsWith("/native-approvals")) return Response.json([]);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url === "/api/voice/target-change") return Response.json(body.target);
    if (url.endsWith(`/cards/${first.id}/reaction`)) {
      reactions.push(body);
      const done = { ...first, status: "done" as const };
      state = { ...state, active: { ...state.active, cards: [done, second], readingReactions: { [first.id]: { reaction: "like", contentRevision: first.reading!.contentRevision, eventId: "fixture-reaction", at: "2026-09-02T12:01:00Z" } } } };
      return Response.json({ duplicate: false, card: done });
    }
    if (url === "/api/voice/instructions") {
      instructions.push(body);
      return Response.json({ kind: "scoped_work", work: { id: "fixture-work", intent: "voice_instruction" } });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  }) as typeof fetch;
  const root = createRootRoute({ component: () => <App feedId={first.feedId} screen="feed" workspaceTab="feed" /> });
  const index = createRoute({ getParentRoute: () => root, path: "/" });
  const router = createRouter({ routeTree: root.addChildren([index]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await router.load();
  const ui = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  try {
    await waitFor(() => expect(ui.queryByRole("heading", { name: first.title }) !== null).toBe(true), waitOptions);
    fireEvent.click(ui.getAllByRole("button", { name: "Like" })[0]);
    await waitFor(() => expect(reactions.length).toBe(1), waitOptions);
    expect(reactions[0]).toMatchObject({ reaction: "like", contentRevision: first.reading!.contentRevision });
    await waitFor(() => expect(refreshedAfterReaction).toBe(true), waitOptions);
    await waitFor(() => expect(ui.queryByRole("heading", { name: first.title }) === null).toBe(true), waitOptions);
    expect(ui.container.querySelector(".dock-target")?.textContent).toBe(first.title);
    fireEvent.mouseEnter(ui.getByRole("heading", { name: second.title }).closest("article")!);
    expect(ui.container.querySelector(".dock-target")?.textContent).toBe(first.title);
    const input = ui.getByRole("textbox", { name: "Instruction for Codex" });
    input.focus();
    fireEvent.change(input, { target: { value: "This perspective was useful." } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(instructions.length).toBe(1), waitOptions);
    expect(instructions[0]).toMatchObject({ target: { kind: "card", feedId: first.feedId, cardId: first.id }, instruction: "This perspective was useful." });
  } finally {
    ui.unmount();
    client.clear();
    sessionStorage.clear();
  }
}, 20_000);

test("a started reason stays on its exact version through comparison, group archive and a same-tab reload", async () => {
  sessionStorage.clear();
  globalThis.EventSource = class { addEventListener() {} close() {} } as unknown as typeof EventSource;
  const versions = readingVersions();
  const reasonCard = versions[0];
  reasonCard.status = "done";
  const nextIdea = readingCard({ id: "next-idea", title: "A separate fixture idea" });
  let state = readingWorkspace([...versions, nextIdea]);
  state.active.readingReactions = { [reasonCard.id]: { reaction: "like", contentRevision: reasonCard.reading!.contentRevision, eventId: "earlier-like", at: "2026-09-02T12:00:00Z" } };
  const instructions: Array<{ target: unknown; instruction: string }> = [];
  const preferences: ReadingPreferenceInput[] = [];
  const waitOptions = { timeout: 5_000, onTimeout: (error: Error) => error };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/session") return Response.json({ mutationToken: "fixture-token" });
    if (url.startsWith("/api/state?")) return Response.json(state);
    if (url.endsWith("/native-approvals")) return Response.json([]);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url === "/api/voice/target-change") return Response.json(body.target);
    if (url.endsWith("/reading-preferences")) {
      preferences.push(body);
      const group = groupReadingCards(versions)[0];
      state = { ...state, active: { ...state.active, cards: state.active.cards.map((card) => versions.some((version) => version.id === card.id) ? { ...card, status: "done" } : card), readingPreferences: { [group.id]: { ...body, eventId: "fixture-preference", at: "2026-09-02T12:05:00Z" } } } };
      return Response.json({ duplicate: false, cards: state.active.cards.filter((card) => card.reading?.topicKey === group.topicKey) });
    }
    if (url === "/api/voice/instructions") {
      instructions.push(body);
      return Response.json({ kind: "scoped_work", work: { id: "fixture-voice", intent: "voice_instruction" } });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  }) as typeof fetch;
  const mount = () => mountReadingApp(reasonCard.feedId);
  let app = await mount();
  try {
    let ui = app.ui;
    await waitFor(() => expect(ui.queryByRole("button", { name: "Next version" }) !== null).toBe(true), waitOptions);
    for (let count = 0; count < versions.length && !ui.queryByRole("heading", { name: reasonCard.title }); count += 1) fireEvent.click(ui.getByRole("button", { name: "Next version" }));
    expect(ui.queryByRole("heading", { name: reasonCard.title }) !== null).toBe(true);
    const article = ui.container.querySelector("article[data-reading-group]")!;
    fireEvent.click(Array.from(article.querySelectorAll("button")).find((button) => button.textContent === "Feedback")!);
    let input = ui.getByRole("textbox", { name: "Instruction for Codex" });
    input.focus();
    // React's Happy DOM input fallback observes keyup; a change-only event mutates the DOM
    // without exercising controlled input state, so it cannot verify a draft across renders.
    fireEvent.input(input, { target: { value: "A reason about the earlier version, not the next one." } });
    fireEvent.keyUp(input, { key: "." });
    expect((input as HTMLTextAreaElement).value).toBe("A reason about the earlier version, not the next one.");
    fireEvent.click(ui.getByRole("button", { name: "Next version" }));
    expect((input as HTMLTextAreaElement).value).toBe("A reason about the earlier version, not the next one.");
    const chosenId = ui.container.querySelector("article[data-reading-group]")!.getAttribute("data-card-id")!;
    const chosen = versions.find((card) => card.id === chosenId)!;
    expect(chosen.id).not.toBe(reasonCard.id);
    await app.client.invalidateQueries({ queryKey: ["workspace", reasonCard.feedId] });
    await waitFor(() => expect(ui.queryByRole("heading", { name: chosen.title }) !== null).toBe(true), waitOptions);
    expect(ui.container.querySelector(".dock-target")?.textContent).toBe(reasonCard.title);
    fireEvent.click(ui.getByRole("button", { name: "Prefer this version" }));
    await waitFor(() => expect(preferences.length).toBe(1), waitOptions);
    await waitFor(() => expect(ui.container.querySelector("article[data-reading-group]") === null).toBe(true), waitOptions);
    expect(preferences[0].preferredCardId).toBe(chosen.id);
    expect(state.active.readingReactions?.[reasonCard.id].reaction).toBe("like");
    expect(state.active.readingReactions?.[chosen.id]).toBeUndefined();
    expect(ui.container.querySelector(".dock-target")?.textContent).toBe(reasonCard.title);
    expect((input as HTMLTextAreaElement).value).toBe("A reason about the earlier version, not the next one.");
    fireEvent.click(ui.getByRole("button", { name: /^Done/ }));
    expect(ui.queryByRole("heading", { name: chosen.title }) !== null).toBe(true);
    expect(ui.getByRole("button", { name: "Prefer this version" }).getAttribute("aria-pressed")).toBe("true");
    app.close();
    app = await mount();
    ui = app.ui;
    await waitFor(() => expect(ui.queryByRole("heading", { name: nextIdea.title }) !== null).toBe(true), waitOptions);
    expect(ui.container.querySelector(".dock-target")?.textContent).toBe(reasonCard.title);
    fireEvent.click(ui.getByRole("button", { name: /^Done/ }));
    expect(ui.queryByRole("heading", { name: chosen.title }) !== null).toBe(true);
    expect(ui.container.querySelector(".reading-face")?.textContent).toBe(chosen.why);
    input = ui.getByRole("textbox", { name: "Instruction for Codex" });
    input.focus();
    fireEvent.input(input, { target: { value: "The reason is still about the earlier version." } });
    fireEvent.keyUp(input, { key: "." });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(instructions.length).toBe(1), waitOptions);
    expect(instructions[0]).toMatchObject({ target: { kind: "card", feedId: reasonCard.feedId, cardId: reasonCard.id }, instruction: "The reason is still about the earlier version." });
  } finally { app.close(); sessionStorage.clear(); }
}, 20_000);

test("an empty restored dock follows the next preference, and a late reply cannot clear a newer same-target reason", async () => {
  sessionStorage.clear();
  globalThis.EventSource = class { addEventListener() {} close() {} } as unknown as typeof EventSource;
  const groupA = readingVersions(2);
  const groupB = readingVersions(2).map((card) => ({ ...card, id: `second-${card.id}`, title: `Second idea ${card.title}`, reading: { ...card.reading!, topicKey: "second-idea" } }));
  const allCards = [...groupA, ...groupB];
  let state = readingWorkspace(allCards);
  const preferences: ReadingPreferenceInput[] = [];
  const instructions: Array<{ target: { cardId: string }; instruction: string }> = [];
  const voiceResponses: Array<(response: Response) => void> = [];
  let stateReads = 0;
  const waitOptions = { timeout: 5_000, onTimeout: (error: Error) => error };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/session") return Response.json({ mutationToken: "fixture-token" });
    if (url.startsWith("/api/state?")) { stateReads += 1; return Response.json(state); }
    if (url.endsWith("/native-approvals")) return Response.json([]);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url === "/api/voice/target-change") return Response.json(body.target);
    if (url.endsWith("/reading-preferences")) {
      preferences.push(body);
      const group = groupReadingCards(allCards).find((item) => item.runId === body.runId && item.topicKey === body.topicKey)!;
      state = { ...state, active: { ...state.active, cards: state.active.cards.map((card) => group.cards.some((member) => member.id === card.id) ? { ...card, status: "done" } : card), readingPreferences: { ...state.active.readingPreferences, [group.id]: { ...body, eventId: `choice-${preferences.length}`, at: "2026-09-02T12:05:00Z" } } } };
      return Response.json({ duplicate: false, cards: state.active.cards.filter((card) => card.reading?.topicKey === group.topicKey) });
    }
    if (url === "/api/voice/instructions") {
      instructions.push(body);
      return new Promise<Response>((resolve) => voiceResponses.push(resolve));
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  }) as typeof fetch;
  let app = await mountReadingApp(groupA[0].feedId);
  try {
    let ui = app.ui;
    await waitFor(() => expect(ui.queryAllByRole("button", { name: "Prefer this version" }).length).toBe(2), waitOptions);
    fireEvent.click(ui.getAllByRole("button", { name: "Prefer this version" })[0]);
    await waitFor(() => expect(ui.queryAllByRole("button", { name: "Prefer this version" }).length).toBe(1), waitOptions);
    const firstId = preferences[0].preferredCardId!;
    expect(ui.container.querySelector(".dock-target")?.textContent).toBe(allCards.find((card) => card.id === firstId)!.title);
    app.close();
    app = await mountReadingApp(groupA[0].feedId);
    ui = app.ui;
    await waitFor(() => expect(ui.queryAllByRole("button", { name: "Prefer this version" }).length).toBe(1), waitOptions);
    expect((ui.getByRole("textbox", { name: "Instruction for Codex" }) as HTMLTextAreaElement).value).toBe("");
    fireEvent.click(ui.getByRole("button", { name: "Prefer this version" }));
    await waitFor(() => expect(preferences.length).toBe(2), waitOptions);
    await waitFor(() => expect(ui.queryAllByRole("button", { name: "Prefer this version" }).length).toBe(0), waitOptions);
    const secondId = preferences[1].preferredCardId!;
    const secondTitle = allCards.find((card) => card.id === secondId)!.title;
    expect(secondId).not.toBe(firstId);
    expect(ui.container.querySelector(".dock-target")?.textContent).toBe(secondTitle);
    const input = ui.getByRole("textbox", { name: "Instruction for Codex" });
    input.focus();
    fireEvent.input(input, { target: { value: "First reason on the newly preferred version." } });
    fireEvent.keyUp(input, { key: "." });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(instructions.length).toBe(1), waitOptions);
    expect(instructions[0].target.cardId).toBe(secondId);
    fireEvent.input(input, { target: { value: "A newer reason on the same exact version." } });
    fireEvent.keyUp(input, { key: "." });
    fireEvent.click(ui.getByRole("button", { name: /^Done/ }));
    const earlierArticle = ui.getByRole("heading", { name: allCards.find((card) => card.id === firstId)!.title }).closest("article")!;
    fireEvent.mouseEnter(earlierArticle);
    const readsBeforeResponse = stateReads;
    voiceResponses[0](Response.json({ kind: "scoped_work", work: { id: "voice-1", intent: "voice_instruction" } }));
    await waitFor(() => expect(stateReads > readsBeforeResponse).toBe(true), waitOptions);
    expect(ui.container.querySelector(".dock-target")?.textContent).toBe(secondTitle);
    expect((input as HTMLTextAreaElement).value).toBe("A newer reason on the same exact version.");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(instructions.length).toBe(2), waitOptions);
    expect(instructions[1]).toMatchObject({ target: { cardId: secondId }, instruction: "A newer reason on the same exact version." });
    voiceResponses[1](Response.json({ kind: "scoped_work", work: { id: "voice-2", intent: "voice_instruction" } }));
  } finally { app.close(); sessionStorage.clear(); }
}, 20_000);

test("source-run history keeps preferences alongside individual ratings and labels earlier membership", () => {
  const versions = readingVersions(2);
  const group = groupReadingCards(versions)[0];
  const preference: ReadingPreferenceState = { runId: group.runId!, topicKey: group.topicKey!, members: readingMembers(group), preferredCardId: versions[0].id, eventId: "fixture-choice", at: "2026-09-02T12:05:00Z" };
  const run: SourceRun = { id: group.runId!, feedId: versions[0].feedId, sourceId: "Fixture source", snapshots: 1, judgments: [], completedAt: "2026-09-02T12:00:00Z", readers: versions.map((card) => card.reading!.writer) };
  const reactions = { [versions[1].id]: { reaction: "like" as const, contentRevision: versions[1].reading!.contentRevision, eventId: "old-like", at: "2026-09-02T12:01:00Z" } };
  const current = renderToStaticMarkup(<SourceRunHistory runs={[run]} cards={versions} reactions={reactions} preferences={{ [group.id]: preference }} />);
  expect(current).toContain("Preferred version");
  expect(current).toContain("Current comparison");
  expect(current).toContain("Individual ratings are unchanged");
  expect(current).toContain("Liked");
  const expanded = renderToStaticMarkup(<SourceRunHistory runs={[run]} cards={readingVersions(3)} reactions={reactions} preferences={{ [group.id]: preference }} />);
  expect(expanded).toContain("Earlier comparison");
  expect(expanded).not.toContain("Current comparison");
  expect(expanded).toContain("It is not a preference for the current set");
});

test("generic reader receipts stay in source-run history with requested and actual models distinguished", () => {
  const writer = readingCard().reading!.writer;
  const run: SourceRun = { id: "fixture-run", feedId: "fixture-company", sourceId: "Fixture source", snapshots: 1, judgments: [], completedAt: "2026-09-02T12:00:00Z", readers: [
    writer,
    { ...writer, readerId: "second", label: "Second reader", adapter: "codex", actualModel: undefined, requestedModel: "second-requested-model" },
    { ...writer, readerId: "third", label: "Third reader", status: "failed", actualModel: undefined, error: "Fixture access unavailable" },
  ] };
  const liked = readingCard({ status: "done" });
  const cleared = readingCard({ id: "cleared", title: "Cleared fixture", status: "done" });
  const unrated = readingCard({ id: "unrated", title: "Unrated fixture" });
  const html = renderToStaticMarkup(<SourceRunHistory runs={[run]} cards={[liked, cleared, unrated]} reactions={{
    [liked.id]: { reaction: "like", contentRevision: "revision-1", eventId: "like", at: "2026-09-02T12:01:00Z" },
    [cleared.id]: { reaction: null, contentRevision: "revision-1", eventId: "clear", at: "2026-09-02T12:02:00Z" },
  }} />);
  expect(html).toContain("Source run history");
  expect(html).toContain("3 readers");
  expect(html).toContain("Fixture reader");
  expect(html).toContain("Second reader");
  expect(html).toContain("Third reader");
  expect(html).toContain("Requested model");
  expect(html).toContain("confirmed-fixture-model");
  expect(html).toContain("Fixture access unavailable");
  expect(html).toContain("Open saved reader output");
  expect(html).toContain("/api/feeds/fixture-company/runs/fixture-run/readers/fixture-reader/output");
  expect(html).toContain("Liked");
  expect(html).toContain("Reaction cleared");
  expect(html).toContain("Unrated");
  expect(html).toContain(liked.why);
  expect(html).not.toContain("Feed for One");
});

test("a stream visit retains the chosen version for feedback and history navigation, but a fresh visit starts unread", async () => {
  sessionStorage.clear();
  globalThis.EventSource = class { addEventListener() {} close() {} } as unknown as typeof EventSource;
  const versions = readingVersions(2);
  const nextIdea = readingCard({ id: "stream-next-idea", title: "Another idea still waiting to be read" });
  const group = groupReadingCards(versions)[0];
  let state = readingWorkspace([...versions, nextIdea]);
  state.active.config.readingMode = "stream";
  const preferences: ReadingPreferenceInput[] = [];
  const instructions: Array<{ target: unknown; instruction: string }> = [];
  const waitOptions = { timeout: 5_000, onTimeout: (error: Error) => error };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/session") return Response.json({ mutationToken: "fixture-token" });
    if (url.startsWith("/api/state?")) return Response.json(state);
    if (url.endsWith("/native-approvals")) return Response.json([]);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url === "/api/voice/target-change") return Response.json(body.target);
    if (url.endsWith("/engagement")) return Response.json({ duplicate: false, event: {} });
    if (url.endsWith("/reading-preferences")) {
      preferences.push(body);
      // Return fresh objects, as an actual state refresh does. Retaining the cards must
      // retain their position and selection, not stale pre-preference card objects.
      const cards = state.active.cards.map((card) => versions.some((version) => version.id === card.id)
        ? { ...card, status: "done" as const, updatedAt: "2026-09-04T12:05:00.000Z" }
        : { ...card });
      state = { ...state, active: { ...state.active, cards, readingPreferences: {
        [group.id]: { ...body, eventId: "stream-preference", at: "2026-09-04T12:05:00Z" },
      } } };
      return Response.json({ duplicate: false, cards: cards.filter((card) => card.reading?.topicKey === group.topicKey) });
    }
    if (url === "/api/voice/instructions") {
      instructions.push(body);
      return Response.json({ kind: "scoped_work", work: { id: "stream-reason", intent: "voice_instruction" } });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  }) as typeof fetch;
  let app = await mountReadingApp(versions[0].feedId);
  try {
    let ui = app.ui;
    await waitFor(() => expect(ui.queryByRole("button", { name: "Next version" }) !== null).toBe(true), waitOptions);
    const positionsBefore = Array.from(ui.container.querySelectorAll("[data-reading-slot]")).map((slot) => slot.getAttribute("data-reading-slot"));
    fireEvent.click(ui.getByRole("button", { name: "Next version" }));
    const chosenId = ui.container.querySelector("article[data-reading-group]")!.getAttribute("data-card-id")!;
    const chosen = versions.find((card) => card.id === chosenId)!;
    fireEvent.click(ui.getByRole("button", { name: "Prefer this version" }));
    await waitFor(() => expect(preferences.length).toBe(1), waitOptions);
    await waitFor(() => expect(ui.container.querySelector("article[data-reading-group]")?.closest("[data-reading-slot]")?.getAttribute("data-reading-state")).toBe("reviewed"), waitOptions);
    expect(ui.queryByRole("heading", { name: chosen.title }) !== null).toBe(true);
    expect(ui.container.querySelector("article[data-reading-group]")!.getAttribute("data-card-id")).toBe(chosenId);
    expect(Array.from(ui.container.querySelectorAll("[data-reading-slot]")).map((slot) => slot.getAttribute("data-reading-slot"))).toEqual(positionsBefore);
    expect(ui.container.querySelector(".tabs button")?.textContent).toBe("Feed1 unread");
    expect(ui.getByRole("button", { name: "Prefer this version" }).getAttribute("aria-pressed")).toBe("true");
    expect(ui.container.querySelector("article[data-reading-group]")!.closest("[data-reading-slot]")!.textContent).toContain("Reviewed · feedback welcome");
    expect(state.active.readingReactions).toBeUndefined();
    const readHistory = Array.from(ui.container.querySelectorAll(".tabs button")).find((button) => button.textContent?.startsWith("Read history"))!;
    fireEvent.click(readHistory);
    await waitFor(() => expect(ui.queryByRole("heading", { name: chosen.title }) !== null).toBe(true), waitOptions);
    fireEvent.click(ui.container.querySelector(".tabs button")!);
    await waitFor(() => expect(ui.queryByRole("heading", { name: nextIdea.title }) !== null).toBe(true), waitOptions);
    expect(ui.queryByRole("heading", { name: chosen.title }) !== null).toBe(true);
    const article = ui.container.querySelector("article[data-reading-group]")!;
    fireEvent.click(Array.from(article.querySelectorAll("button")).find((button) => button.textContent === "Feedback")!);
    expect(ui.container.querySelector(".dock-target")?.textContent).toBe(chosen.title);
    const input = ui.getByRole("textbox", { name: "Instruction for Codex" });
    input.focus();
    fireEvent.input(input, { target: { value: "I prefer this version because it names the concrete tradeoff." } });
    fireEvent.keyUp(input, { key: "." });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(instructions.length).toBe(1), waitOptions);
    expect(instructions[0]).toMatchObject({ target: { kind: "card", feedId: chosen.feedId, cardId: chosen.id }, instruction: "I prefer this version because it names the concrete tradeoff." });
    app.close();
    app = await mountReadingApp(chosen.feedId);
    ui = app.ui;
    await waitFor(() => expect(ui.queryByRole("heading", { name: nextIdea.title }) !== null).toBe(true), waitOptions);
    expect(ui.queryByRole("heading", { name: chosen.title }) === null).toBe(true);
    expect(ui.container.querySelector("article[data-reading-group]") === null).toBe(true);
    expect(ui.container.querySelector(".tabs button")?.textContent).toBe("Feed1 unread");
  } finally { app.close(); sessionStorage.clear(); }
}, 20_000);

test("liking one stream version keeps the topic unread and unmuted until its alternatives are handled", async () => {
  sessionStorage.clear();
  globalThis.EventSource = class { addEventListener() {} close() {} } as unknown as typeof EventSource;
  const versions = readingVersions(2);
  const nextIdea = readingCard({ id: "partial-like-next", title: "An independent unread idea" });
  let state = readingWorkspace([...versions, nextIdea]);
  state.active.config.readingMode = "stream";
  const reactions: Array<{ cardId: string; body: Record<string, unknown> }> = [];
  const waitOptions = { timeout: 5_000, onTimeout: (error: Error) => error };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/session") return Response.json({ mutationToken: "fixture-token" });
    if (url.startsWith("/api/state?")) return Response.json(state);
    if (url.endsWith("/native-approvals")) return Response.json([]);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url === "/api/voice/target-change") return Response.json(body.target);
    if (url.endsWith("/engagement")) return Response.json({ duplicate: false, event: {} });
    const card = versions.find((version) => url.endsWith(`/cards/${version.id}/reaction`));
    if (card) {
      reactions.push({ cardId: card.id, body });
      const done = { ...card, status: "done" as const, updatedAt: "2026-09-04T12:06:00.000Z" };
      state = { ...state, active: { ...state.active, cards: state.active.cards.map((member) => member.id === card.id ? done : { ...member }), readingReactions: {
        [card.id]: { reaction: "like", contentRevision: card.reading!.contentRevision, eventId: "stream-like", at: "2026-09-04T12:06:00Z" },
      } } };
      return Response.json({ duplicate: false, card: done });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  }) as typeof fetch;
  const app = await mountReadingApp(versions[0].feedId);
  const { ui } = app;
  try {
    await waitFor(() => expect(ui.queryByRole("button", { name: "Next version" }) !== null).toBe(true), waitOptions);
    const article = ui.container.querySelector("article[data-reading-group]")!;
    const chosenId = article.getAttribute("data-card-id")!;
    const like = Array.from(article.querySelectorAll("button")).find((button) => button.textContent === "Like")!;
    fireEvent.click(like);
    await waitFor(() => expect(reactions.length).toBe(1), waitOptions);
    await waitFor(() => expect(ui.container.querySelector("article[data-reading-group]")!.textContent).toContain("Liked · saved"), waitOptions);
    const current = ui.container.querySelector("article[data-reading-group]")!;
    const slot = current.closest("[data-reading-slot]")!;
    expect(current.getAttribute("data-card-id")).toBe(chosenId);
    expect(slot.getAttribute("data-reading-state")).toBe("unread");
    expect(slot.classList.contains("is-complete")).toBe(false);
    expect(ui.container.querySelector(".tabs button")?.textContent).toBe("Feed2 unread");
    expect(state.active.cards.find((card) => card.id === chosenId)?.status).toBe("done");
    expect(state.active.cards.find((card) => versions.some((version) => version.id === card.id) && card.id !== chosenId)?.status).toBe("to_review_new");
    expect(state.active.readingPreferences).toBeUndefined();
    expect(state.active.readingProgress).toBeUndefined();
  } finally { app.close(); sessionStorage.clear(); }
}, 20_000);

test("untrusted programmatic clicks never record engagement, including after switching the displayed version", async () => {
  const group = groupReadingCards(readingVersions(2))[0];
  const first = group.cards[0];
  const second = group.cards[1];
  const versionChanges: string[] = [];
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/session") return Response.json({ mutationToken: "fixture-token" });
    requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return Response.json({ duplicate: false, event: {} });
  }) as typeof fetch;
  const wrapper = (card: Card) => <ReadingStreamCard group={group} card={card} enabled={false} history={false} busy={false} onRead={() => {}} onChanged={() => {}} engagementSessionId="fixture-browser-session">{readingView(card, { readingGroup: group, onReadingVersion: (cardId) => versionChanges.push(cardId) })}</ReadingStreamCard>;
  const ui = render(wrapper(first));
  expect(requests).toHaveLength(0);
  fireEvent.click(ui.getByRole("button", { name: "Next version" }));
  expect(versionChanges).toEqual([second.id]);
  ui.rerender(wrapper(second));
  fireEvent.click(ui.getByRole("button", { name: "Feedback" }));
  // Let any accidentally launched session-token/post promise finish before asserting.
  // Genuine trusted interaction and exact-version attribution are exercised in browser QA.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(requests).toHaveLength(0);
});

test("engagement distinguishes source expansion, collapse and links without preserving source URLs", () => {
  const ui = render(readingView());
  const details = ui.container.querySelector<HTMLDetailsElement>(".reading-sources")!;
  const summary = details.querySelector("summary")!;
  details.open = false;
  expect(engagementClickTarget(summary)).toBe("sources_open");
  details.open = true;
  expect(engagementClickTarget(summary)).toBe("sources_close");
  expect(engagementClickTarget(ui.getByRole("link", { name: "Fixture transcript" }))).toBe("source_link");
  expect(engagementClickTarget(ui.getByRole("heading", { name: readingCard().title }))).toBe("card");
});
