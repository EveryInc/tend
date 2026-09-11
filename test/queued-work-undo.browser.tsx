import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import App from "../src/App";
import type { Card, FeedView, WorkspaceView } from "../shared/types";

GlobalRegistrator.register();
class StubEventSource {
  onerror: ((event: Event) => void) | null = null;
  addEventListener() {}
  close() {}
}
Object.assign(globalThis, { EventSource: StubEventSource });
afterEach(() => cleanup());

function workspace(): WorkspaceView {
  const card: Card = {
    id: "queue-card", feedId: "inbox", kind: "attention", status: "to_review_new",
    title: "Queue this work", eyebrow: "Inbox", why: "The undo request will fail once.", blocks: [],
    actions: [{ id: "research", label: "Research", behavior: "queue_instruction", instruction: "Research this.", variant: "primary" }],
    readyForPass: 1, createdAt: "2026-09-08T12:00:00.000Z", updatedAt: "2026-09-08T12:00:00.000Z", history: [],
  };
  const active: FeedView = {
    config: { id: "inbox", name: "Inbox", purpose: "Fixture", defaultCleanup: "Archive", currentPass: 1,
      createdAt: "2026-09-08T12:00:00.000Z", updatedAt: "2026-09-08T12:00:00.000Z" },
    thread: { homeThreadId: "thread-codex", boundAt: "2026-09-08T12:00:00.000Z",
      heartbeat: { status: "not_proposed", cadence: null, automationId: null } },
    sources: [], policy: "", cards: [card], runs: [], routineActions: [], work: [],
    sweep: { currentBatchId: null, lastFeedbackId: null, recollectionOffered: false, statusMessage: null },
    drain: { status: "idle", consecutiveFailures: 0 }, readyNextPass: 0,
  };
  return {
    feeds: [{ id: "inbox", name: "Inbox", purpose: "Fixture" }], active,
    agents: { claude: { liveness: "offline", lastSeenAt: null } },
    dictation: { provider: null, status: "not_checked", activationCode: "AltRight", activationLabel: "Right Option",
      source: "fallback", detectedAt: null, note: "" }, proposals: [],
  };
}

test("failed queued work undo keeps the retry affordance", async () => {
  const requests: string[] = [];
  const state = workspace();
  let cancelAttempts = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") requests.push(url);
    if (url === "/api/session") return Response.json({ mutationToken: "test-token" });
    if (url === "/api/state?feed=inbox") return Response.json(state);
    if (url.endsWith("/actions/research")) return Response.json({ id: "work-1" });
    if (url.endsWith("/work/work-1/cancel")) {
      if (++cancelAttempts === 1) {
        await Bun.sleep(5_100);
        return Response.json({ error: "Temporary cancel failure" }, { status: 503 });
      }
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const rootRoute = createRootRoute();
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/",
    component: () => <App feedId="inbox" screen="feed" workspaceTab="feed" /> });
  const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);

  fireEvent.click(await view.findByRole("button", { name: "Research" }));
  await waitFor(() => expect(requests).toContain("/api/feeds/inbox/cards/queue-card/actions/research"));
  fireEvent.click(await view.findByRole("button", { name: "Undo" }));
  await view.findByText("Temporary cancel failure", {}, { timeout: 8_000 });
  fireEvent.click(view.getByRole("button", { name: "Undo" }));
  await view.findByText("Instruction cancelled");
  await waitFor(() => expect(view.queryByRole("button", { name: "Undo" })).toBeNull());
  expect(cancelAttempts).toBe(2);
}, 10_000);
