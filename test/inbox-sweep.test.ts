import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { FileCardRepository, MirroredCardRepository, type CardRepository } from "../server/repositories/cards";
import { FileFeedEventRepository, MirroredFeedEventRepository } from "../server/repositories/feedEvents";
import { MirrorWriteCoordinator } from "../server/repositories/mirrorWrites";
import { FileRawSnapshotRepository, MirroredRawSnapshotRepository } from "../server/repositories/rawSnapshots";
import { FileSourceRunRepository, MirroredSourceRunRepository } from "../server/repositories/sourceRuns";
import { FileSourceRepository, MirroredSourceRepository } from "../server/repositories/sources";
import { FileSweepRepository, MirroredSweepRepository } from "../server/repositories/sweeps";
import { FileWorkspaceFeedRepository, MirroredWorkspaceFeedRepository } from "../server/repositories/workspaceFeeds";
import { createLocalRuntime } from "../server/runtime";
import { LocalSqliteStore } from "../server/sqlite";
import { AttentionStore } from "../server/store";
import {
  DEFAULT_FEED_JUDGE_LAYER,
  INBOX_JUDGE_LAYER,
  INBOX_POLICY,
  INBOX_PURPOSE,
  LEGACY_INBOX_POLICY,
  LEGACY_INBOX_PURPOSE,
  inboxRecipe,
  legacyInboxRecipe,
} from "../server/templates";
import type { Card, WorkItem } from "../shared/types";
import { inboxThreadFixture, recordInboxCollection, recordTwoPageInboxCollection } from "./support/inboxSweep";

const roots: string[] = [];

class FailingCardRepository implements CardRepository {
  failWrites = false;

  constructor(private readonly delegate: CardRepository) {}

  init(feedIds: string[]): Promise<void> { return this.delegate.init(feedIds); }
  list(feedId: string): Promise<Card[]> { return this.delegate.list(feedId); }
  get(feedId: string, cardId: string): Promise<Card> { return this.delegate.get(feedId, cardId); }
  has(feedId: string, cardId: string): Promise<boolean> { return this.delegate.has(feedId, cardId); }
  remove(feedId: string, cardId: string): Promise<void> { return this.delegate.remove(feedId, cardId); }

  write(card: Card): Promise<void> {
    if (this.failWrites) return Promise.reject(new Error("simulated migrated card upsert failure"));
    return this.delegate.write(card);
  }
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "inbox-sweep-test-"));
  roots.push(root);
  const store = new AttentionStore(root);
  await store.init();
  return { root, store, domain: new AttentionDomain(store) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Inbox Sweep defaults and migrations", () => {
  test("creates exhaustive defaults and one actionable full-thread demo card per replay", async () => {
    const { root, store, domain } = await setup();
    const inbox = await domain.inspectHowFeedWorks("inbox");
    const recipe = (inbox.sources as Array<{ content: string }>)[0].content;
    expect(recipe).toContain("Enumerate the complete authoritative Gmail Inbox on every sweep");
    expect(recipe).toContain("Maintain exactly one visible review card for every thread that is currently in the Inbox");
    expect(recipe).toContain("sweep:finalize-inbox");
    expect(await readFile(path.join(root, "feeds", "inbox", "policy.md"), "utf8")).toContain("exactly one review card");

    await domain.seedDemo("inbox");
    const cards = (await store.readWorkspace("inbox")).active.cards.filter((card) => card.id.startsWith("demo-inbox-"));
    expect(cards).toHaveLength(7);
    expect(cards.every((card) => card.proposedAction?.label && card.actions?.length)).toBe(true);
    expect(cards.every((card) => card.blocks.filter((block) => block.type === "email_thread").length === 1)).toBe(true);
  });

  test("migrates exact v0.2 seeds through the mirrored runtime once while preserving checkpoint and history", async () => {
    const { root, store } = await setup();
    const legacy = legacyInboxRecipe();
    const config = await store.readConfig("inbox");
    config.purpose = LEGACY_INBOX_PURPOSE;
    await writeFile(path.join(root, "feeds", "inbox", "feed.json"), JSON.stringify(config));
    await writeFile(path.join(root, "feeds", "inbox", "feed.md"), `# Inbox\n\n${LEGACY_INBOX_PURPOSE}\n`);
    await writeFile(path.join(root, "feeds", "inbox", "policy.md"), LEGACY_INBOX_POLICY);
    await writeFile(path.join(root, "feeds", "inbox", "prompts", "judge.md"), DEFAULT_FEED_JUDGE_LAYER);
    await writeFile(path.join(root, "feeds", "inbox", "sources.json"), JSON.stringify([legacy.recipe]));
    await writeFile(path.join(root, "feeds", "inbox", "sources", "gmail-inbox.md"), legacy.markdown);
    await writeFile(path.join(root, "feeds", "inbox", "checkpoints", "gmail-inbox.json"), JSON.stringify({ cursor: "keep-me" }));
    const setupCard = await store.readCard("inbox", "inbox-ready-to-collect");
    setupCard.history.push({ at: "2026-07-01T12:00:00.000Z", type: "user.instruction", detail: "Preserve this history." });
    await store.writeCard(setupCard);
    const eventCountBefore = (await store.readEvents("inbox")).length;
    await rm(path.join(root, "feeds", "inbox", "seed.json"));

    const first = await createLocalRuntime(root, path.join(root, "attention.db"));
    expect((await first.store.readConfig("inbox")).purpose).toBe(INBOX_PURPOSE);
    expect(await readFile(path.join(root, "feeds", "inbox", "policy.md"), "utf8")).toBe(INBOX_POLICY);
    expect(await readFile(path.join(root, "feeds", "inbox", "prompts", "judge.md"), "utf8")).toBe(INBOX_JUDGE_LAYER);
    expect(await first.store.readSourceContent("inbox", "gmail-inbox")).toBe(inboxRecipe().markdown);
    expect(await first.store.readSourceCheckpoint("inbox", "gmail-inbox")).toEqual({ cursor: "keep-me" });
    expect((await first.store.readCard("inbox", "inbox-ready-to-collect")).history.at(-1)?.detail).toBe("Preserve this history.");
    const eventCountAfter = (await first.store.readEvents("inbox")).length;
    expect(eventCountAfter).toBe(eventCountBefore + 1);
    first.sqlite.close();
    await rm(path.join(root, "feeds", "inbox", "seed.json"));

    const second = await createLocalRuntime(root, path.join(root, "attention.db"));
    expect((await second.store.readEvents("inbox")).length).toBe(eventCountAfter);
    expect((await second.store.readEvents("inbox")).filter((event) => event.type === "seed.migrated")).toHaveLength(1);
    second.sqlite.close();
  });

  test("preserves document, source-content, and metadata-only customizations", async () => {
    const { root, store } = await setup();
    const config = await store.readConfig("inbox");
    config.purpose = "My custom Inbox purpose.";
    await writeFile(path.join(root, "feeds", "inbox", "feed.json"), JSON.stringify(config));
    await writeFile(path.join(root, "feeds", "inbox", "feed.md"), "# Inbox\n\nMy custom feed document.\n");
    await writeFile(path.join(root, "feeds", "inbox", "policy.md"), "# Custom policy\n\n- Keep this.\n");
    await writeFile(path.join(root, "feeds", "inbox", "prompts", "judge.md"), "# Custom judge\n\nKeep this too.\n");
    await writeFile(path.join(root, "feeds", "inbox", "sources", "gmail-inbox.md"), "# Custom Gmail recipe\n\nKeep this source edit.\n");
    await rm(path.join(root, "feeds", "inbox", "seed.json"));
    const upgraded = new AttentionStore(root);
    await upgraded.init();
    expect((await upgraded.readConfig("inbox")).purpose).toBe("My custom Inbox purpose.");
    expect(await upgraded.readSourceContent("inbox", "gmail-inbox")).toContain("Custom Gmail recipe");

    const legacy = legacyInboxRecipe();
    await writeFile(path.join(root, "feeds", "inbox", "sources.json"), JSON.stringify([{ ...legacy.recipe, name: "My named Gmail source" }]));
    await writeFile(path.join(root, "feeds", "inbox", "sources", "gmail-inbox.md"), legacy.markdown);
    await rm(path.join(root, "feeds", "inbox", "seed.json"));
    const metadataUpgrade = new AttentionStore(root);
    await metadataUpgrade.init();
    const recipes = JSON.parse(await readFile(path.join(root, "feeds", "inbox", "sources.json"), "utf8")) as Array<{ name: string }>;
    expect(recipes[0].name).toBe("My named Gmail source");
  });

  test("imports legacy raw snapshot files into SQLite authority before serving reads", async () => {
    const { root, store } = await setup();
    const snapshot = inboxThreadFixture("legacy-thread").snapshot;
    await store.writeRawSnapshot("inbox", "legacy-run", "gmail-inbox", "snapshot-1", snapshot);

    const runtime = await createLocalRuntime(root, path.join(root, "attention.db"));
    expect(await runtime.sqlite.rawSnapshots().get("inbox", "legacy-run", "gmail-inbox", "snapshot-1")).toEqual(snapshot);
    const mirrorFile = path.join(root, "feeds", "inbox", "raw", "legacy-run", "gmail-inbox", "snapshot-1.json");
    await writeFile(mirrorFile, JSON.stringify({ ...snapshot, threadText: "tampered mirror" }));
    const originalError = console.error;
    console.error = () => {};
    try {
      expect(await runtime.store.readRawSnapshot("inbox", "legacy-run", "gmail-inbox", "snapshot-1")).toEqual(snapshot);
    } finally {
      console.error = originalError;
    }
    expect(JSON.parse(await readFile(mirrorFile, "utf8"))).toEqual(snapshot);
    await rm(path.join(root, "feeds", "inbox", "raw"), { recursive: true, force: true });
    expect(await runtime.store.readRawSnapshot("inbox", "legacy-run", "gmail-inbox", "snapshot-1")).toEqual(snapshot);
    runtime.sqlite.close();
  });
});

describe("Inbox Sweep finalization", () => {
  test("proves a two-page chain, finalizes exact coverage, and lazy-loads from SQLite authority", async () => {
    const { domain, store } = await setup();
    const first = inboxThreadFixture("thread-1");
    const second = inboxThreadFixture("thread-2");
    const result = await domain.finalizeInboxSweep(
      "inbox",
      "gmail-inbox",
      [first.snapshot, second.snapshot],
      [first.card, second.card],
      { completed: true },
      await recordTwoPageInboxCollection(domain, ["thread-1"], ["thread-2"]),
    );

    const batch = await store.readSweepBatch("inbox", result.batchId);
    expect(batch.inboxCoverage).toMatchObject({ threadCount: 2, cardCount: 2, removedCardIds: [] });
    expect(batch.inboxCoverage?.collection.pages).toHaveLength(2);
    expect(batch.inboxCoverage?.threadCardMap).toEqual([
      { threadId: "thread-1", cardId: "inbox-thread-thread-1" },
      { threadId: "thread-2", cardId: "inbox-thread-thread-2" },
    ]);
    const card = await store.readCard("inbox", "inbox-thread-thread-1");
    const email = card.blocks.find((block) => block.type === "email_thread");
    expect(email?.text).toBeUndefined();
    expect(email?.sourceSnapshot).toMatchObject({ runId: result.runId, sourceId: "gmail-inbox", snapshotId: "snapshot-1" });
    expect(await domain.readInboxThreadSnapshot("inbox", result.runId, "gmail-inbox", "snapshot-1")).toEqual({ text: first.snapshot.threadText, truncated: false });
    expect((await store.readRun("inbox", result.runId)).itemIds).toEqual(["thread-1", "thread-2"]);
    expect((await store.readFeed("inbox")).inboxStatus).toMatchObject({
      latestCollection: { id: batch.inboxCoverage?.collection.id, pages: [{ threadIds: ["thread-1"] }, { threadIds: ["thread-2"] }] },
      coverage: { threadCount: 2, cardCount: 2 },
    });
  });

  test("allows only one concurrent finalization to consume a collection receipt", async () => {
    const { domain } = await setup();
    const fixture = inboxThreadFixture("thread-race");
    const collection = await recordInboxCollection(domain, ["thread-race"]);
    const results = await Promise.allSettled([
      domain.finalizeInboxSweep("inbox", "gmail-inbox", [fixture.snapshot], [fixture.card], {}, collection),
      domain.finalizeInboxSweep("inbox", "gmail-inbox", [fixture.snapshot], [fixture.card], {}, collection),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  test("rejects broken, incomplete, duplicate, or nonterminal page ledgers without replacing the complete sweep", async () => {
    const { domain, store } = await setup();
    const first = inboxThreadFixture("thread-1");
    const completeCollection = await recordInboxCollection(domain, ["thread-1"]);
    await domain.finalizeInboxSweep("inbox", "gmail-inbox", [first.snapshot], [first.card], {}, completeCollection);
    await expect(domain.finalizeInboxSweep("inbox", "gmail-inbox", [first.snapshot], [first.card], {}, completeCollection)).rejects.toThrow("already been finalized");
    const incomplete = await domain.recordInboxPage("inbox", "gmail-inbox", undefined, undefined, null, "page-2", ["thread-1"]);
    await expect(domain.recordInboxPage("inbox", "gmail-inbox", undefined, undefined, null, null, [])).rejects.toThrow("is still active");
    await expect(domain.recordInboxPage("inbox", "gmail-inbox", incomplete.id, undefined, "wrong-token", null, [])).rejects.toThrow("does not continue");
    await expect(domain.finalizeInboxSweep("inbox", "gmail-inbox", [first.snapshot], [first.card], {}, incomplete.id)).rejects.toThrow("incomplete");
    await domain.recordInboxPage("inbox", "gmail-inbox", incomplete.id, undefined, "page-2", null, []);
    await domain.finalizeInboxSweep("inbox", "gmail-inbox", [first.snapshot], [first.card], {}, incomplete.id);
    const emptyCollection = await recordInboxCollection(domain, []);
    await expect(domain.finalizeInboxSweep("inbox", "gmail-inbox", [first.snapshot], [first.card], {}, emptyCollection)).rejects.toThrow("does not match snapshots");
    await domain.finalizeInboxSweep("inbox", "gmail-inbox", [], [], {}, emptyCollection);
    const duplicateCollection = await domain.recordInboxPage("inbox", "gmail-inbox", undefined, undefined, null, "page-2", ["thread-1"]);
    await expect(domain.recordInboxPage("inbox", "gmail-inbox", duplicateCollection.id, undefined, "page-2", null, ["thread-1"])).rejects.toThrow("repeats threadId");
    await domain.recordInboxPage("inbox", "gmail-inbox", duplicateCollection.id, undefined, "page-2", null, []);
    const latestComplete = await domain.finalizeInboxSweep("inbox", "gmail-inbox", [first.snapshot], [first.card], {}, duplicateCollection.id);
    await expect(domain.finalizeInboxSweep("inbox", "gmail-inbox", [first.snapshot, { ...first.snapshot }], [first.card, { ...first.card }], {}, await recordInboxCollection(domain, ["thread-1"]))).rejects.toThrow("duplicated");
    await expect(domain.recordSweepBatch("inbox", [])).rejects.toThrow("must use sweep:finalize-inbox");
    expect((await store.readSweepState("inbox")).currentBatchId).toBe(latestComplete.batchId);
  });

  test("audits abandonment of a bad terminal receipt and permits a clean replacement", async () => {
    const { domain, store } = await setup();
    const bad = await domain.recordInboxPage("inbox", "gmail-inbox", undefined, undefined, null, null, ["wrong-thread"]);
    const abandoned = await domain.abandonInboxCollection("inbox", "gmail-inbox", bad.id, undefined, "Provider membership changed before snapshots were fetched.");
    expect(abandoned.collectionId).toBe(bad.id);
    expect((await store.readSweepState("inbox")).inboxCollection).toBeUndefined();
    expect((await store.readEvents("inbox")).at(-1)).toMatchObject({
      type: "inbox.collection_abandoned",
      detail: { collectionId: bad.id, pageCount: 1 },
    });

    const replacement = await recordInboxCollection(domain, ["thread-1"]);
    expect(replacement).not.toBe(bad.id);
    await expect(domain.abandonInboxCollection("inbox", "gmail-inbox", bad.id, undefined, "Again")).rejects.toThrow("not found");
  });

  test("binds page receipts and finalization to the claimed recollection work", async () => {
    const { domain, store } = await setup();
    const claimed: WorkItem = {
      id: "work-recollect",
      feedId: "inbox",
      cardId: "__feed__",
      kind: "instruction",
      intent: "recollect_sources",
      instruction: "Refresh every Inbox page.",
      status: "working",
      capabilityToken: "test-token",
      startingBatchId: null,
      createdAt: "2026-07-12T12:00:00.000Z",
      updatedAt: "2026-07-12T12:00:00.000Z",
    };
    await store.writeWork(claimed);
    const fixture = inboxThreadFixture("thread-1");
    const collection = await domain.recordInboxPage("inbox", "gmail-inbox", undefined, claimed.id, null, null, ["thread-1"]);

    await expect(domain.finalizeInboxSweep("inbox", "gmail-inbox", [fixture.snapshot], [fixture.card], {}, collection.id)).rejects.toThrow("does not belong");
    const result = await domain.finalizeInboxSweep("inbox", "gmail-inbox", [fixture.snapshot], [fixture.card], {}, collection.id, claimed.id);
    expect(result.threadCount).toBe(1);
  });

  test("lets failed recollection work abandon its own receipt without weakening lineage", async () => {
    const { domain, store } = await setup();
    const work: WorkItem = {
      id: "work-failed-recollect",
      feedId: "inbox",
      cardId: "__feed__",
      kind: "instruction",
      intent: "recollect_sources",
      instruction: "Refresh every Inbox page.",
      status: "working",
      capabilityToken: "failed-recollect-token",
      startingBatchId: null,
      createdAt: "2026-07-12T12:00:00.000Z",
      updatedAt: "2026-07-12T12:00:00.000Z",
    };
    await store.writeWork(work);
    const collection = await domain.recordInboxPage("inbox", "gmail-inbox", undefined, work.id, null, null, ["thread-1"]);
    await domain.failWork("inbox", work.id, work.capabilityToken, "Provider fetch failed after the page receipt.");

    await domain.abandonInboxCollection("inbox", "gmail-inbox", collection.id, work.id, "Discard the incomplete failed recollection.");
    expect((await store.readSweepState("inbox")).inboxCollection).toBeUndefined();
    expect(await recordInboxCollection(domain, ["thread-1"])).not.toBe(collection.id);
  });

  test("blocks refresh during a verified mutation and preserves cleanup-only reconciliation", async () => {
    const { domain, store } = await setup();
    const fixture = inboxThreadFixture("thread-action");
    fixture.card.blocks.splice(1, 0, { id: "draft", type: "editable_text", value: "Confirmed for Tuesday." });
    fixture.card.proposedAction = {
      label: "Send reply",
      instruction: "Send the exact approved reply.",
      artifactBlockId: "draft",
      externalMutation: true,
      mailboxPolicy: "reply_from_source",
    };
    fixture.card.actions = [{
      id: "send-reply",
      label: "Send reply",
      behavior: "approve_action",
      instruction: "Send the exact approved reply.",
      artifactBlockId: "draft",
      externalMutation: true,
      mailboxPolicy: "reply_from_source",
    }];
    await domain.finalizeInboxSweep("inbox", "gmail-inbox", [fixture.snapshot], [fixture.card], {}, await recordInboxCollection(domain, ["thread-action"]));
    await domain.bindFeed("inbox", "thread-inbox-action");
    const approved = await domain.runCardAction("inbox", fixture.card.id, "send-reply");
    const claimed = await domain.claimWork("inbox", "thread-inbox-action") as WorkItem;
    await domain.verifyApprovedAction("inbox", approved.id, claimed.capabilityToken, "owner@example.com");
    const refreshCollection = await recordInboxCollection(domain, ["thread-action"]);
    await expect(domain.finalizeInboxSweep("inbox", "gmail-inbox", [fixture.snapshot], [fixture.card], {}, refreshCollection)).rejects.toThrow("verified external work");

    await domain.completeWork("inbox", approved.id, claimed.capabilityToken, {
      response: "The reply was sent once.",
      postAction: {
        cleanup: { status: "blocked", detail: "The provider still exposes the thread in Inbox." },
        disposition: "review",
      },
    });
    await expect(domain.finalizeInboxSweep("inbox", "gmail-inbox", [fixture.snapshot], [fixture.card], {}, refreshCollection)).rejects.toThrow("not found");
    const postMutationCollection = await recordInboxCollection(domain, ["thread-action"]);
    await domain.finalizeInboxSweep("inbox", "gmail-inbox", [fixture.snapshot], [fixture.card], {}, postMutationCollection);
    expect((await store.readWork("inbox", approved.id)).status).toBe("approved_blocked");
    expect((await store.readCard("inbox", fixture.card.id)).status).toBe("approved_blocked");
    const emptyCollection = await recordInboxCollection(domain, []);
    await expect(domain.finalizeInboxSweep("inbox", "gmail-inbox", [], [], {}, emptyCollection)).rejects.toThrow("cleanup-only reconciliation");

    await domain.reconcileApprovedWork("inbox", approved.id, claimed.capabilityToken, {
      response: "Retried cleanup only; the original reply was not sent again.",
      postAction: {
        cleanup: { status: "completed", detail: "A fresh provider read found no remaining Inbox row." },
        disposition: "done",
      },
    });
    expect((await store.readCard("inbox", fixture.card.id)).status).toBe("done");
    await expect(domain.finalizeInboxSweep("inbox", "gmail-inbox", [], [], {}, emptyCollection)).rejects.toThrow("not found");
    await domain.finalizeInboxSweep("inbox", "gmail-inbox", [], [], {}, await recordInboxCollection(domain, []));
  });

  test("invalidates a collection that predates successful Inbox cleanup", async () => {
    const { domain, store } = await setup();
    const fixture = inboxThreadFixture("thread-cleanup");
    await domain.finalizeInboxSweep("inbox", "gmail-inbox", [fixture.snapshot], [fixture.card], {}, await recordInboxCollection(domain, ["thread-cleanup"]));
    await domain.bindFeed("inbox", "thread-inbox-cleanup");
    const cleanup = await domain.dismissCard("inbox", fixture.card.id);
    const claimed = await domain.claimWork("inbox", "thread-inbox-cleanup") as WorkItem;
    await domain.verifyApprovedAction("inbox", cleanup.id, claimed.capabilityToken);
    const staleCollection = await recordInboxCollection(domain, ["thread-cleanup"]);

    await domain.completeWork("inbox", cleanup.id, claimed.capabilityToken, { response: "Archived the thread.", done: true });
    expect((await store.readEvents("inbox")).at(-2)?.type).toBe("inbox.collection_invalidated");
    await expect(domain.finalizeInboxSweep("inbox", "gmail-inbox", [fixture.snapshot], [fixture.card], {}, staleCollection)).rejects.toThrow("not found");
    await domain.finalizeInboxSweep("inbox", "gmail-inbox", [], [], {}, await recordInboxCollection(domain, []));
  });

  test("reconciles removed threads and enforces deterministic identity", async () => {
    const { domain, store } = await setup();
    const first = inboxThreadFixture("thread-1");
    const second = inboxThreadFixture("thread-2");
    await domain.finalizeInboxSweep("inbox", "gmail-inbox", [first.snapshot, second.snapshot], [first.card, second.card], {}, await recordInboxCollection(domain, ["thread-1", "thread-2"]));
    const next = await domain.finalizeInboxSweep("inbox", "gmail-inbox", [first.snapshot], [first.card], {}, await recordInboxCollection(domain, ["thread-1"]));
    expect(next.removedCardIds).toEqual([second.card.id]);
    expect((await store.readCard("inbox", second.card.id)).status).toBe("done");
    const remapped = inboxThreadFixture("thread-1", "different-card");
    await expect(domain.finalizeInboxSweep("inbox", "gmail-inbox", [remapped.snapshot], [remapped.card], {}, await recordInboxCollection(domain, ["thread-1"]))).rejects.toThrow("deterministic id");
  });

  test("keeps oversized bodies out of browser state and bounds thread responses", async () => {
    const { domain, store } = await setup();
    const fixture = inboxThreadFixture("large-thread");
    fixture.snapshot.threadText = `From: sender@example.com\nTo: owner@example.com\nSubject: Large thread\n\n${"x".repeat(250_000)}`;
    fixture.card.blocks = fixture.card.blocks.map((block) => block.type === "email_thread" ? { ...block, text: fixture.snapshot.threadText } : block);
    const result = await domain.finalizeInboxSweep("inbox", "gmail-inbox", [fixture.snapshot], [fixture.card], {}, await recordInboxCollection(domain, ["large-thread"]));
    expect(JSON.stringify(await store.readWorkspace("inbox")).includes("x".repeat(1000))).toBe(false);
    const thread = await domain.readInboxThreadSnapshot("inbox", result.runId, "gmail-inbox", "snapshot-1");
    expect(thread.truncated).toBe(true);
    expect(thread.text.length).toBeLessThan(201_000);
  });

  test("keeps SQLite source authority readable when the filesystem mirror fails after commit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "inbox-mirror-failure-"));
    roots.push(root);
    const runtime = await createLocalRuntime(root, path.join(root, "attention.db"));
    const domain = new AttentionDomain(runtime.store);
    const rawPath = path.join(root, "feeds", "inbox", "raw");
    await rm(rawPath, { recursive: true, force: true });
    await writeFile(rawPath, "not-a-directory");
    const fixture = inboxThreadFixture("thread-1");
    const originalError = console.error;
    console.error = () => {};
    let result;
    try {
      result = await domain.finalizeInboxSweep("inbox", "gmail-inbox", [fixture.snapshot], [fixture.card], {}, await recordInboxCollection(domain, ["thread-1"]));
    } finally {
      console.error = originalError;
    }
    expect((await runtime.store.readSweepState("inbox")).currentBatchId).toBe(result.batchId);
    expect(await domain.readInboxThreadSnapshot("inbox", result.runId, "gmail-inbox", "snapshot-1")).toEqual({ text: fixture.snapshot.threadText, truncated: false });
    runtime.sqlite.close();
    const sweepStateMirror = path.join(root, "feeds", "inbox", "sweep-state.json");
    await rm(sweepStateMirror, { force: true });
    await mkdir(sweepStateMirror);

    console.error = () => {};
    const restarted = await (async () => {
      try {
        return await createLocalRuntime(root, path.join(root, "attention.db"));
      } finally {
        console.error = originalError;
      }
    })();
    const restartedDomain = new AttentionDomain(restarted.store);
    expect(await restartedDomain.readInboxThreadSnapshot("inbox", result.runId, "gmail-inbox", "snapshot-1")).toEqual({ text: fixture.snapshot.threadText, truncated: false });
    restarted.sqlite.close();
  });

  test("rolls back SQLite and all source mirrors when finalization fails before commit", async () => {
    const { root } = await setup();
    const sqlite = new LocalSqliteStore(path.join(root, "fault-attention.db"));
    await sqlite.init();
    const mirrorWrites = new MirrorWriteCoordinator();
    const failingCards = new FailingCardRepository(sqlite.cards());
    const store = new AttentionStore(root, {
      cards: new MirroredCardRepository(failingCards, new FileCardRepository(root), mirrorWrites),
      events: new MirroredFeedEventRepository(sqlite.feedEvents(), new FileFeedEventRepository(root), mirrorWrites),
      rawSnapshots: new MirroredRawSnapshotRepository(sqlite.rawSnapshots(), new FileRawSnapshotRepository(root), mirrorWrites),
      sourceRuns: new MirroredSourceRunRepository(sqlite.sourceRuns(), new FileSourceRunRepository(root), mirrorWrites),
      sources: new MirroredSourceRepository(sqlite.sources(), new FileSourceRepository(root), mirrorWrites),
      sweeps: new MirroredSweepRepository(sqlite.sweeps(), new FileSweepRepository(root), mirrorWrites),
      workspaceFeeds: new MirroredWorkspaceFeedRepository(sqlite.workspaceFeeds(), new FileWorkspaceFeedRepository(path.join(root, "workspace.json"))),
      runAtomic: (callback) => mirrorWrites.transaction(() => sqlite.transaction(callback)),
    });
    await store.init();
    const domain = new AttentionDomain(store);
    const first = inboxThreadFixture("thread-1");
    const complete = await domain.finalizeInboxSweep("inbox", "gmail-inbox", [first.snapshot], [first.card], { cursor: "complete" }, await recordInboxCollection(domain, ["thread-1"]));
    const runFilesBefore = await readdir(path.join(root, "feeds", "inbox", "runs"));
    const rawBefore = await readdir(path.join(root, "feeds", "inbox", "raw"));
    const checkpointBefore = await readFile(path.join(root, "feeds", "inbox", "checkpoints", "gmail-inbox.json"), "utf8");
    const secondCollection = await recordInboxCollection(domain, ["thread-2"]);
    const authorityBefore = {
      cards: await sqlite.cards().list("inbox"),
      events: await sqlite.feedEvents().list("inbox"),
      raw: await sqlite.rawSnapshots().list("inbox"),
      runs: await sqlite.sourceRuns().list("inbox"),
    };
    failingCards.failWrites = true;
    const second = inboxThreadFixture("thread-2");
    await expect(domain.finalizeInboxSweep("inbox", "gmail-inbox", [second.snapshot], [second.card], { cursor: "must-not-advance" }, secondCollection)).rejects.toThrow("simulated migrated card upsert failure");
    expect((await store.readSweepState("inbox")).currentBatchId).toBe(complete.batchId);
    expect(await readdir(path.join(root, "feeds", "inbox", "runs"))).toEqual(runFilesBefore);
    expect(await readdir(path.join(root, "feeds", "inbox", "raw"))).toEqual(rawBefore);
    expect(await readFile(path.join(root, "feeds", "inbox", "checkpoints", "gmail-inbox.json"), "utf8")).toBe(checkpointBefore);
    expect(await sqlite.cards().list("inbox")).toEqual(authorityBefore.cards);
    expect(await sqlite.feedEvents().list("inbox")).toEqual(authorityBefore.events);
    expect(await sqlite.rawSnapshots().list("inbox")).toEqual(authorityBefore.raw);
    expect(await sqlite.sourceRuns().list("inbox")).toEqual(authorityBefore.runs);
    sqlite.close();
  });

  test("stales in-flight work when its source thread leaves the Inbox", async () => {
    const { domain, store } = await setup();
    const fixture = inboxThreadFixture("thread-1");
    await domain.finalizeInboxSweep("inbox", "gmail-inbox", [fixture.snapshot], [fixture.card], {}, await recordInboxCollection(domain, ["thread-1"]));
    await domain.bindFeed("inbox", "thread-inbox");
    const queued = await domain.queueInstruction("inbox", fixture.card.id, "Draft a response.");
    const claimed = await domain.claimWork("inbox", "thread-inbox") as WorkItem;

    await domain.finalizeInboxSweep("inbox", "gmail-inbox", [], [], {}, await recordInboxCollection(domain, []));

    expect((await store.readWork("inbox", queued.id)).status).toBe("stale");
    expect((await store.readCard("inbox", fixture.card.id)).status).toBe("done");
    await expect(domain.completeWork("inbox", queued.id, claimed.capabilityToken, { response: "Old draft." })).rejects.toThrow("not currently claimed");
  });

  test("invalidates approved actions and queued routine batches when source lineage refreshes", async () => {
    const { domain, store } = await setup();
    const fixture = inboxThreadFixture("thread-1");
    const routineFixture = inboxThreadFixture("thread-2");
    fixture.card.proposedAction = { ...fixture.card.proposedAction, externalMutation: true };
    await domain.finalizeInboxSweep("inbox", "gmail-inbox", [fixture.snapshot, routineFixture.snapshot], [fixture.card, routineFixture.card], {}, await recordInboxCollection(domain, ["thread-1", "thread-2"]));
    await domain.bindFeed("inbox", "thread-inbox");
    const approved = await domain.approveAction("inbox", fixture.card.id);
    const claimed = await domain.claimWork("inbox", "thread-inbox") as WorkItem;
    expect(claimed.id).toBe(approved.id);

    await domain.finalizeInboxSweep("inbox", "gmail-inbox", [fixture.snapshot, routineFixture.snapshot], [fixture.card, routineFixture.card], {}, await recordInboxCollection(domain, ["thread-1", "thread-2"]));
    expect((await store.readWork("inbox", approved.id)).status).toBe("stale");
    await expect(domain.verifyApprovedAction("inbox", approved.id, claimed.capabilityToken)).rejects.toThrow("must be claimed");

    await domain.upsertRoutineActionGroup("inbox", {
      id: "routine-refresh",
      label: "Archive thread",
      summary: "One exact cleanup proposal.",
      proposedAction: { label: "Archive", instruction: "Archive the listed thread.", externalMutation: true },
      items: [{ id: "thread-2", cardId: routineFixture.card.id, title: routineFixture.card.title, reason: "No reply is needed." }],
    });
    const routineWork = await domain.approveRoutineActionGroup("inbox", "routine-refresh");
    await domain.finalizeInboxSweep("inbox", "gmail-inbox", [fixture.snapshot, routineFixture.snapshot], [fixture.card, routineFixture.card], {}, await recordInboxCollection(domain, ["thread-1", "thread-2"]));
    expect((await store.readWork("inbox", routineWork.id)).status).toBe("stale");
    expect((await store.readRoutineActionGroup("inbox", "routine-refresh")).status).toBe("stale");
  });

  test("rejects dual inline/reference blocks and stale generic snapshot references", async () => {
    const { domain, store } = await setup();
    const fixture = inboxThreadFixture("thread-1");
    await domain.finalizeInboxSweep("inbox", "gmail-inbox", [fixture.snapshot], [fixture.card], {}, await recordInboxCollection(domain, ["thread-1"]));
    const card = await store.readCard("inbox", fixture.card.id);
    const email = card.blocks.find((block) => block.type === "email_thread");
    if (!email?.sourceSnapshot) throw new Error("Expected source snapshot");

    const dual = JSON.parse(JSON.stringify(card.blocks)) as Array<Record<string, unknown>>;
    const dualEmail = dual.find((block) => block.type === "email_thread");
    if (dualEmail) dualEmail.text = fixture.snapshot.threadText;
    await expect(domain.upsertCard("inbox", { ...card, blocks: dual as Card["blocks"] })).rejects.toThrow("exactly one");

    const stale = card.blocks.map((block) => block.type === "email_thread"
      ? { ...block, sourceSnapshot: { ...block.sourceSnapshot, snapshotId: "snapshot-999" } }
      : block);
    await expect(domain.upsertCard("inbox", { ...card, blocks: stale })).rejects.toThrow("does not match source item");
    await expect(domain.upsertCard("inbox", { ...card, sourceItemId: "other-thread" })).rejects.toThrow("deterministic Inbox identity");

    const duplicateActions = { ...card, actions: [{ id: "same", label: "One", behavior: "default_cleanup" as const }, { id: "same", label: "Two", behavior: "default_cleanup" as const }] };
    await expect(domain.upsertCard("inbox", duplicateActions)).rejects.toThrow("duplicated");
    await expect(domain.upsertCard("inbox", { ...card, actions: [{ id: "proposed-action", label: "Spoof", behavior: "default_cleanup" }] as Card["actions"] })).rejects.toThrow("reserved by Tend");
    await expect(domain.upsertCard("inbox", { ...card, actions: [{ id: "bad-shape", label: 42, behavior: "approve_action", externalMutation: "yes" }] as unknown as Card["actions"] })).rejects.toThrow("label is required");
    await expect(domain.upsertCard("inbox", { ...card, actions: [{ id: "missing-instruction", label: "Send", behavior: "approve_action" }] as Card["actions"] })).rejects.toThrow("instruction is required");

    const misplaced = card.blocks.map((block) => block.type === "memo"
      ? { ...block, sourceSnapshot: email.sourceSnapshot }
      : block);
    await expect(domain.upsertCard("inbox", { ...card, blocks: misplaced as Card["blocks"] })).rejects.toThrow("only for an email_thread");
  });
});
