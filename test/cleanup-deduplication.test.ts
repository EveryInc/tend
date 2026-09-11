import { expect, test } from "bun:test";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { AttentionDomain } from "../server/domain.ts";
import { createLocalRuntime } from "../server/runtime.ts";

test("bundled and standalone cleanup exclude each other", async () => {
const root = await mkdtemp(path.join(os.tmpdir(), "domain-concurrent-cleanup-"));
try {
  const runtime = await createLocalRuntime(path.join(root, "data"), path.join(root, "attention.db"));
  const domain = new AttentionDomain(runtime.store);
  await domain.bindFeed("inbox", "thread-inbox");
  await domain.upsertCard("inbox", {
    id: "concurrent-cleanup",
    title: "Send and archive",
    why: "The approved action includes source cleanup.",
    sourceMailbox: "owner@example.com",
    blocks: [{ id: "draft", type: "editable_text", value: "Approved reply.", editable: true }],
    actions: [
      { id: "send", label: "Send", behavior: "approve_action", instruction: "Send the approved reply.", artifactBlockId: "draft", externalMutation: true, mailboxPolicy: "reply_from_source" },
      { id: "archive", label: "Archive", behavior: "default_cleanup" },
    ],
  });
  const cleanup = await domain.queueSourceCleanup("inbox", "concurrent-cleanup");
  await expect(domain.runCardAction("inbox", "concurrent-cleanup", "send")).rejects.toThrow("Source cleanup is already pending");
  await domain.cancelQueuedWork("inbox", cleanup.id);
  await domain.runCardAction("inbox", "concurrent-cleanup", "send");
  await expect(domain.queueSourceCleanup("inbox", "concurrent-cleanup")).rejects.toThrow("already includes");
  runtime.sqlite.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
});

for (const duplicateStatus of ["queued", "working", "approved_blocked"] as const) {
  test(`legacy ${duplicateStatus} cleanup is retired or kept for reconciliation`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tend-legacy-cleanup-"));
    const runtime = await createLocalRuntime(path.join(root, "data"), path.join(root, "attention.db"));
    try {
      const domain = new AttentionDomain(runtime.store);
      await domain.bindFeed("inbox", "thread-inbox");
      await domain.upsertCard("inbox", {
        id: "legacy-card", title: "Archive this", why: "Cleanup fixture",
        blocks: [], actions: [{ id: "archive", label: "Archive", behavior: "default_cleanup" }],
      });
      const queued = await domain.queueSourceCleanup("inbox", "legacy-card");
      const claim = await domain.claimWork("inbox", "thread-inbox");
      if (!claim || !("capabilityToken" in claim)) throw new Error("Expected a work claim");
      await domain.verifyApprovedAction("inbox", queued.id, claim.capabilityToken);
      const duplicate = { ...await runtime.store.readWork("inbox", queued.id), id: "legacy-duplicate", status: duplicateStatus };
      await runtime.store.writeWork(duplicate);
      await domain.completeWork("inbox", queued.id, claim.capabilityToken, { response: "Cleanup confirmed." });
      const remaining = await runtime.store.readWork("inbox", duplicate.id);
      expect(remaining.status).toBe(duplicateStatus === "queued" ? "stale" : duplicateStatus);
      if (duplicateStatus === "queued") {
        expect(remaining.verifiedApprovalDigest).toBeUndefined();
      } else if (duplicateStatus === "working") {
        await expect(domain.verifyApprovedAction("inbox", remaining.id, remaining.capabilityToken)).rejects.toThrow("Conflicting source cleanup");
      }
    } finally {
      runtime.sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
