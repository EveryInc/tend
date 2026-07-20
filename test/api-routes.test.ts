import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { apiRoutes } from "../server/routes/api";
import { AttentionStore } from "../server/store";
import { inboxThreadFixture, recordInboxCollection } from "./support/inboxSweep";

const roots: string[] = [];

async function setup(
  notify: (data: unknown) => void = () => {},
  startCodexThread?: (prompt: string, cwd: string) => Promise<{ threadId: string; deepLink: string }>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "attention-api-test-"));
  roots.push(root);
  const store = new AttentionStore(root);
  await store.init();
  const domain = new AttentionDomain(store);
  const app = apiRoutes({
    artifactsDir: root,
    dataDir: root,
    domain,
    mutationToken: "test-token",
    notify,
    port: 0,
    root,
    sqlite: { status: () => ({ ok: true }) } as any,
    startCodexThread,
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
  test("starts a card-grounded Codex conversation and records its receipt", async () => {
    const requests: Array<{ prompt: string; cwd: string }> = [];
    const { app, domain, store } = await setup(() => {}, async (prompt, cwd) => {
      requests.push({ prompt, cwd });
      return { threadId: "019f-agent-thread", deepLink: "codex://threads/019f-agent-thread" };
    });
    const fixture = inboxThreadFixture("thread-agent");
    await domain.finalizeInboxSweep("inbox", "gmail-inbox", [fixture.snapshot], [fixture.card], {}, await recordInboxCollection(domain, [fixture.snapshot.threadId]));

    const response = await app.request(`/api/feeds/inbox/cards/${fixture.card.id}/start-agent`, jsonPost({ instruction: "Draft three possible replies and explain the tradeoffs." }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ threadId: "019f-agent-thread", deepLink: "codex://threads/019f-agent-thread" });
    expect(requests[0]?.prompt).toContain("Draft three possible replies and explain the tradeoffs.");
    expect(requests[0]?.prompt).toContain(fixture.snapshot.threadText);
    expect(requests[0]?.prompt).toContain("Do not send, reply, archive, or mutate any external service without explicit confirmation");
    expect((await store.readCard("inbox", fixture.card.id)).agentThreads).toMatchObject([{ threadId: "019f-agent-thread" }]);
    expect((await store.readEvents("inbox")).at(-1)).toMatchObject({ type: "codex.thread_started", cardId: fixture.card.id });
  });

  test("records no task receipt when Codex cannot launch", async () => {
    const { app, domain, store } = await setup(() => {}, async () => {
      throw new Error("Codex working directory is unavailable.");
    });
    const fixture = inboxThreadFixture("thread-agent-launch-failure");
    await domain.finalizeInboxSweep("inbox", "gmail-inbox", [fixture.snapshot], [fixture.card], {}, await recordInboxCollection(domain, [fixture.snapshot.threadId]));

    const response = await app.request(`/api/feeds/inbox/cards/${fixture.card.id}/start-agent`, jsonPost({ instruction: "Investigate the cost increase." }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Codex working directory is unavailable." });
    expect((await store.readCard("inbox", fixture.card.id)).agentThreads ?? []).toHaveLength(0);
    expect((await store.readEvents("inbox")).some((event) => event.type === "codex.thread_started")).toBeFalse();
  });

  test("serves authoritative Inbox thread snapshots without browser caching", async () => {
    const { app, domain } = await setup();
    const fixture = inboxThreadFixture("thread-api");
    const result = await domain.finalizeInboxSweep(
      "inbox",
      "gmail-inbox",
      [fixture.snapshot],
      [fixture.card],
      {},
      await recordInboxCollection(domain, ["thread-api"]),
    );

    const response = await app.request(`/api/feeds/inbox/runs/${result.runId}/sources/gmail-inbox/snapshots/snapshot-1/thread`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ text: fixture.snapshot.threadText, truncated: false });

    const foreignSource = await app.request(`/api/feeds/inbox/runs/${result.runId}/sources/other-source/snapshots/snapshot-1/thread`);
    expect(foreignSource.status).toBe(404);
    expect(await foreignSource.json()).toEqual({ error: "Source snapshot does not belong to this run." });

    const readSnapshot = domain.readInboxThreadSnapshot.bind(domain);
    domain.readInboxThreadSnapshot = async () => { throw new Error("simulated storage outage"); };
    const storageFailure = await app.request(`/api/feeds/inbox/runs/${result.runId}/sources/gmail-inbox/snapshots/snapshot-1/thread`);
    expect(storageFailure.status).toBe(500);
    expect(await storageFailure.json()).toEqual({ error: "simulated storage outage" });
    domain.readInboxThreadSnapshot = readSnapshot;
  });

  test("rejects foreign Origin mutations and allows no-Origin CLI-style mutations", async () => {
    const { app } = await setup();

    const blocked = await app.request("/api/agents/claude/presence", jsonPost(
      { sessionId: "session-foreign" },
      { origin: "https://attacker.example" },
    ));
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: "Cross-origin mutation requests are not allowed." });

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
    const bytes = await response.text();

    expect(response.status).toBe(200);
    expect(bytes).not.toContain("capabilityToken");
    expect(JSON.parse(bytes)).toMatchObject({ work: { assignee: "claude" } });
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

  test("redacts capability tokens from browser card-action queue responses", async () => {
    const { app, domain, store } = await setup();
    await domain.upsertCard("inbox", {
      id: "api-card-action-redaction",
      title: "Queue a visible action.",
      why: "The browser should never receive the queue token.",
      sourceMailbox: "dan@every.to",
      blocks: [{ id: "draft", type: "editable_text", label: "Draft", value: "Approved body.", editable: true }],
      actions: [
        { id: "send", label: "Send", behavior: "approve_action", instruction: "Send the exact draft.", artifactBlockId: "draft", externalMutation: true, mailboxPolicy: "reply_from_source" },
      ],
    });

    const response = await app.request("/api/feeds/inbox/cards/api-card-action-redaction/actions/send", jsonPost({}));
    const bytes = await response.text();
    const result = JSON.parse(bytes) as { id: string };
    const persisted = await store.readWork("inbox", result.id);

    expect(response.status).toBe(200);
    expect(bytes).not.toContain("capabilityToken");
    expect(bytes).not.toContain(persisted.capabilityToken);
  });

  test("returns a warning when browser reassignment sends approved external mutation work to Claude", async () => {
    const { app, domain } = await setup();
    await domain.bindFeed("inbox", "thread-codex");
    await domain.bindAgentFeed("inbox", "claude");
    await domain.upsertCard("inbox", {
      id: "api-external-mutation-warning",
      title: "Approved external action.",
      why: "Claude may not have connector capability.",
      sourceMailbox: "dan@every.to",
      blocks: [{ id: "draft", type: "editable_text", label: "Draft", value: "Approved body.", editable: true }],
      actions: [{ id: "send", label: "Send", behavior: "approve_action", instruction: "Send the approved body.", artifactBlockId: "draft", externalMutation: true, mailboxPolicy: "reply_from_source" }],
    });
    const approved = await domain.runCardAction("inbox", "api-external-mutation-warning", "send");

    const response = await app.request(`/api/feeds/inbox/work/${approved.id}/assignee`, jsonPost({ agent: "claude" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      assignee: "claude",
      warning: expect.stringContaining("external mutation"),
    });
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
