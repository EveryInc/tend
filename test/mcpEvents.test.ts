import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { createLocalRuntime } from "../server/runtime";
import { AttentionDomain } from "../server/domain";
import { TendMcpEvents, WORK_READY } from "../server/mcpEvents";
import { callbackUrl, publicIPv4, signingKey, pinnedLookup } from "../server/mcpWebhook";
import { request as httpsRequest } from "node:https";
import { apiRoutes } from "../server/routes/api";
import { mcpRoutes } from "../server/routes/mcp";
import { DrainDispatcher } from "../server/dispatcher";

const roots: string[] = [];
const closers: (() => void)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const subscription = (thread = "test-thread") => ({ name: WORK_READY, arguments: { feed_id: "inbox", thread_id: thread }, delivery: { mode: "webhook", url: "https://callback.example/events", secret }, cursor: null });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-events-")); roots.push(root);
  const runtime = await createLocalRuntime(path.join(root, "data"), path.join(root, "attention.db")); closers.push(() => runtime.sqlite.close());
  let now = Date.now(), status = 204;
  const deliveries: { headers: Record<string, string>; body: string }[] = [];
  const events = new TendMcpEvents(runtime.sqlite.mcpEvents(), runtime.store, async (_url, headers, body) => {
    const payload = JSON.parse(body);
    const signature = createHmac("sha256", signingKey(secret)).update(`${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${body}`).digest("base64");
    expect(headers["webhook-signature"].split(" ")).toContain(`v1,${signature}`);
    if (payload.type === "verification") return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
    deliveries.push({ headers, body }); return { status, body: "" };
  }, () => now);
  const domain = new AttentionDomain(runtime.store, path.join(root, "output"), work => events.enqueue(work));
  await domain.bindFeed("inbox", "test-thread");
  const app = new Hono();
  app.route("/", apiRoutes({ ...runtime, root, artifactsDir: path.join(root, "output"), domain, port: 4332, mutationToken: "test-ui-session", notify: () => {}, mcpEvents: events }));
  app.route("/", mcpRoutes({ store: runtime.store, domain, events, token: () => "test-mcp-session", notify: () => {} }));
  const rpc = async (method: string, params: unknown = {}, token = "test-mcp-session") => {
    const response = await app.request("/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return { status: response.status, ...(await response.json()) } as any;
  };
  const input = async (instruction = "Harmless event test", authenticated = true) => (await app.request("/api/feeds/inbox/instructions", { method: "POST", headers: { "content-type": "application/json", ...(authenticated ? { "x-attention-mutation-token": "test-ui-session" } : {}) }, body: JSON.stringify({ instruction }) })).json() as Promise<any>;
  return { ...runtime, root, domain, events, app, rpc, input, deliveries, advance: (ms: number) => { now += ms; }, setStatus: (value: number) => { status = value; } };
}

test("authenticated discovery, actual input route, signed delivery, exact claim, response visible in original state, duplicate replay", async () => {
  const t = await setup();
  expect((await t.rpc("server/discover")).result.capabilities.events).toEqual({});
  expect((await t.rpc("events/list")).result.events[0].name).toBe(WORK_READY);
  expect((await t.rpc("events/list", {}, "wrong")).status).toBe(401);
  const first = await t.rpc("events/subscribe", subscription());
  expect(first.result.id).toBe((await t.rpc("events/subscribe", subscription())).result.id);
  const work = await t.input(); await t.events.poll();
  expect(t.deliveries).toHaveLength(1);
  const event = JSON.parse(t.deliveries[0].body);
  expect(event.data).toEqual({ feed_id: "inbox", thread_id: "test-thread", work_id: work.id, work_revision: work.updatedAt });
  expect(t.deliveries[0].body).not.toContain("Harmless event test");
  const args = { ...event.data, event_id: event.eventId };
  const claim = await t.rpc("tools/call", { name: "tend_work_claim", arguments: args });
  expect(claim.error).toBeUndefined();
  const output = JSON.parse(claim.result.content[0].text);
  expect(output.work.instruction).toBe("Harmless event test");
  expect(output.work.status).toBe("working");
  const repeated = await t.rpc("tools/call", { name: "tend_work_claim", arguments: args });
  expect(JSON.parse(repeated.result.content[0].text).work.capabilityToken).toBe(output.work.capabilityToken);
  const response = { name: "tend_work_respond", arguments: { ...args, capability_token: output.work.capabilityToken, response: "Received harmless event test." } };
  expect((await t.rpc("tools/call", response)).error).toBeUndefined();
  const state = await (await t.app.request("/api/state?feed=inbox")).json() as any;
  expect(state.active.work.find((item: any) => item.id === work.id).response).toBe("Received harmless event test.");
  expect((await t.rpc("tools/call", response)).error).toBeUndefined();
  expect((await t.store.readEvents("inbox")).filter(item => item.type === "work.completed")).toHaveLength(1);
  expect(JSON.stringify(await t.rpc("tools/call", { name: "tend_work_claim", arguments: args }))).not.toContain(output.work.capabilityToken);
});

test("model queue writes and other threads cannot publish or claim", async () => {
  const t = await setup(); await t.events.subscribe(subscription());
  expect((await t.rpc("events/subscribe", subscription("other-thread"))).error.code).toBe(-32012);
  await t.input("CLI-created work", false); await t.domain.queueFeedInstruction("inbox", "Model-created work");
  await t.events.poll(); expect(t.deliveries).toHaveLength(0);
  const work = await t.input(); await t.events.poll(); const event = JSON.parse(t.deliveries[0].body);
  expect((await t.rpc("tools/call", { name: "tend_work_claim", arguments: { ...event.data, event_id: event.eventId, work_id: "another-work" } })).error.code).toBe(-32012);
  expect((await t.store.readWork("inbox", work.id)).status).toBe("queued");
});

test("transient failure and restart preserve event ID and bytes with fresh signature timestamp", async () => {
  const t = await setup(); await t.events.subscribe(subscription()); await t.input(); t.setStatus(503); await t.events.poll();
  t.advance(5000); t.setStatus(204);
  t.sqlite.close();
  const reopened = await createLocalRuntime(path.join(t.root, "data"), path.join(t.root, "attention.db")); closers.push(() => reopened.sqlite.close());
  const restarted = new TendMcpEvents(reopened.sqlite.mcpEvents(), reopened.store, async (_url, headers, body) => { t.deliveries.push({ headers, body }); return { status: 204, body: "" }; }, () => Date.now() + 6000);
  await restarted.poll(); expect(t.deliveries).toHaveLength(2);
  expect(t.deliveries[0].body).toBe(t.deliveries[1].body);
  expect(t.deliveries[0].headers["webhook-id"]).toBe(t.deliveries[1].headers["webhook-id"]);
  expect(t.deliveries[0].headers["webhook-timestamp"]).not.toBe(t.deliveries[1].headers["webhook-timestamp"]);
  expect(restarted.repository.deliveries()[0].status).toBe("accepted");
});

test("cancel, rebinding, expiry and revocation stop delivery", async () => {
  for (const action of ["cancel", "rebind", "expire", "unsubscribe"]) {
    const t = await setup(); await t.events.subscribe(subscription()); const work = await t.input();
    if (action === "cancel") await t.domain.cancelQueuedWork("inbox", work.id);
    if (action === "rebind") await t.domain.bindFeed("inbox", "new-thread");
    if (action === "expire") t.advance(86_400_001);
    if (action === "unsubscribe") { await t.events.unsubscribe(subscription()); await t.events.unsubscribe(subscription()); }
    await t.events.poll(); expect(t.deliveries).toHaveLength(0); expect(t.events.repository.deliveries()[0].status).toBe("stopped");
  }
});

test("permanent 410/413 responses do not retry; 410 revokes subscription", async () => {
  for (const status of [410, 413]) { const t = await setup(); await t.events.subscribe(subscription()); await t.input(); t.setStatus(status); await t.events.poll(); t.advance(600_000); await t.events.poll(); expect(t.deliveries).toHaveLength(1); expect(await t.events.active("inbox")).toBe(status !== 410); }
});

test("callback guard and canonical signing secret reject local destinations and malformed keys", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.20.0.2", "192.168.1.1", "100.64.0.1", "::1", "198.51.100.1"]) expect(publicIPv4(address)).toBe(false);
  expect(publicIPv4("8.8.8.8")).toBe(true);
  for (const url of ["http://callback.example/", "https://127.0.0.1/", "https://user:password@callback.example/", "https://callback.example:8443/"]) expect(() => callbackUrl(url)).toThrow();
  expect(() => signingKey("whsec_c2hvcnQ=")).toThrow();
});

test("failed verification leaves no subscription; unsubscribe fences verification in flight", async () => {
  const t = await setup();
  const invalid = new TendMcpEvents(t.sqlite.mcpEvents(), t.store, async () => ({ status: 200, body: JSON.stringify({ challenge: "wrong" }) }));
  await expect(invalid.subscribe(subscription())).rejects.toThrow("Callback verification failed"); expect(await invalid.active("inbox")).toBe(false);
  let finish!: (value: any) => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const pending = new TendMcpEvents(t.sqlite.mcpEvents(), t.store, async (_url, _headers, body) => { entered(); return new Promise(resolve => { finish = () => resolve({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }); }); });
  const subscribing = pending.subscribe(subscription()); await waiting; await pending.unsubscribe(subscription()); finish(null);
  await expect(subscribing).rejects.toThrow("Subscription changed"); expect(await pending.active("inbox")).toBe(false);
});

test("work and publication roll back together if queue commit fails", async () => {
  const t = await setup(); await t.events.subscribe(subscription());
  const failing = new AttentionDomain(t.store, path.join(t.root, "output"), async work => { await t.events.enqueue(work); throw new Error("Simulated failed queue commit"); });
  await expect(t.events.userInput(() => failing.queueFeedInstruction("inbox", "Must roll back"))).rejects.toThrow("failed queue commit");
  expect(await t.store.readWorkItems("inbox")).toHaveLength(0);
  expect(t.events.repository.deliveries()).toHaveLength(0);
});

test("accepted event becomes stale after queued work changes", async () => {
  const t = await setup(); await t.events.subscribe(subscription()); const work = await t.input(); await t.events.poll();
  const event = JSON.parse(t.deliveries[0].body);
  work.updatedAt = "2099-01-01T00:00:00.000Z";
  // Repository write simulates an independently committed edit without relying on millisecond clock resolution.
  await t.sqlite.workItems().write(work);
  expect((await t.rpc("tools/call", { name: "tend_work_claim", arguments: { ...event.data, event_id: event.eventId } })).error.code).toBe(-32012);
});

test("MCP browser origins and disabled endpoint cannot use owner tools", async () => {
  const t = await setup();
  const response = await t.app.request("/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-mcp-session", origin: "http://localhost:4332" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events/list" }) });
  expect(response.status).toBe(401);
  const disabled = mcpRoutes({ domain: t.domain, store: t.store, events: t.events, token: () => "", notify: () => {} });
  expect((await disabled.request("/mcp", { method: "POST" })).status).toBe(401);
});

test("subscription refresh rotates secrets with a bounded dual-signing window", async () => {
  const t = await setup(); await t.events.subscribe(subscription());
  const next = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
  const rotated = { ...subscription(), delivery: { ...subscription().delivery, secret: next } };
  const service = new TendMcpEvents(t.sqlite.mcpEvents(), t.store, async (_url, headers, body) => {
    const payload = JSON.parse(body);
    if (payload.type === "verification") return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
    expect(headers["webhook-signature"].split(" ")).toHaveLength(2);
    for (const key of [secret, next]) expect(headers["webhook-signature"]).toContain(createHmac("sha256", signingKey(key)).update(`${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${body}`).digest("base64"));
    return { status: 204, body: "" };
  });
  const id = (await service.subscribe(rotated)).id; expect(t.events.repository.subscriptions()[0].id).toBe(id);
  await t.input(); await service.poll(); expect(service.repository.deliveries()[0].status).toBe("accepted");
});

test("backup export preserves user work while removing delivery secrets and grants", async () => {
  const t = await setup(); await t.events.subscribe(subscription()); const work = await t.input();
  const backupPath = path.join(t.root, "backup.db"); await t.sqlite.backupTo(backupPath);
  const backup = new Database(backupPath);
  try {
    expect(backup.query("SELECT name FROM sqlite_master WHERE name LIKE 'mcp_event_%'").all()).toHaveLength(0);
    expect(backup.query("SELECT id FROM work_items WHERE id=?").get(work.id)).toEqual({ id: work.id });
    expect(await t.events.active("inbox")).toBe(true);
  } finally { backup.close(); }
});

test("legacy auto-drain tick cannot dispatch unclaimed event work after its age threshold", async () => {
  const t = await setup(); await t.events.subscribe(subscription()); const work = await t.input();
  work.createdAt = new Date(Date.now() - 120_000).toISOString(); await t.sqlite.workItems().write(work);
  let runs = 0;
  const dispatcher = new DrainDispatcher(t.store, { appRoot: t.root, runtimeRoot: t.root, codexAvailable: () => true,
    eventsActive: feed => t.events.active(feed), runDrain: async () => { runs++; return 0; } });
  await dispatcher.tick(); expect(runs).toBe(0);
  expect((await t.store.readWork("inbox", work.id)).status).toBe("queued");
  await t.events.unsubscribe(subscription()); await dispatcher.tick(); expect(runs).toBe(1);
  for (let attempt = 0; attempt < 100 && !(await t.store.readEvents("inbox")).some(event => event.type === "drain.completed"); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect((await t.store.readEvents("inbox")).some(event => event.type === "drain.completed")).toBe(true);
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("unsubscribe fences subscribe during initial and final awaited authorization", async () => {
  for (const window of [1, 2]) {
    const t = await setup(), entered = gate(), resume = gate();
    let calls = 0;
    const authorize = t.events.authorized.bind(t.events);
    t.events.authorized = async (feed, thread) => {
      if (++calls === window) { entered.release(); await resume.promise; }
      return authorize(feed, thread);
    };
    const subscribing = t.events.subscribe(subscription()).then(() => "saved", () => "revoked");
    await entered.promise;
    const revoking = t.events.unsubscribe(subscription());
    resume.release(); await revoking;
    expect(await subscribing).toBe("revoked");
    expect(t.events.repository.subscriptions()).toHaveLength(0);
  }
});

test("successful unsubscribe cannot roll back with an unrelated UI transaction", async () => {
  const t = await setup(); await t.events.subscribe(subscription());
  const entered = gate(), resume = gate();
  const transaction = t.store.serializeAtomic(async () => { entered.release(); await resume.promise; throw new Error("Intentional UI rollback"); }).catch(() => {});
  await entered.promise;
  const revoking = t.events.unsubscribe(subscription());
  // Let the old implementation finish its uncoordinated SQLite write inside the open transaction.
  await new Promise(resolve => setTimeout(resolve, 10));
  resume.release(); await transaction; await revoking;
  expect(t.events.repository.subscriptions()).toHaveLength(0);
});

test("successful callback settlement cannot roll back with an unrelated UI transaction", async () => {
  const t = await setup(); await t.events.subscribe(subscription()); await t.input();
  const networkEntered = gate(), receipt = gate();
  const service = new TendMcpEvents(t.sqlite.mcpEvents(), t.store, async () => { networkEntered.release(); await receipt.promise; return { status: 204, body: "" }; });
  const publishing = service.poll(); await networkEntered.promise;
  const entered = gate(), resume = gate();
  const transaction = t.store.serializeAtomic(async () => { entered.release(); await resume.promise; throw new Error("Intentional UI rollback"); }).catch(() => {});
  await entered.promise; receipt.release(); await new Promise(resolve => setTimeout(resolve, 10));
  resume.release(); await transaction; await publishing;
  expect(service.repository.deliveries()[0].status).toBe("accepted");
});

test("verified subscription creation cannot join an unrelated rollback", async () => {
  const t = await setup(), callbackEntered = gate(), verified = gate();
  const service = new TendMcpEvents(t.sqlite.mcpEvents(), t.store, async (_url, _headers, body) => {
    callbackEntered.release(); await verified.promise;
    return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
  });
  const subscribing = service.subscribe(subscription()); await callbackEntered.promise;
  const entered = gate(), resume = gate();
  const transaction = t.store.serializeAtomic(async () => { entered.release(); await resume.promise; throw new Error("Intentional UI rollback"); }).catch(() => {});
  await entered.promise; verified.release(); await new Promise(resolve => setTimeout(resolve, 10));
  resume.release(); await transaction; await subscribing;
  expect(service.repository.subscriptions()).toHaveLength(1);
});

test("changing an unassigned item's effective lane stops a pending Codex event without a work revision change", async () => {
  const t = await setup(); await t.events.subscribe(subscription()); const work = await t.input();
  const thread = await t.store.readThread("inbox");
  await t.store.writeThread("inbox", { ...thread, drainAgent: "claude", agents: { ...thread.agents, claude: { threadId: "claude-thread", boundAt: new Date().toISOString() } } });
  expect((await t.store.readWork("inbox", work.id)).updatedAt).toBe(work.updatedAt);
  await t.events.poll(); expect(t.deliveries).toHaveLength(0);
  expect(t.events.repository.deliveries()[0].status).toBe("stopped");
});

test("real HTTPS request lookup receives a pinned address array when Bun requests all addresses", async () => {
  const lookup = pinnedLookup([{ address: "8.8.8.8", family: 4 }]);
  lookup("callback.example", { family: 4 }, (error, address, family) => {
    expect(error).toBeNull(); expect(address).toBe("8.8.8.8"); expect(family).toBe(4);
  });
  lookup("callback.example", { all: true }, ((error: Error | null, addresses: unknown) => {
    expect(error).toBeNull(); expect(addresses).toEqual([{ address: "8.8.8.8", family: 4 }]);
  }) as any);
  let observed = false;
  await new Promise<void>((resolve, reject) => {
    const req = httpsRequest("https://callback.example/events", { agent: false, lookup: (host, options, callback) => {
      expect(host).toBe("callback.example");
      lookup(host, options, ((error: Error | null, value: unknown, family?: number) => {
        try {
          expect(error).toBeNull();
          if (options.all) expect(value).toEqual([{ address: "8.8.8.8", family: 4 }]);
          else { expect(value).toBe("8.8.8.8"); expect(family).toBe(4); }
          observed = true;
        } catch (error) { reject(error); }
        // Abort before connecting: this exercises actual runtime lookup shape without any public request.
        callback(new Error("Synthetic transport stop"), "", 4);
      }) as any);
    } });
    req.on("error", () => resolve()); req.end();
  });
  expect(observed).toBe(true);
  expect(() => pinnedLookup([{ address: "127.0.0.1", family: 4 }])).toThrow();
});
