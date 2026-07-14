import assert from "node:assert/strict";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import App from "../../src/App";
import type { Card, FeedView, WorkspaceView } from "../../shared/types";

GlobalRegistrator.register();

class StubEventSource {
  onerror: ((event: Event) => void) | null = null;
  addEventListener() {}
  close() {}
}

Object.assign(globalThis, { EventSource: StubEventSource });

function workspace(): WorkspaceView {
  const card: Card = {
    id: "cleanup-card",
    feedId: "inbox",
    kind: "attention",
    status: "to_review_new",
    title: "Routine notice",
    eyebrow: "Inbox",
    why: "This card can be dismissed locally or archived at the source.",
    blocks: [],
    proposedAction: { label: "Archive", instruction: "Archive the source thread." },
    readyForPass: 1,
    createdAt: "2026-07-13T12:00:00.000Z",
    updatedAt: "2026-07-13T12:00:00.000Z",
    history: [],
  };
  const active: FeedView = {
    config: {
      id: "inbox",
      name: "Inbox",
      purpose: "Review inbox attention.",
      defaultCleanup: "Archive the source thread.",
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
    cards: [card],
    runs: [],
    routineActions: [],
    work: [],
    sweep: { currentBatchId: null, lastFeedbackId: null, recollectionOffered: false, statusMessage: null },
    drain: { status: "idle", consecutiveFailures: 0 },
    readyNextPass: 0,
  };
  return {
    feeds: [{ id: "inbox", name: "Inbox", purpose: "Review inbox attention." }],
    active,
    agents: { claude: { liveness: "offline", lastSeenAt: null } },
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
  };
}

async function run() {
  const requests: string[] = [];
  let failNextCleanupUndo = true;
  const state = workspace();
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") requests.push(url);
    if (url === "/api/session") return Response.json({ mutationToken: "test-token" });
    if (url === "/api/state?feed=inbox") return Response.json(state);
    if (url.endsWith("/actions/dismiss-card")) return Response.json({ id: "dismissed-card" });
    if (url.endsWith("/actions/default-cleanup")) return Response.json({ id: "cleanup-work" });
    if (url.endsWith("/undo-cleanup-source") && failNextCleanupUndo) {
      failNextCleanupUndo = false;
      return Response.json({ error: "Temporary cleanup undo failure" }, { status: 503 });
    }
    if (url.endsWith("/return-to-review") || url.endsWith("/undo-cleanup-source")) return Response.json({ ok: true });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <App feedId="inbox" screen="feed" workspaceTab="feed" />,
  });
  const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);

  fireEvent.click(await view.findByRole("button", { name: "Dismiss card" }));
  await waitFor(() => assert(requests.includes("/api/feeds/inbox/cards/cleanup-card/actions/dismiss-card")));
  fireEvent.click(view.getByRole("button", { name: "Archive" }));
  await waitFor(() => assert(requests.includes("/api/feeds/inbox/cards/cleanup-card/actions/default-cleanup")));
  assert.equal((await view.findAllByRole("button", { name: "Undo" })).length, 1);
  fireEvent.click(view.getByRole("button", { name: "Undo" }));
  await view.findByText("Temporary cleanup undo failure");
  assert(view.getByRole("button", { name: "Undo" }));
  fireEvent.click(view.getByRole("button", { name: "Undo" }));
  await waitFor(() => assert.equal(requests.filter((url) => url.endsWith("/undo-cleanup-source")).length, 2));
  assert(!requests.includes("/api/feeds/inbox/cards/cleanup-card/return-to-review"));

  fireEvent.click(view.getByRole("button", { name: "Dismiss card" }));
  fireEvent.click(await view.findByRole("button", { name: "Undo" }));
  await waitFor(() => assert(requests.includes("/api/feeds/inbox/cards/cleanup-card/return-to-review")));
}

try {
  await run();
  cleanup();
  GlobalRegistrator.unregister();
  process.exit(0);
} catch (error) {
  cleanup();
  GlobalRegistrator.unregister();
  throw error;
}
