import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { createLocalRuntime } from "../server/runtime";
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
    blocks: [{ id: "draft", type: "editable_text" as const, label: "Draft", value: "Approved text.", editable: true }],
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
test("changing the source mailbox invalidates prior approval", async () => {
 try { await reproMailboxApprovalDrift(); }
 finally { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); }
});
