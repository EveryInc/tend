import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { NativeApprovalBroker, nativeQuestions, type NativeApprovalRequest } from "../server/nativeApprovals";
import { apiRoutes } from "../server/routes/api";
import { AttentionStore } from "../server/store";
import type { NativeApprovalView } from "../shared/nativeApproval";
import type { WorkItem } from "../shared/types";

const fixtures: Array<{ root: string; broker: NativeApprovalBroker }> = [];
const questions = [{ id: "confirm", question: "Send this exact message to reader@example.test?", options: [
  { label: "Send once", description: "Send the displayed message to this recipient." },
  { label: "Do not send", description: "Leave the message unsent." },
] }];
const request: NativeApprovalRequest = {
  requestId: 42, method: "item/tool/requestUserInput",
  tool: { id: "tool-item", threadId: "thread-inbox", turnId: "turn-one", server: "test-mail", tool: "send",
    arguments: { to: "reader@example.test", body: "Exact approved body." } },
  questions,
};

async function setup(timeoutMs?: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-native-approval-"));
  const store = new AttentionStore(root);
  await store.init();
  const domain = new AttentionDomain(store);
  await domain.bindFeed("inbox", "thread-inbox");
  await domain.upsertCard("inbox", { id: "native-card", title: "Reply to the reader", why: "Test only.",
    sourceMailbox: "owner@example.test",
    blocks: [{ id: "draft", type: "editable_text", label: "Draft", value: "To: reader@example.test\n\nExact approved body.", editable: true }],
    actions: [{ id: "send", label: "Send reply", behavior: "approve_action", instruction: "Send the displayed draft to reader@example.test.",
      artifactBlockId: "draft", externalMutation: true, mailboxPolicy: "reply_from_source" }],
  });
  await domain.runCardAction("inbox", "native-card", "send");
  const work = await domain.claimWork("inbox", "thread-inbox") as WorkItem;
  await domain.verifyApprovedAction("inbox", work.id, work.capabilityToken, "owner@example.test");
  const broker = new NativeApprovalBroker(store, () => {}, timeoutMs);
  fixtures.push({ root, broker });
  const app = apiRoutes({ root, artifactsDir: root, dataDir: root, domain, store, nativeApprovals: broker,
    sqlite: { status: () => ({ ok: true }) } as any, port: 0, mutationToken: "browser-token", notify: () => {} });
  return { store, domain, work, broker, app };
}

async function waitForView(broker: NativeApprovalBroker): Promise<NativeApprovalView> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [view] = await broker.list("inbox");
    if (view) return view;
    await Bun.sleep(5);
  }
  throw new Error("No native prompt appeared.");
}

afterEach(async () => {
  for (const { root, broker } of fixtures.splice(0)) {
    broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

describe("native approval broker", () => {
  test("waits for a real response and sends the exact native option only once", async () => {
    const { broker, store } = await setup();
    let resolved = false;
    const response = broker.request("inbox", request, new AbortController().signal).then((value) => { resolved = true; return value; });
    const view = await waitForView(broker);
    expect(resolved).toBe(false);
    expect(view).toMatchObject({ cardId: "native-card", actionLabel: "Send reply", arguments: request.tool.arguments, questions });
    expect(JSON.stringify(view)).not.toContain("capabilityToken");
    const input = { requestDigest: view.requestDigest, decision: "respond" as const, answers: { confirm: "Send once" } };
    await broker.respond("inbox", view.id, input);
    expect(await response).toEqual({ answers: { confirm: { answers: ["Send once"] } } });
    await expect(broker.respond("inbox", view.id, input)).rejects.toThrow("no longer pending");
    expect((await store.readWorkItems("inbox"))[0].status).toBe("working");
  });

  test("rejects cross-feed, forged digest, missing and invented answers without resolving", async () => {
    const { broker } = await setup();
    const response = broker.request("inbox", request, new AbortController().signal);
    const view = await waitForView(broker);
    const input = { requestDigest: view.requestDigest, decision: "respond" as const, answers: { confirm: "Send once" } };
    await expect(broker.respond("company-attention", view.id, input)).rejects.toThrow("no longer pending");
    await expect(broker.respond("inbox", view.id, { ...input, requestDigest: "forged" })).rejects.toThrow("changed");
    await expect(broker.respond("inbox", view.id, { ...input, answers: {} })).rejects.toThrow("every");
    await expect(broker.respond("inbox", view.id, { ...input, answers: { confirm: "Approve forever" } })).rejects.toThrow("exact options");
    expect(await broker.list("inbox")).toHaveLength(1);
    await broker.respond("inbox", view.id, { requestDigest: view.requestDigest, decision: "cancel" });
    expect(await response).toEqual({ answers: {} });
  });

  for (const changed of ["artifact", "mailbox", "card", "work"] as const) {
    test(`invalidates a pending response when ${changed} changes`, async () => {
      const { broker, store, work } = await setup();
      const response = broker.request("inbox", request, new AbortController().signal);
      const view = await waitForView(broker);
      if (changed === "work") await store.writeWork({ ...await store.readWork("inbox", work.id), status: "approved_blocked" });
      else {
        const card = await store.readCard("inbox", "native-card");
        if (changed === "artifact" && card.blocks[0].type === "editable_text") card.blocks[0].value = "Changed body.";
        if (changed === "mailbox") card.sourceMailbox = "other@example.test";
        if (changed === "card") card.title = "Different context";
        await store.writeCard(card);
      }
      await expect(broker.respond("inbox", view.id, { requestDigest: view.requestDigest, decision: "respond", answers: { confirm: "Send once" } })).rejects.toThrow();
      expect(await response).toEqual({ answers: {} });
      expect(await broker.list("inbox")).toEqual([]);
    });
  }

  test("host cancellation and server shutdown discard prompts without approving", async () => {
    const { broker } = await setup();
    const controller = new AbortController();
    const response = broker.request("inbox", request, controller.signal);
    const view = await waitForView(broker);
    controller.abort();
    expect(await response).toEqual({ answers: {} });
    await expect(broker.respond("inbox", view.id, { requestDigest: view.requestDigest, decision: "respond", answers: { confirm: "Send once" } })).rejects.toThrow();
    const second = broker.request("inbox", { ...request, requestId: 43 }, new AbortController().signal);
    await waitForView(broker);
    broker.close();
    expect(await second).toEqual({ answers: {} });
  });

  test("expires requests instead of leaving reusable approval state", async () => {
    const { broker } = await setup(50);
    const response = broker.request("inbox", request, new AbortController().signal);
    await waitForView(broker);
    expect(await response).toEqual({ answers: {} });
    expect(await broker.list("inbox")).toEqual([]);
  });

  test("refuses unverified, ordinary, or wrong-task work", async () => {
    const { broker, store, work } = await setup();
    await expect(broker.request("inbox", { ...request, tool: { ...request.tool, threadId: "other" } }, new AbortController().signal)).rejects.toThrow("task");
    await store.writeWork({ ...work, verifiedApprovalDigest: undefined, verifiedAt: undefined });
    await expect(broker.request("inbox", request, new AbortController().signal)).rejects.toThrow("verified");
    await store.writeWork({ ...work, kind: "scoped_instruction", approvalDigest: undefined });
    await expect(broker.request("inbox", request, new AbortController().signal)).rejects.toThrow("verified");
  });

  test("uses protected browser routes and returns stale submissions as errors", async () => {
    const { broker, app } = await setup();
    const response = broker.request("inbox", request, new AbortController().signal);
    const view = await waitForView(broker);
    const url = `/api/feeds/inbox/native-approvals/${view.id}/respond`;
    const body = JSON.stringify({ requestDigest: view.requestDigest, decision: "respond", answers: { confirm: "Do not send" } });
    const json = { "content-type": "application/json" };
    expect((await app.request(url, { method: "POST", headers: { ...json, origin: "https://foreign.example" }, body })).status).toBe(403);
    expect((await app.request(url, { method: "POST", headers: { ...json, origin: "http://127.0.0.1:4321" }, body })).status).toBe(403);
    const headers = { ...json, origin: "http://127.0.0.1:4321", "x-attention-mutation-token": "browser-token" };
    const listed = await app.request("/api/feeds/inbox/native-approvals");
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect((await listed.json())[0].arguments).toEqual(request.tool.arguments);
    expect((await app.request(url, { method: "POST", headers, body })).status).toBe(200);
    expect(await response).toEqual({ answers: { confirm: { answers: ["Do not send"] } } });
    expect((await app.request(url, { method: "POST", headers, body })).status).toBe(400);
  });

  test("only displays bounded, nonsecret choice questions", () => {
    expect(nativeQuestions({ questions })).toEqual(questions);
    expect(() => nativeQuestions({ questions: [{ ...questions[0], isSecret: true }] })).toThrow();
    expect(() => nativeQuestions({ questions: [{ ...questions[0], options: null }] })).toThrow();
    expect(() => nativeQuestions({ questions: [questions[0], questions[0]] })).toThrow();
  });
});
