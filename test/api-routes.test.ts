import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { apiRoutes } from "../server/routes/api";
import { AttentionStore } from "../server/store";

const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "attention-api-test-"));
  roots.push(root);
  const store = new AttentionStore(root);
  await store.init();
  const domain = new AttentionDomain(store);
  const app = apiRoutes({
    artifactsDir: root,
    dataDir: root,
    domain,
    notify: () => {},
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
});
