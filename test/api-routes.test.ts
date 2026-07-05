import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { apiRoutes } from "../server/routes/api";
import { AttentionStore } from "../server/store";

const roots: string[] = [];

async function setup(notify: (data: unknown) => void = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "attention-api-test-"));
  roots.push(root);
  const store = new AttentionStore(root);
  await store.init();
  const domain = new AttentionDomain(store);
  const app = apiRoutes({
    artifactsDir: root,
    dataDir: root,
    domain,
    notify,
    port: 0,
    root,
    sqlite: { status: () => ({ ok: true }) } as any,
    store,
  });
  return { app, domain, store };
}

function jsonPost(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("API routing and mutation hardening", () => {
  test("rejects foreign Origin mutations and allows no-Origin CLI-style mutations", async () => {
    const { app } = await setup();

    const blocked = await app.request("/api/agents/claude/presence", jsonPost(
      { sessionId: "session-foreign" },
      { origin: "https://attacker.example" },
    ));
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: "Mutating requests are only accepted from localhost origins." });

    const allowed = await app.request("/api/agents/claude/presence", jsonPost({ sessionId: "session-local" }));
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ presence: { agent: "claude", sessionId: "session-local" } });
  });

  test("validates presence agent path against the allowlist", async () => {
    const { app } = await setup();

    const response = await app.request("/api/agents/not-claude/presence", jsonPost({ sessionId: "session-a" }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Unsupported agent presence endpoint." });
  });

  test("notifies presence changes only for visible transitions", async () => {
    const notifications: unknown[] = [];
    const { app, domain, store } = await setup((data) => notifications.push(data));
    await domain.bindFeed("inbox", "thread-codex");
    await domain.bindAgentFeed("inbox", "claude");
    await domain.setFeedDrainAgent("inbox", "claude");
    await domain.queueFeedInstruction("inbox", "Replay this parked Claude item.");

    const first = await app.request("/api/agents/claude/presence", jsonPost({ sessionId: "session-a" }));
    const heartbeat = await app.request("/api/agents/claude/presence", jsonPost({ sessionId: "session-a" }));
    const sessionChanged = await app.request("/api/agents/claude/presence", jsonPost({ sessionId: "session-b" }));
    await store.writeAgentPresence("claude", {
      agent: "claude",
      sessionId: "session-b",
      lastSeenAt: new Date(Date.now() - 120_000).toISOString(),
    });
    const staleReplay = await app.request("/api/agents/claude/presence", jsonPost({ sessionId: "session-b" }));

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ changed: true, replayed: 1 });
    expect(heartbeat.status).toBe(200);
    expect(await heartbeat.json()).toMatchObject({ changed: false, replayed: 0 });
    expect(sessionChanged.status).toBe(200);
    expect(await sessionChanged.json()).toMatchObject({ changed: true, replayed: 0 });
    expect(staleReplay.status).toBe(200);
    expect(await staleReplay.json()).toMatchObject({ changed: true, replayed: 1 });
    expect(notifications).toHaveLength(3);
  });

  test("rejects Claude-assigned instructions on unbound feeds before queueing", async () => {
    const { app, store } = await setup();

    const response = await app.request("/api/voice/instructions", jsonPost({
      feedId: "inbox",
      target: { kind: "feed", feedId: "inbox" },
      instruction: "Send this to Claude.",
      assignee: "claude",
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("has no Claude binding") });
    expect(await store.readWorkItems("inbox")).toEqual([]);
  });

  test("accepts Claude-assigned instructions after a feed is bound", async () => {
    const { app, domain } = await setup();
    await domain.bindAgentFeed("inbox", "claude");

    const response = await app.request("/api/voice/instructions", jsonPost({
      feedId: "inbox",
      target: { kind: "feed", feedId: "inbox" },
      instruction: "Send this to Claude.",
      assignee: "claude",
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ work: { assignee: "claude" } });
  });

  test("redacts capability tokens from browser work reassignment responses", async () => {
    const { app, domain } = await setup();
    await domain.bindFeed("inbox", "thread-codex");
    await domain.bindAgentFeed("inbox", "claude");
    const queued = await domain.queueFeedInstruction("inbox", "Route this through the browser.");

    const response = await app.request(`/api/feeds/inbox/work/${queued.id}/assignee`, jsonPost({ agent: "claude" }));
    const bytes = await response.text();

    expect(response.status).toBe(200);
    expect(bytes).not.toContain("capabilityToken");
    expect(bytes).not.toContain(queued.capabilityToken);
  });

  test("redacts capability tokens from browser approved-action retry responses", async () => {
    const { app, domain } = await setup();
    await domain.bindFeed("inbox", "thread-codex");
    await domain.upsertCard("inbox", {
      id: "api-retry-redaction",
      title: "Retry this approved action.",
      why: "The connector may need another attempt.",
      sourceMailbox: "dan@every.to",
      blocks: [{ id: "draft", type: "editable_text", label: "Draft", value: "Approved body.", editable: true }],
      actions: [
        { id: "send", label: "Send", behavior: "approve_action", instruction: "Send the exact draft.", artifactBlockId: "draft", externalMutation: true, mailboxPolicy: "reply_from_source" },
      ],
    });
    const approved = await domain.runCardAction("inbox", "api-retry-redaction", "send");
    const claimed = await domain.claimWork("inbox", "thread-codex");
    if (!claimed || "claim" in claimed) throw new Error("Expected claimed work item");
    await domain.blockApprovedWork("inbox", approved.id, claimed.capabilityToken, "Connector refused.");

    const response = await app.request(`/api/feeds/inbox/work/${approved.id}/retry`, jsonPost({}));
    const bytes = await response.text();

    expect(response.status).toBe(200);
    expect(bytes).not.toContain("capabilityToken");
    expect(bytes).not.toContain(claimed.capabilityToken);
  });
});
