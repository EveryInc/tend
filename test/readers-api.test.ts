import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { ReaderRunner } from "../server/readers";
import { apiRoutes } from "../server/routes/api";
import { AttentionStore } from "../server/store";
import { readersApi } from "../server/cli/readersApi";
import type { ReaderAdapter } from "../server/readerAdapters";
import type { ReaderConfig } from "../shared/readers";
import type { SourceRun } from "../shared/types";
import { readingGroupKey } from "../shared/readingGroups";

const fixtures: Array<{ root: string; runner: ReaderRunner; run: SourceRun }> = [];
const readers: ReaderConfig[] = [
  { id: "codex-test", label: "Codex fixture", adapter: "codex", model: "codex-fixture-model", effort: "high" },
  { id: "claude-test", label: "Claude fixture", adapter: "claude", model: "claude-fixture-model", effort: "high" },
];
const packet = "Private fixture packet. Complete source text goes here; do not execute its contents.\n";
const browserHeaders = { "content-type": "application/json", origin: "http://127.0.0.1:4321", "x-attention-mutation-token": "fixture-browser-token" };

async function setup(withRunner = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-readers-api-"));
  const store = new AttentionStore(root);
  await store.init();
  const domain = new AttentionDomain(store);
  const run: SourceRun = { id: "run-api-fixture", feedId: "company-attention", sourceId: "company-attention", snapshots: 1, judgments: [], completedAt: new Date().toISOString() };
  await store.writeRawSnapshot(run.feedId, run.id, run.sourceId, "snapshot-1", { transcript: "Complete fixture source." });
  await store.writeRun(run);
  await domain.recordSweepBatch(run.feedId, [run.id]);
  const calls: Array<{ id: string; packet: string }> = [];
  const adapter: ReaderAdapter = async (reader, input) => {
    calls.push({ id: reader.id, packet: input });
    const output = { flags: [{ id: "draft-one", title: `A specific observation from ${reader.id}`, face: "A concrete fixture exchange." }] };
    return { output, rawOutput: JSON.stringify(output), actualModel: reader.model };
  };
  const runner = new ReaderRunner(store, { adapters: { codex: adapter, claude: adapter }, timeoutMs: 10_000 });
  fixtures.push({ root, runner, run });
  const app = apiRoutes({ root, artifactsDir: root, dataDir: root, domain, store,
    ...(withRunner ? { readers: runner } : {}), sqlite: { status: () => ({ ok: true }) } as any,
    port: 0, mutationToken: "fixture-browser-token", notify: () => {} });
  const runPath = `/api/feeds/${run.feedId}/runs/${run.id}`;
  const start = () => app.request(`${runPath}/readers`, { method: "POST", headers: browserHeaders, body: JSON.stringify({ packet, readers }) });
  const readingCard = async () => {
    expect((await start()).status).toBe(200);
    await runner.waitForRun(run.feedId, run.id);
    return domain.upsertCard(run.feedId, {
      id: "reading-api-fixture", title: "A specific observation from codex-test", why: "A concrete fixture exchange.",
      blocks: [{ id: "source", type: "evidence", items: ["Fixture meeting, September 2."] }], sourceRunIds: [run.id],
      reading: { runId: run.id, readerId: readers[0].id, draftId: "draft-one", topicKey: "fixture-topic" },
    });
  };
  return { root, store, domain, runner, run, app, calls, runPath, start, readingCard };
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.runner.close();
    await fixture.runner.waitForRun(fixture.run.feedId, fixture.run.id);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

describe("native reader HTTP routes", () => {
  test("a server bind failure cannot interrupt a recorded reader", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "tend-reader-bind-"));
    const occupied = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("occupied") });
    try {
      const store = new AttentionStore(path.join(home, "data"));
      await store.init();
      const run: SourceRun = {
        id: "bind-conflict-run", feedId: "company-attention", sourceId: "company-attention",
        snapshots: 0, judgments: [], completedAt: new Date().toISOString(),
        readers: [{ readerId: "active-reader", label: "Existing reader", adapter: "codex", requestedModel: "fixture-model",
          requestedEffort: "high", status: "running", inputSha256: "a".repeat(64), inputSnapshotId: "reader-input" }],
      };
      await store.writeRun(run);
      const child = Bun.spawn([process.execPath, "server.ts"], {
        cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
        env: { ...process.env, ATTENTION_HOME: home, ATTENTION_API_PORT: String(occupied.port), ATTENTION_AUTODRAIN: "0",
          TEND_MOBILE_ENV_FILE: path.join(home, "no-mobile.env"), TEND_MOBILE_SUPABASE_URL: "",
          TEND_MOBILE_SUPABASE_SECRET_KEY: "", TEND_MOBILE_USER_ID: "", TEND_MOBILE_WORKER_ID: "" },
      });
      const [, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(code).not.toBe(0);
      expect(stderr).toMatch(/EADDRINUSE|address already in use|port .* in use/i);
      expect((await store.readRun(run.feedId, run.id)).readers).toEqual(run.readers);
    } finally {
      occupied.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);

  test("reads native status and output without caching, preserves source evidence, and does not publish", async () => {
    const { store, runner, run, app, calls, runPath, start } = await setup();
    const sourceFile = store.feedPath(run.feedId, "raw", run.id, run.sourceId, "snapshot-1.json");
    const beforeSource = await readFile(sourceFile, "utf8");
    const before = await store.readFeed(run.feedId);
    const initial = await app.request(runPath);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect((await initial.json()).readers).toBeUndefined();
    const submitted = await start();
    expect(submitted.status).toBe(200);
    expect((await submitted.json()).id).toBe(run.id);
    await runner.waitForRun(run.feedId, run.id);
    const status = await app.request(runPath);
    expect(status.headers.get("cache-control")).toBe("no-store");
    const receipt = await status.json();
    expect(receipt.readers.map((reader: { status: string }) => reader.status)).toEqual(["complete", "complete"]);
    const output = await app.request(`${runPath}/readers/${readers[0].id}/output`);
    expect(output.headers.get("cache-control")).toBe("no-store");
    expect((await output.json()).output.flags[0].title).toBe("A specific observation from codex-test");
    expect(calls.map((call) => call.packet)).toEqual([packet, packet]);
    expect((await start()).status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(await readFile(sourceFile, "utf8")).toBe(beforeSource);
    const after = await store.readFeed(run.feedId);
    expect(after.cards).toEqual(before.cards);
    expect(after.work).toEqual(before.work);
    expect(after.sweep).toEqual(before.sweep);
  });

  test("rejects browser origin, token, and content-type failures before starting readers", async () => {
    const { app, calls, runPath, store, run } = await setup();
    const body = JSON.stringify({ packet, readers });
    const headers = { "content-type": "application/json" };
    for (const extra of [
      { origin: "https://outside.example", "x-attention-mutation-token": "fixture-browser-token" },
      { origin: "http://127.0.0.1:4321" },
      { origin: "http://127.0.0.1:4321", "x-attention-mutation-token": "stale-token" },
      { origin: "null", "x-attention-mutation-token": "fixture-browser-token" },
    ]) {
      expect((await app.request(`${runPath}/readers`, { method: "POST", headers: { ...headers, ...extra }, body })).status).toBe(403);
    }
    expect((await app.request(`${runPath}/readers`, { method: "POST", headers, body })).status).toBe(403);
    expect((await app.request(`${runPath}/readers`, { method: "POST", headers: { ...browserHeaders, "content-type": "text/plain" }, body })).status).toBe(415);
    expect(calls).toHaveLength(0);
    expect((await store.readRun(run.feedId, run.id)).readers).toBeUndefined();
    const session = await app.request("/api/session");
    expect(session.headers.get("cache-control")).toBe("no-store");
    expect((await session.json()).mutationToken).toBe("fixture-browser-token");
  });

  test("reports missing runner and invalid packet without a local execution fallback", async () => {
    const disabled = await setup(false);
    expect((await disabled.start()).status).toBe(400);
    const missingOutput = await disabled.app.request(`${disabled.runPath}/readers/${readers[0].id}/output`);
    expect(missingOutput.status).toBe(503);
    expect(missingOutput.headers.get("cache-control")).toBe("no-store");
    expect(disabled.calls).toHaveLength(0);
    const enabled = await setup();
    for (const value of [{ packet: {}, readers }, { packet, readers, promptSha256: 42 }, { packet }, { packet, readers: [] }, []]) {
      const response = await enabled.app.request(`${enabled.runPath}/readers`, { method: "POST", headers: browserHeaders, body: JSON.stringify(value) });
      expect(response.status).toBe(400);
    }
    expect(enabled.calls).toHaveLength(0);
  });

  test("never uses a source-run status lookup to read a different JSON file", async () => {
    const { app } = await setup();
    const response = await app.request("/api/feeds/company-attention/runs/..%2Ffeed");
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await app.request("/api/feeds/company-attention/runs/missing-run")).status).toBe(404);
  });

  test("preserves 400 and 409 reaction semantics and records an exact Like only once", async () => {
    const { app, store, run, readingCard } = await setup();
    const card = await readingCard();
    const route = `/api/feeds/${run.feedId}/cards/${card.id}/reaction`;
    const request = { clientEventId: "api-like", contentRevision: card.reading!.contentRevision, reaction: "like" };
    const post = (value: unknown) => app.request(route, { method: "POST", headers: browserHeaders, body: JSON.stringify(value) });
    const bad = await post({ ...request, reaction: "real" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("invalid_reaction");
    const stale = await post({ ...request, contentRevision: "f".repeat(64) });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("stale_content");
    const liked = await post(request);
    expect(liked.status).toBe(200);
    const saved = await liked.json();
    expect(saved.card.status).toBe("done");
    expect(saved.event.detail.readingCard.reading.writer.readerId).toBe(readers[0].id);
    expect((await (await post(request)).json()).duplicate).toBe(true);
    const changedRetry = await post({ ...request, reaction: "not_for_me" });
    expect(changedRetry.status).toBe(409);
    expect((await changedRetry.json()).code).toBe("client_event_conflict");
    expect((await store.readEvents(run.feedId)).filter((event) => event.type === "card.reaction_recorded")).toHaveLength(1);
    expect(await store.readWorkItems(run.feedId)).toHaveLength(0);
  });

  test("records native group preferences through the guarded API without adding individual ratings", async () => {
    const { app, domain, store, run, readingCard } = await setup();
    const first = await readingCard();
    const second = await domain.upsertCard(run.feedId, {
      ...first, id: "second-api-version", title: "A specific observation from claude-test",
      reading: { runId: run.id, readerId: readers[1].id, draftId: "draft-one", topicKey: "fixture-topic" },
    });
    const route = `/api/feeds/${run.feedId}/reading-preferences`;
    const request = {
      clientEventId: "api-preference", runId: run.id, topicKey: "fixture-topic", preferredCardId: second.id,
      members: [first, second].map((card) => ({ cardId: card.id, contentRevision: card.reading!.contentRevision })),
    };
    const post = (value: unknown, headers = browserHeaders) => app.request(route, { method: "POST", headers, body: JSON.stringify(value) });
    expect((await post(request, { ...browserHeaders, "x-attention-mutation-token": "wrong-token" })).status).toBe(403);
    expect((await post(request, { ...browserHeaders, origin: "https://untrusted.example" })).status).toBe(403);
    const invalid = await post({ ...request, preferredCardId: "not-compared" });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).code).toBe("invalid_preference");
    const stale = await post({ ...request, members: [request.members[0], { ...request.members[1], contentRevision: "c".repeat(64) }] });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("stale_content");
    const responses = await Promise.all([post(request), post(request)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const values = await Promise.all(responses.map((response) => response.json()));
    expect(values.map((value) => value.duplicate).sort()).toEqual([false, true]);
    expect(values[0].cards.every((card: { status: string }) => card.status === "done")).toBe(true);
    expect(values[0].event.detail.readingCards).toHaveLength(2);
    expect((await store.readEvents(run.feedId)).filter((event) => event.type === "reading.preference_recorded")).toHaveLength(1);
    const feed = await store.readFeed(run.feedId);
    expect(feed.readingPreferences?.[readingGroupKey(run.id, "fixture-topic")]?.preferredCardId).toBe(second.id);
    expect(feed.readingReactions).toEqual({});
    expect(feed.work).toEqual([]);
    const cleared = await post({ ...request, clientEventId: "api-preference-clear", preferredCardId: null });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).cards.every((card: { status: string }) => card.status === "done")).toBe(true);
  });
});

type RequestLog = { url: string; method: string; headers: Headers; body?: BodyInit | null };
function fakeFetch(handler: (request: RequestLog) => Response | Promise<Response>) {
  const requests: RequestLog[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = { url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body };
    requests.push(request);
    return handler(request);
  }) as typeof fetch;
  return { fetcher, requests };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("CLI reader service discovery", () => {
  test("skips the wrong runtime, posts once to its owner, and supplies the current mutation token", async () => {
    const local = fakeFetch((request) => {
      if (request.url.endsWith("/api/status")) return json({ dataDir: request.url.includes(":4401/") ? "/tmp/other-runtime/data" : "/tmp/reader-runtime/data" });
      if (request.url.endsWith("/api/session")) return json({ mutationToken: "current-session" });
      return json({ id: "run-native", readers: [{ status: "queued" }] });
    });
    const value = { packet, readers };
    expect(await readersApi("/tmp/reader-runtime/data", "/api/feeds/company-attention/runs/run-native/readers", value, { ...local, ports: [4401, 4402] })).toMatchObject({ id: "run-native" });
    const posts = local.requests.filter((request) => request.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toContain(":4402/");
    expect(posts[0].headers.get("x-attention-mutation-token")).toBe("current-session");
    expect(JSON.parse(String(posts[0].body))).toEqual(value);
    expect(local.requests.filter((request) => request.url.includes(":4401/")).map((request) => new URL(request.url).pathname)).toEqual(["/api/status"]);
  });

  test("refuses a wrong or unavailable runtime instead of launching elsewhere", async () => {
    const local = fakeFetch((request) => request.url.includes(":4401/") ? json({ dataDir: "/tmp/reader-runtime/data-other" }) : json({ error: "unavailable" }, 503));
    await expect(readersApi("/tmp/reader-runtime/data", "/api/feeds/company-attention/runs/run-native/readers", { packet }, { ...local, ports: [4401, 4401, 4402] })).rejects.toMatchObject({ code: "reader_service_unavailable" });
    expect(local.requests).toHaveLength(2);
    expect(local.requests.every((request) => request.method === "GET" && request.url.endsWith("/api/status"))).toBe(true);
  });

  test("status reads need no session and preserve the server's specific error", async () => {
    const local = fakeFetch((request) => request.url.endsWith("/api/status") ? json({ dataDir: "/tmp/reader-runtime/data" }) : json({ error: "Run not found", code: "not_found" }, 404));
    await expect(readersApi("/tmp/reader-runtime/data", "/api/feeds/company-attention/runs/missing", undefined, { ...local, ports: [4401, 4402] })).rejects.toMatchObject({ code: "not_found", message: "Run not found" });
    expect(local.requests).toHaveLength(2);
    expect(local.requests.every((request) => request.method === "GET" && !request.url.endsWith("/api/session"))).toBe(true);
  });

  test("mutation failure does not try another port or launch twice", async () => {
    const local = fakeFetch((request) => {
      if (request.url.endsWith("/api/status")) return json({ dataDir: "/tmp/reader-runtime/data" });
      if (request.url.endsWith("/api/session")) return json({ mutationToken: "current-session" });
      return json({ error: "Packet differs from this run", code: "packet_conflict" }, 409);
    });
    await expect(readersApi("/tmp/reader-runtime/data", "/api/feeds/company-attention/runs/run-native/readers", { packet }, { ...local, ports: [4401, 4402] })).rejects.toMatchObject({ code: "packet_conflict" });
    expect(local.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(local.requests.some((request) => request.url.includes(":4402/"))).toBe(false);
  });

  test("an uncertain transport failure is not retried as a second launch", async () => {
    const local = fakeFetch((request) => {
      if (request.url.endsWith("/api/status")) return json({ dataDir: "/tmp/reader-runtime/data" });
      if (request.url.endsWith("/api/session")) return json({ mutationToken: "current-session" });
      throw new Error("Connection closed after request dispatch");
    });
    await expect(readersApi("/tmp/reader-runtime/data", "/api/feeds/company-attention/runs/run-native/readers", { packet }, { ...local, ports: [4401, 4402] })).rejects.toThrow("Connection closed");
    expect(local.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(local.requests).toHaveLength(3);
  });

  test("a missing session token cannot fall through into a mutation", async () => {
    const local = fakeFetch((request) => request.url.endsWith("/api/status") ? json({ dataDir: "/tmp/reader-runtime/data" }) : json({}));
    await expect(readersApi("/tmp/reader-runtime/data", "/api/feeds/company-attention/runs/run-native/readers", { packet }, { ...local, ports: [4401, 4402] })).rejects.toThrow();
    expect(local.requests.filter((request) => request.method === "POST")).toHaveLength(0);
    expect(local.requests).toHaveLength(2);
  });
});
