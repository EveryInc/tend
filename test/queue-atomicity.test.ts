import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { createLocalRuntime } from "../server/runtime";

for (const entry of ["card", "feed", "compound", "recollection"] as const) {
  test(`${entry} queue rolls back when its event cannot be persisted`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tend-atomic-queue-"));
    const runtime = await createLocalRuntime(path.join(root, "data"), path.join(root, "attention.db"));
    try {
      const domain = new AttentionDomain(runtime.store);
      const before = await runtime.store.readCard("inbox", "inbox-ready-to-collect");
      if (entry === "recollection") {
        const sweep = await runtime.store.readSweepState("inbox");
        await runtime.store.writeSweepState("inbox", { ...sweep, recollectionOffered: true });
      }
      runtime.store.appendEvent = async () => { throw new Error("event persistence failed"); };
      const operation = entry === "card" ? domain.queueInstruction("inbox", before.id, "Inspect this item.")
        : entry === "feed" ? domain.queueFeedInstruction("inbox", "Inspect the feed.")
        : entry === "compound" ? domain.queueCompound("inbox")
        : domain.requestSweepRecollection("inbox");
      await expect(operation).rejects.toThrow("event persistence failed");
      expect(await runtime.store.readWorkItems("inbox")).toEqual([]);
      expect(await runtime.store.readCard("inbox", before.id)).toEqual(before);
    } finally {
      runtime.sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("notifications run after commit and are discarded on rollback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-after-commit-"));
  const runtime = await createLocalRuntime(path.join(root, "data"), path.join(root, "attention.db"));
  const observer = await createLocalRuntime(path.join(root, "data"), path.join(root, "attention.db"));
  const observed: string[] = [];
  try {
    await runtime.store.serializeAtomic(async () => {
      const card = await runtime.store.readCard("inbox", "inbox-ready-to-collect");
      card.title = "Committed title";
      await runtime.store.writeCard(card);
      await runtime.store.afterCommit(async () => {
        observed.push((await observer.store.readCard("inbox", card.id)).title);
      });
      expect(observed).toEqual([]);
    });
    expect(observed).toEqual(["Committed title"]);
    await expect(runtime.store.serializeAtomic(async () => {
      await runtime.store.afterCommit(async () => { observed.push("rolled back"); });
      throw new Error("abort");
    })).rejects.toThrow("abort");
    expect(observed).toEqual(["Committed title"]);
  } finally {
    observer.sqlite.close();
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});
