import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { AttentionDomain } from "../server/domain";
import { SupabaseMobileCloudClient } from "../server/mobile/client";
import { projectMobileWorkspace } from "../server/mobile/projection";
import { MobileSyncWorker } from "../server/mobile/sync";
import { createLocalRuntime } from "../server/runtime";

const enabled = process.env.TEND_SUPABASE_E2E === "1";
const integrationTest = enabled ? test : test.skip;

integrationTest("local Supabase mirrors dynamic feeds and returns phone commands to Tend", async () => {
  const url = requiredEnv("TEND_TEST_SUPABASE_URL");
  const anonKey = requiredEnv("TEND_TEST_SUPABASE_ANON_KEY");
  const serviceRoleKey = requiredEnv("TEND_TEST_SUPABASE_SERVICE_ROLE_KEY");
  const jwtSecret = requiredEnv("TEND_TEST_SUPABASE_JWT_SECRET");
  const userId = randomUUID();
  const workerId = `e2e-${randomUUID()}`;
  const root = await mkdtemp(path.join(os.tmpdir(), "attention-mobile-supabase-"));
  const runtime = await createLocalRuntime(path.join(root, "data"), path.join(root, "attention.db"));

  try {
    const store = runtime.store;
    const domain = new AttentionDomain(store);
    await domain.bindFeed("inbox", "thread-inbox");
    await domain.upsertCard("inbox", {
      id: "shared-card-id",
      title: "Inbox phone review",
      why: "This card should remain inside Inbox.",
      blocks: [{ id: "memo", type: "memo", text: "Inbox evidence." }],
    });
    await domain.upsertCard("company-attention", {
      id: "shared-card-id",
      title: "Company phone review",
      why: "The same card id must remain isolated in Company.",
      blocks: [{ id: "memo", type: "memo", text: "Company evidence." }],
    });
    await domain.upsertCard("inbox", {
      id: "dismiss-e2e",
      title: "Dismiss this locally.",
      why: "The phone bridge must not create connector work for local dismissal.",
      blocks: [{ id: "memo", type: "memo", text: "No source cleanup requested." }],
    });
    await domain.createFeedFromBrief("Every\nReview editorial and product opportunities.", null);
    await domain.createFeedFromBrief("Temporary Mobile Test\nExercise dynamic feed discovery.", null);

    const cloud = new SupabaseMobileCloudClient({
      url,
      secretKey: serviceRoleKey,
      userId,
      workerId,
    });
    const worker = new MobileSyncWorker(store, domain, cloud);
    expect((await worker.runOnce()).lastError).toBeUndefined();

    const token = signedUserToken(userId, jwtSecret);
    const mirroredFeeds = await rest<Array<{ feed_id: string }>>(
      url,
      anonKey,
      token,
      "/rest/v1/mobile_feeds?select=feed_id&order=position",
    );
    expect(mirroredFeeds.map((row) => row.feed_id)).toEqual([
      "inbox",
      "company-attention",
      "every",
      "temporary-mobile-test",
    ]);

    const projection = (await projectMobileWorkspace(store)).cards.find(
      (card) => card.feedId === "inbox" && card.cardId === "shared-card-id",
    )!;
    const commandId = randomUUID();
    const command = {
      id: commandId,
      clientRequestId: randomUUID(),
      deviceId: "iphone-e2e",
      feedId: projection.feedId,
      cardId: projection.cardId,
      feedGeneration: projection.feedGeneration,
      expectedCardDigest: projection.cardDigest,
      kind: "instruction",
      instruction: "Research the strongest next step from this exact Inbox card.",
    };
    const submitted = await rest<Array<{ id: string; state: string }>>(
      url,
      anonKey,
      token,
      "/rest/v1/rpc/submit_mobile_command",
      {
        method: "POST",
        body: { p_command: command },
      },
    );
    expect(submitted).toEqual([expect.objectContaining({ id: commandId, state: "pending" })]);

    expect((await worker.runOnce()).lastError).toBeUndefined();
    await worker.runOnce();

    const activity = await rest<Array<{
      id: string;
      feed_id: string;
      state: string;
      result_work_id: string | null;
      work_status: string | null;
    }>>(
      url,
      anonKey,
      token,
      `/rest/v1/mobile_commands?id=eq.${commandId}&select=id,feed_id,state,result_work_id,work_status`,
    );
    expect(activity).toEqual([
      expect.objectContaining({
        id: commandId,
        feed_id: "inbox",
        state: "applied",
        result_work_id: expect.any(String),
        work_status: "queued",
      }),
    ]);

    const imported = (await store.readWorkItems("inbox")).filter(
      (work) => work.sourceMobileCommandId === commandId,
    );
    expect(imported).toHaveLength(1);
    expect(imported[0].instruction).toContain("exact Inbox card");
    expect((await store.readWorkItems("company-attention")).some(
      (work) => work.sourceMobileCommandId === commandId,
    )).toBe(false);

    const dismissProjection = (await projectMobileWorkspace(store)).cards.find(
      (card) => card.feedId === "inbox" && card.cardId === "dismiss-e2e",
    )!;
    const dismissAction = dismissProjection.actions.find((action) => action.id === "dismiss-card")!;
    const dismissCommandId = randomUUID();
    await rest(
      url,
      anonKey,
      token,
      "/rest/v1/rpc/submit_mobile_command",
      {
        method: "POST",
        body: {
          p_command: {
            id: dismissCommandId,
            clientRequestId: randomUUID(),
            deviceId: "iphone-e2e",
            feedId: dismissProjection.feedId,
            cardId: dismissProjection.cardId,
            feedGeneration: dismissProjection.feedGeneration,
            expectedCardDigest: dismissProjection.cardDigest,
            kind: "dismiss",
            actionId: dismissAction.id,
            expectedActionDigest: dismissAction.digest,
          },
        },
      },
    );

    await Bun.sleep(5_250);
    expect((await worker.runOnce()).lastError).toBeUndefined();
    const dismissActivity = await rest<Array<{ state: string; result_work_id: string | null }>>(
      url,
      anonKey,
      token,
      `/rest/v1/mobile_commands?id=eq.${dismissCommandId}&select=state,result_work_id`,
    );
    expect(dismissActivity).toEqual([{ state: "applied", result_work_id: null }]);
    expect(await store.readCard("inbox", "dismiss-e2e")).toMatchObject({
      status: "done",
      completionDisposition: "dismissed",
    });
    expect((await store.readWorkItems("inbox")).some(
      (work) => work.sourceMobileCommandId === dismissCommandId,
    )).toBe(false);
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

async function rest<T>(
  url: string,
  anonKey: string,
  token: string,
  route: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${url}${route}`, {
    method: options.method ?? "GET",
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${route} failed (${response.status}): ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

function signedUserToken(userId: string, secret: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    aud: "authenticated",
    exp: now + 3_600,
    iat: now,
    iss: "supabase-demo",
    role: "authenticated",
    sub: userId,
    email: "dan@every.to",
  }));
  const unsigned = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the local Supabase integration test.`);
  return value;
}
