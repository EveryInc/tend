import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { createLocalRuntime } from "../server/runtime";
import { actionDigest, legacyActionDigestWithoutSourceMailbox } from "../server/workflow/approvals";
import type { Card, WorkItem } from "../shared/types";
const roots: string[] = [];
async function freshRoot(label: string) {
 const root = await mkdtemp(path.join(os.tmpdir(), `tend-${label}-`)); roots.push(root); return root;
}
async function reproMailboxApprovalDrift() {
  const root = await freshRoot("mailbox-drift");
  const runtime = await createLocalRuntime(path.join(root, "data"), path.join(root, "attention.db"));
  const domain = new AttentionDomain(runtime.store);
  await domain.bindFeed("inbox", "thread-inbox");
  const cardInput = {
    id: "mailbox-drift",
    title: "Send this reply",
    why: "The reply is ready.",
    blocks: [
      { id: "source", type: "evidence" as const, label: "Source", items: [{ label: "Original thread", href: "https://mail.google.com/mail/u/0/#inbox/thread-legacy" }] },
      { id: "draft", type: "editable_text" as const, label: "Draft", value: "Approved text.", editable: true },
    ],
    actions: [{ id: "send", label: "Send reply", behavior: "approve_action" as const, instruction: "Send the exact reply.", artifactBlockId: "draft", externalMutation: true, mailboxPolicy: "reply_from_source" as const }],
  };
  await domain.upsertCard("inbox", { ...cardInput, sourceMailbox: "first@example.com" });
  const approved = await domain.runCardAction("inbox", cardInput.id, "send");
  await domain.upsertCard("inbox", { ...cardInput, sourceMailbox: "second@example.com" });
  const claimed = await domain.claimWork("inbox", "thread-inbox");
  if (!claimed || !("capabilityToken" in claimed)) throw new Error("Expected a claimed work item");
  await expect(domain.verifyApprovedAction("inbox", approved.id, claimed.capabilityToken, "second@example.com")).rejects.toThrow("Approval stale");
  const currentMailbox = (await runtime.store.readCard("inbox", cardInput.id)).sourceMailbox;
  runtime.sqlite.close();
  return { approvedMailbox: "first@example.com", currentMailbox, approvalDigest: approved.approvalDigest };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("changing the source mailbox invalidates prior approval", async () => {
 await reproMailboxApprovalDrift();
});

async function legacyApprovalFixture(label: string) {
  const root = await freshRoot(label);
  const runtime = await createLocalRuntime(path.join(root, "data"), path.join(root, "attention.db"));
  const domain = new AttentionDomain(runtime.store);
  await domain.bindFeed("inbox", "thread-inbox");
  const sourceSnapshot = { id: "thread-legacy", messages: [{ id: "message-legacy", text: "Please reply." }] };
  const runId = await domain.recordSourceRun("inbox", "gmail-inbox", [sourceSnapshot], [], {});
  await domain.recordSweepBatch("inbox", [runId]);
  const input = {
    id: "legacy-mailbox-approval",
    title: "Send this exact reply",
    why: "The reviewed source still requests a reply.",
    sourceMailbox: "dan@example.com",
    sourceRunIds: [runId],
    blocks: [{ id: "draft", type: "editable_text" as const, label: "Draft", value: "Approved text.", editable: true }],
    actions: [{ id: "send", label: "Send reply", behavior: "approve_action" as const, instruction: "Send the exact reply to reader@example.com.", artifactBlockId: "draft", externalMutation: true, mailboxPolicy: "reply_from_source" as const }],
  };
  await domain.upsertCard("inbox", input);
  const approved = await domain.runCardAction("inbox", input.id, "send");
  const card = await runtime.store.readCard("inbox", input.id);
  const legacyDigest = legacyActionDigestWithoutSourceMailbox(card, "send");
  if (!legacyDigest) throw new Error("Expected a legacy mailbox digest.");
  const work = await runtime.store.readWork("inbox", approved.id);
  work.approvalDigest = legacyDigest;
  return { runtime, domain, input, card, work, sourceSnapshot, currentDigest: actionDigest(card, "send") };
}

async function storeRetryState(runtime: Awaited<ReturnType<typeof createLocalRuntime>>, card: Card, work: WorkItem, status: "approved_blocked" | "stale") {
  work.status = status;
  work.error = status === "stale"
    ? "Approval stale - the proposed action or artifact changed after approval."
    : "Connector temporarily refused the approved send.";
  card.status = status === "stale" ? "to_review_updated" : "approved_blocked";
  await runtime.store.writeWork(work);
  await runtime.store.writeCard(card);
}

for (const status of ["approved_blocked", "stale"] as const) {
  test(`migrates an unchanged ${status} pre-mailbox approval exactly once`, async () => {
    const { runtime, domain, card, work, sourceSnapshot, currentDigest } = await legacyApprovalFixture(`legacy-${status}`);
    await storeRetryState(runtime, card, work, status);
    const currentRun = await domain.recordSourceRun("inbox", "gmail-inbox", [sourceSnapshot], [], {});
    await domain.recordSweepBatch("inbox", [currentRun]);

    const retried = await domain.retryApprovedWork("inbox", work.id);
    expect(retried.status).toBe("queued");
    expect(retried.approvalDigest).toBe(currentDigest);
    expect((await runtime.store.readCard("inbox", card.id)).status).toBe("queued");
    const events = (await runtime.store.readEvents("inbox")).filter((event) => event.workId === work.id && event.type === "action.approval_digest_migrated");
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({ from: work.approvalDigest, to: currentDigest, addedBinding: "source_mailbox" });
    runtime.sqlite.close();
  });
}

test("does not migrate a legacy digest after the source mailbox changes", async () => {
  const { runtime, domain, input, card, work } = await legacyApprovalFixture("legacy-mailbox-changed");
  await storeRetryState(runtime, card, work, "approved_blocked");
  await domain.upsertCard("inbox", { ...input, sourceMailbox: "other@example.com" });

  await expect(domain.retryApprovedWork("inbox", work.id)).rejects.toThrow("Approval stale");
  expect((await runtime.store.readWork("inbox", work.id)).status).toBe("stale");
  expect((await runtime.store.readEvents("inbox")).filter((event) => event.workId === work.id && event.type === "action.approval_digest_migrated")).toHaveLength(0);
  runtime.sqlite.close();
});

test("does not migrate a legacy digest after its source evidence changes", async () => {
  const { runtime, domain, card, work } = await legacyApprovalFixture("legacy-source-changed");
  await storeRetryState(runtime, card, work, "approved_blocked");
  const changedRun = await domain.recordSourceRun("inbox", "gmail-inbox", [{ id: "thread-legacy", messages: [{ id: "message-legacy", text: "The request changed after approval." }] }], [], {});
  await domain.recordSweepBatch("inbox", [changedRun]);

  await expect(domain.retryApprovedWork("inbox", work.id)).rejects.toThrow("source evidence is stale");
  expect((await runtime.store.readWork("inbox", work.id)).status).toBe("approved_blocked");
  expect((await runtime.store.readEvents("inbox")).filter((event) => event.workId === work.id && event.type === "action.approval_digest_migrated")).toHaveLength(0);
  runtime.sqlite.close();
});

test("does not revive a legacy approval after a newer approval completed the action", async () => {
  const { runtime, domain, card, work } = await legacyApprovalFixture("legacy-already-completed");
  await storeRetryState(runtime, card, work, "stale");
  const newer = await domain.runCardAction("inbox", card.id, "send");
  const claimed = await domain.claimWork("inbox", "thread-inbox");
  if (!claimed || !("capabilityToken" in claimed) || claimed.id !== newer.id) throw new Error("Expected the newer action claim.");
  const verified = await domain.verifyApprovedAction("inbox", newer.id, claimed.capabilityToken, "dan@example.com");
  if (!verified.emailDelivery) throw new Error("Expected prepared email delivery.");
  await domain.completeWork("inbox", newer.id, claimed.capabilityToken, {
    response: "The newer approval completed.",
    emailDeliveryReadback: {
      ...verified.emailDelivery,
      source: "connector_readback",
      providerMessageId: "newer-message",
      readAt: "2026-09-12T12:01:00.000Z",
    },
    postAction: {
      cleanup: { status: "completed", detail: "The exact source row was archived." },
      disposition: "done",
    },
  });

  await expect(domain.retryApprovedWork("inbox", work.id)).rejects.toThrow("newer approval already completed");
  expect((await runtime.store.readWork("inbox", work.id)).status).toBe("stale");
  expect((await runtime.store.readEvents("inbox")).filter((event) => event.workId === work.id && event.type === "action.approval_digest_migrated")).toHaveLength(0);
  runtime.sqlite.close();
});
