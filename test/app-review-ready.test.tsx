import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import App from "../src/App";
import type { FeedView, WorkspaceView } from "../shared/types";

class StubEventSource {
  onerror: ((event: Event) => void) | null = null;
  addEventListener() {}
  close() {}
}

let scrollCalls = 0;

beforeAll(() => {
  GlobalRegistrator.register();
  Object.assign(globalThis, { EventSource: StubEventSource });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => { scrollCalls += 1; },
  });
});

afterEach(() => {
  cleanup();
  scrollCalls = 0;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function workspace(readyNextPass: number, currentPass: number): WorkspaceView {
  const active: FeedView = {
    config: {
      id: "inbox",
      name: "Inbox",
      purpose: "Review inbox attention.",
      defaultCleanup: "Archive the source thread.",
      currentPass,
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
    cards: [],
    runs: [],
    routineActions: [],
    work: [],
    sweep: { currentBatchId: null, lastFeedbackId: null, recollectionOffered: false, statusMessage: null },
    drain: { status: "idle", consecutiveFailures: 0 },
    readyNextPass,
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

function renderFeedApp() {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <App feedId="inbox" screen="feed" workspaceTab="feed" />,
  });
  const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

test("App starts one next pass, announces pending state, and focuses the revealed pass", async () => {
  let state = workspace(2, 1);
  let nextPassCalls = 0;
  const deferred = deferredResponse();
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/session") return Response.json({ mutationToken: "test-token" });
    if (url === "/api/state?feed=inbox") return Response.json(state);
    if (url === "/api/feeds/inbox/next-pass" && init?.method === "POST") {
      nextPassCalls += 1;
      return deferred.promise;
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = renderFeedApp();
  const button = await view.findByRole("button", { name: "Review ready cards, 2 ready" }) as HTMLButtonElement;
  expect(view.getAllByRole("button", { name: /Review ready cards/ })).toHaveLength(1);
  expect(document.querySelector("main.page")?.classList.contains("has-floating-action")).toBe(true);

  fireEvent.click(button);
  await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(nextPassCalls).toBe(1);

  state = workspace(0, 2);
  deferred.resolve(Response.json({ currentPass: 2 }));
  await view.findByText("Started the next pass");
  await waitFor(() => expect(view.queryByRole("button", { name: /Review ready cards/ })).toBeNull());
  await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Start of review pass"));
  expect(document.querySelector("main.page")?.classList.contains("has-floating-action")).toBe(false);
  expect(scrollCalls).toBe(1);
});

test("App scrolls to the revealed pass without stealing focus from the Dock editor", async () => {
  let state = workspace(1, 1);
  const deferred = deferredResponse();
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/session") return Response.json({ mutationToken: "test-token" });
    if (url === "/api/state?feed=inbox") return Response.json(state);
    if (url === "/api/feeds/inbox/next-pass" && init?.method === "POST") return deferred.promise;
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = renderFeedApp();
  fireEvent.click(await view.findByRole("button", { name: "Review ready cards, 1 ready" }));
  const editor = view.getByRole("textbox", { name: "Instruction for Codex" }) as HTMLTextAreaElement;
  editor.focus();
  expect(document.activeElement).toBe(editor);

  state = workspace(0, 2);
  deferred.resolve(Response.json({ currentPass: 2 }));
  await view.findByText("Started the next pass");
  await waitFor(() => expect(document.activeElement).toBe(editor));
  expect(scrollCalls).toBe(1);
});

test("App preserves a failed next pass for an explicit retry", async () => {
  let state = workspace(3, 1);
  let nextPassCalls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/session") return Response.json({ mutationToken: "test-token" });
    if (url === "/api/state?feed=inbox") return Response.json(state);
    if (url === "/api/feeds/inbox/next-pass" && init?.method === "POST") {
      nextPassCalls += 1;
      if (nextPassCalls === 1) return Response.json({ error: "Temporary next-pass failure" }, { status: 503 });
      state = workspace(0, 2);
      return Response.json({ currentPass: 2 });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = renderFeedApp();
  fireEvent.click(await view.findByRole("button", { name: "Review ready cards, 3 ready" }));
  await view.findByText("Temporary next-pass failure");
  const retry = view.getByRole("button", { name: "Review ready cards, 3 ready" }) as HTMLButtonElement;
  await waitFor(() => expect(retry.disabled).toBe(false));

  fireEvent.click(retry);
  await view.findByText("Started the next pass");
  await waitFor(() => expect(view.queryByRole("button", { name: /Review ready cards/ })).toBeNull());
  expect(nextPassCalls).toBe(2);
});
