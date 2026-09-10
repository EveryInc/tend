import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { apiRoutes } from "../server/routes/api";
import { AttentionStore, readingContentRevision } from "../server/store";

const roots: string[] = [];

async function setup(notify: (data: unknown) => void = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "attention-api-test-"));
  roots.push(root);
  const store = new AttentionStore(root);
  await store.init();
  const domain = new AttentionDomain(store, root);
  const app = apiRoutes({
    artifactsDir: root,
    dataDir: root,
    domain,
    notify,
    port: 0,
    root,
    sqlite: { status: () => ({ ok: true }) } as any,
    store,
    mutationToken: "api-test-token",
  });
  return { app, domain, store, root };
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
  test("image import requires a local session, serves the exact bytes, and refuses a tampered preview", async () => {
    const { app, domain, root } = await setup();
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=";
    const source = await domain.upsertCard("company-attention", { id: "source", title: "Source card", why: "A fact.", blocks: [] });
    const input = { cardId: source.id, contentRevision: readingContentRevision(source), filename: "card.png", pngBase64 };
    expect((await app.request("/api/feeds/company-attention/images", jsonPost(input))).status).toBe(403);
    const response = await app.request("/api/feeds/company-attention/images", jsonPost(input, { "x-attention-mutation-token": "api-test-token" }));
    expect(response.status).toBe(200);
    const block = await response.json() as { image: { name: string } };
    const preview = `/api/artifacts/${block.image.name}`;
    const served = await app.request(preview);
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer()).toString("base64")).toBe(pngBase64);
    const file = path.join(root, "artifacts", block.image.name);
    await chmod(file, 0o644);
    await writeFile(file, "changed");
    expect((await app.request(preview)).status).toBe(404);
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

  test("allows only a current authenticated browser snapshot to turn explicit card speech into approval", async () => {
    const createCard = (domain: AttentionDomain, id: string) => domain.upsertCard("inbox", {
      id,
      title: "Review the exact reply.",
      why: "One visible artifact is ready.",
      sourceMailbox: "dan@every.to",
      blocks: [{ id: "draft", type: "editable_text" as const, value: "Exact reply.", editable: true }],
      actions: [{ id: "send", label: "Send reply", behavior: "approve_action" as const, instruction: "Send the exact reply.", artifactBlockId: "draft", externalMutation: true, mailboxPolicy: "reply_from_source" as const }],
    });
    const requestBody = (card: { id: string; updatedAt: string }) => ({
      feedId: "inbox",
      target: { kind: "card", feedId: "inbox", cardId: card.id },
      instruction: "This is fine",
      expectedCardUpdatedAt: card.updatedAt,
    });
    const browserHeaders = {
      origin: "http://127.0.0.1:4321",
      "x-attention-mutation-token": "api-test-token",
    };

    const trusted = await setup();
    const trustedCard = await createCard(trusted.domain, "trusted-voice-card");
    const trustedResponse = await trusted.app.request("/api/voice/instructions", jsonPost(requestBody(trustedCard), browserHeaders));
    const trustedBytes = await trustedResponse.text();
    expect(trustedResponse.status).toBe(200);
    expect(trustedBytes).not.toContain("capabilityToken");
    expect(JSON.parse(trustedBytes)).toMatchObject({
      kind: "approved_action",
      actionLabel: "Send reply",
      work: { kind: "execute_approved_action", approvalSource: "voice_instruction" },
    });

    const noSession = await setup();
    const noSessionCard = await createCard(noSession.domain, "untrusted-voice-card");
    const noSessionResponse = await noSession.app.request("/api/voice/instructions", jsonPost(requestBody(noSessionCard)));
    expect(noSessionResponse.status).toBe(200);
    expect(await noSessionResponse.json()).toMatchObject({
      kind: "scoped_work",
      approvalInterpretation: "not_approved",
      work: { kind: "scoped_instruction" },
    });

    const stale = await setup();
    const staleCard = await createCard(stale.domain, "stale-voice-card");
    await Bun.sleep(2);
    await stale.domain.updateBlock("inbox", staleCard.id, "draft", "Changed after it was displayed.");
    const staleResponse = await stale.app.request("/api/voice/instructions", jsonPost(requestBody(staleCard), browserHeaders));
    expect(staleResponse.status).toBe(400);
    expect(await staleResponse.json()).toMatchObject({ error: expect.stringContaining("card changed") });
    expect(await stale.store.readWorkItems("inbox")).toEqual([]);

    const staleFeedbackResponse = await stale.app.request("/api/voice/instructions", jsonPost({
      ...requestBody(staleCard),
      instruction: "Rewrite the ending.",
    }, browserHeaders));
    expect(staleFeedbackResponse.status).toBe(400);
    expect(await stale.store.readWorkItems("inbox")).toEqual([]);
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

  test("POST /cards/:card/dismiss dismisses locally without queuing work", async () => {
    const { app, store } = await setup();

    const response = await app.request("/api/feeds/inbox/cards/inbox-ready-to-collect/dismiss", jsonPost({}));
    expect(response.status).toBe(200);
    const card = await response.json() as { status: string; completionDisposition?: string };
    expect(card.status).toBe("done");
    expect(card.completionDisposition).toBe("dismissed");

    expect((await store.readWorkItems("inbox")).filter((item) => item.cardId === "inbox-ready-to-collect")).toHaveLength(0);
  });

  test("source cleanup has explicit queue and undo routes", async () => {
    const { app, store } = await setup();
    const configuredCard = await store.readCard("inbox", "inbox-ready-to-collect");
    configuredCard.actions = [
      ...(configuredCard.actions ?? []),
      { id: "archive-source", label: "Archive", behavior: "default_cleanup" },
    ];
    await store.writeCard(configuredCard);

    const queuedResponse = await app.request("/api/feeds/inbox/cards/inbox-ready-to-collect/cleanup-source", jsonPost({}));
    expect(queuedResponse.status).toBe(200);
    const work = await queuedResponse.json() as { kind: string };
    expect(work.kind).toBe("default_cleanup");

    const undoResponse = await app.request("/api/feeds/inbox/cards/inbox-ready-to-collect/undo-cleanup-source", jsonPost({}));
    expect(undoResponse.status).toBe(200);
    const card = await undoResponse.json() as { status: string; completionDisposition?: string };
    expect(card.status).toBe("to_review_updated");
    expect(card.completionDisposition).toBeUndefined();
  });

  test("source cleanup rejects a card that did not opt in", async () => {
    const { app } = await setup();

    const response = await app.request("/api/feeds/inbox/cards/inbox-ready-to-collect/cleanup-source", jsonPost({}));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Source cleanup is not available for this card." });
  });
});
