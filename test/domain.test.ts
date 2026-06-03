import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { formatWorkClaimOutput, formatWorkListOutput } from "../server/operator";
import { FileCardRepository, MirroredCardRepository } from "../server/repositories/cards";
import { FileFeedEventRepository, MirroredFeedEventRepository } from "../server/repositories/feedEvents";
import { FileRoutineActionGroupRepository, MirroredRoutineActionGroupRepository } from "../server/repositories/routineActionGroups";
import { FileSourceRunRepository, MirroredSourceRunRepository } from "../server/repositories/sourceRuns";
import { FileSweepRepository, MirroredSweepRepository } from "../server/repositories/sweeps";
import { FileWorkItemRepository, MirroredWorkItemRepository } from "../server/repositories/workItems";
import { FileWorkspaceFeedRepository, MirroredWorkspaceFeedRepository } from "../server/repositories/workspaceFeeds";
import { LocalSqliteStore } from "../server/sqlite";
import { AttentionStore } from "../server/store";
import type { WorkItem } from "../src/types";
import { closestTarget, preferredTarget } from "../src/state/voiceTarget";

const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "attention-test-"));
  roots.push(root);
  const store = new AttentionStore(root);
  await store.init();
  return { root, store, domain: new AttentionDomain(store) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("feed thread operator handshake", () => {
  test("offers a compound pass when a work list or claim reaches idle", () => {
    const idleList = formatWorkListOutput("hiring", []);
    const idleClaim = formatWorkClaimOutput("hiring", null);

    expect(idleList).toMatchObject({
      status: "idle",
      next: "offer_compound_if_sweep_finished",
    });
    expect(idleClaim).toEqual(idleList);
    expect(idleClaim.compound.ifApproved).toContain("learning:request --feed hiring");
    expect(idleClaim.message).toContain("Want me to compound what I learned from this sweep?");
  });

  test("keeps pending work output unchanged", () => {
    const work = { id: "work-1" } as WorkItem;
    expect(formatWorkListOutput("inbox", [work])).toEqual([work]);
    expect(formatWorkClaimOutput("inbox", work)).toBe(work);
  });
});

describe("filesystem workspace", () => {
  test("creates real Inbox and Company defaults with inspectable recipes and setup cards", async () => {
    const { store, domain } = await setup();
    const workspace = await store.readWorkspace();
    expect(workspace.feeds.map((feed) => feed.id)).toEqual(["inbox", "company-attention"]);
    expect(workspace.active.sources[0].id).toBe("gmail-inbox");
    expect(workspace.active.cards[0].id).toBe("inbox-ready-to-collect");
    expect(workspace.dictation.status).toBe("not_checked");
    const company = await domain.inspectHowFeedWorks("company-attention");
    expect((company.sources as Array<{ content: string }>)[0].content).toContain("Return no card rather than padding");
  });

  test("lets Codex detect Monologue and persist its configured recording shortcut", async () => {
    const { root, domain, store } = await setup();
    const appPath = path.join(root, "Monologue.app");
    const settingsPath = path.join(root, "jottle_settings.json");
    await mkdir(appPath);
    await writeFile(settingsPath, JSON.stringify({ hotkey: { modifiers: { modifiers: [{ rightOption: {} }] } } }));
    const capability = await domain.detectLocalMonologue({ appPath, settingsPath });
    expect(capability.status).toBe("detected_configured");
    expect(capability.activationCode).toBe("AltRight");
    expect((await store.readWorkspace()).dictation.activationLabel).toBe("Right Option");
  });

  test("keeps raw snapshots immutable and stores run checkpoints separately", async () => {
    const { root, domain, store } = await setup();
    const batchId = await domain.recordSweepBatch("inbox", []);
    const run = await domain.recordSourceRun("inbox", "gmail-inbox", [{ threadId: "gmail-1", subject: "Hello" }], [{ decision: "keep" }], { cursor: "gmail-1" });
    await expect(domain.store.writeRawSnapshot("inbox", run, "gmail-inbox", "snapshot-1", { changed: true })).rejects.toThrow("immutable");
    const checkpoint = JSON.parse(await readFile(path.join(root, "feeds", "inbox", "checkpoints", "gmail-inbox.json"), "utf8"));
    expect(checkpoint.cursor).toBe("gmail-1");
    expect((await store.readSweepState("inbox")).currentBatchId).toBe(batchId);
  });

  test("refuses to record raw evidence for an unconfigured source recipe", async () => {
    const { root, domain } = await setup();
    await expect(domain.recordSourceRun("inbox", "not-an-authorized-recipe", [{ threadId: "nope" }], [], { cursor: "nope" })).rejects.toThrow("Source recipe not found");
    await expect(readFile(path.join(root, "feeds", "inbox", "checkpoints", "not-an-authorized-recipe.json"), "utf8")).rejects.toThrow();
  });

  test("creates a feed and source recipe from plain English", async () => {
    const { root, domain, store } = await setup();
    const feed = await domain.createFeedFromBrief("Model Vibe Check\nNotice meaningful changes in which models are winning for different kinds of work.", "thread-models");
    expect(feed.id).toBe("model-vibe-check");
    expect((await store.readThread(feed.id)).homeThreadId).toBe("thread-models");
    expect((await store.readCard(feed.id, "guided-source-setup")).title).toContain("Teach Model Vibe Check");
    const source = await domain.addSourceFromBrief(feed.id, "Read my recent Chronicle notes about model usage.");
    expect(source.id).toBe("read-my-recent-chronicle-notes-about-model-usage");
    expect(await readFile(path.join(root, "feeds", feed.id, "sources", source.filename), "utf8")).toContain("content hashes");
  });

  test("archives an extra feed without deleting its durable state", async () => {
    const { root, domain, store } = await setup();
    await domain.createFeedFromBrief("Research Watch\nTrack a narrow research topic.", "thread-research");
    await domain.archiveFeed("research-watch");
    expect((await store.readWorkspace()).feeds.some((feed) => feed.id === "research-watch")).toBe(false);
    const [archived] = await readdir(path.join(root, "archived-feeds"));
    expect(await readFile(path.join(root, "archived-feeds", archived, "feed.json"), "utf8")).toContain("Research Watch");
    await expect(domain.archiveFeed("inbox")).rejects.toThrow("Default feeds");
  });

  test("migrates active feed membership from workspace.json into SQLite and mirrors future changes", async () => {
    const { root, domain: fileDomain } = await setup();
    await fileDomain.createFeedFromBrief("Research Watch\nTrack a narrow research topic.", "thread-research");

    const sqlite = new LocalSqliteStore(path.join(root, "attention.db"));
    await sqlite.init();
    const store = new AttentionStore(root, {
      workspaceFeeds: new MirroredWorkspaceFeedRepository(
        sqlite.workspaceFeeds(),
        new FileWorkspaceFeedRepository(path.join(root, "workspace.json")),
      ),
    });
    await store.init();
    const domain = new AttentionDomain(store);

    expect((await store.readWorkspace("research-watch")).feeds.map((feed) => feed.id)).toContain("research-watch");
    expect(await sqlite.workspaceFeeds().listFeedIds()).toContain("research-watch");

    await domain.createFeedFromBrief("Model Vibe Check\nNotice meaningful model usage changes.", "thread-models");
    expect(await sqlite.workspaceFeeds().listFeedIds()).toContain("model-vibe-check");
    expect(JSON.parse(await readFile(path.join(root, "workspace.json"), "utf8")).feedIds).toContain("model-vibe-check");

    await domain.archiveFeed("model-vibe-check");
    expect(await sqlite.workspaceFeeds().listFeedIds()).not.toContain("model-vibe-check");
    expect(JSON.parse(await readFile(path.join(root, "workspace.json"), "utf8")).feedIds).not.toContain("model-vibe-check");
    sqlite.close();
  });

  test("migrates feed events from JSONL into SQLite and mirrors new audit events", async () => {
    const { root, domain: fileDomain, store: fileStore } = await setup();
    await fileDomain.bindFeed("inbox", "thread-inbox");
    const fileEvents = await fileStore.readEvents("inbox");
    expect(fileEvents.map((event) => event.type)).toContain("thread.bound");

    const sqlite = new LocalSqliteStore(path.join(root, "attention.db"));
    await sqlite.init();
    const store = new AttentionStore(root, {
      events: new MirroredFeedEventRepository(
        sqlite.feedEvents(),
        new FileFeedEventRepository(root),
      ),
      workspaceFeeds: new MirroredWorkspaceFeedRepository(
        sqlite.workspaceFeeds(),
        new FileWorkspaceFeedRepository(path.join(root, "workspace.json")),
      ),
    });
    await store.init();
    const domain = new AttentionDomain(store);

    expect((await sqlite.feedEvents().list("inbox")).map((event) => event.type)).toContain("thread.bound");

    await domain.proposeHeartbeat("inbox", "Every 30 minutes");
    expect((await sqlite.feedEvents().list("inbox")).map((event) => event.type)).toContain("heartbeat.proposed");
    const mirrored = (await readFile(path.join(root, "feeds", "inbox", "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(mirrored.map((event) => event.type)).toContain("heartbeat.proposed");
    sqlite.close();
  });

  test("migrates queued work from JSON files into SQLite and mirrors updates", async () => {
    const { root, domain: fileDomain } = await setup();
    const queued = await fileDomain.queueFeedInstruction("inbox", "Check the queue migration.");

    const sqlite = new LocalSqliteStore(path.join(root, "attention.db"));
    await sqlite.init();
    const store = new AttentionStore(root, {
      workItems: new MirroredWorkItemRepository(
        sqlite.workItems(),
        new FileWorkItemRepository(root),
      ),
      workspaceFeeds: new MirroredWorkspaceFeedRepository(
        sqlite.workspaceFeeds(),
        new FileWorkspaceFeedRepository(path.join(root, "workspace.json")),
      ),
    });
    await store.init();

    expect((await sqlite.workItems().list("inbox")).map((work) => work.id)).toContain(queued.id);

    const work = await store.readWork("inbox", queued.id);
    work.status = "cancelled";
    work.error = "Cancelled by migration test.";
    await store.writeWork(work);

    expect((await sqlite.workItems().get("inbox", queued.id)).status).toBe("cancelled");
    expect(JSON.parse(await readFile(path.join(root, "feeds", "inbox", "work", `${queued.id}.json`), "utf8")).status).toBe("cancelled");
    sqlite.close();
  });

  test("migrates cards from JSON files into SQLite and mirrors updates", async () => {
    const { root } = await setup();

    const sqlite = new LocalSqliteStore(path.join(root, "attention.db"));
    await sqlite.init();
    const store = new AttentionStore(root, {
      cards: new MirroredCardRepository(
        sqlite.cards(),
        new FileCardRepository(root),
      ),
      workspaceFeeds: new MirroredWorkspaceFeedRepository(
        sqlite.workspaceFeeds(),
        new FileWorkspaceFeedRepository(path.join(root, "workspace.json")),
      ),
    });
    await store.init();

    expect((await sqlite.cards().list("inbox")).map((card) => card.id)).toContain("inbox-ready-to-collect");

    const card = await store.readCard("inbox", "inbox-ready-to-collect");
    card.status = "done";
    card.history.push({ at: card.updatedAt, type: "migration.test" });
    await store.writeCard(card);

    expect((await sqlite.cards().get("inbox", card.id)).status).toBe("done");
    expect(JSON.parse(await readFile(path.join(root, "feeds", "inbox", "cards", `${card.id}.json`), "utf8")).status).toBe("done");
    sqlite.close();
  });

  test("migrates routine action groups from JSON files into SQLite and mirrors updates", async () => {
    const { root, domain: fileDomain } = await setup();
    const group = await fileDomain.upsertRoutineActionGroup("inbox", {
      id: "likely-archive",
      label: "Likely archive",
      summary: "Low-attention threads with an obvious shared cleanup.",
      proposedAction: { label: "Archive all", instruction: "Reread and archive each listed Gmail thread.", externalMutation: true },
      items: [{ id: "setup-noise", cardId: "inbox-ready-to-collect", title: "Routine notice", reason: "No reply or decision is needed." }],
    });

    const sqlite = new LocalSqliteStore(path.join(root, "attention.db"));
    await sqlite.init();
    const store = new AttentionStore(root, {
      cards: new MirroredCardRepository(
        sqlite.cards(),
        new FileCardRepository(root),
      ),
      routineActionGroups: new MirroredRoutineActionGroupRepository(
        sqlite.routineActionGroups(),
        new FileRoutineActionGroupRepository(root),
      ),
      workspaceFeeds: new MirroredWorkspaceFeedRepository(
        sqlite.workspaceFeeds(),
        new FileWorkspaceFeedRepository(path.join(root, "workspace.json")),
      ),
    });
    await store.init();

    expect((await sqlite.routineActionGroups().list("inbox")).map((item) => item.id)).toContain(group.id);

    const migrated = await store.readRoutineActionGroup("inbox", group.id);
    migrated.status = "failed";
    migrated.error = "Failed by migration test.";
    await store.writeRoutineActionGroup(migrated);

    expect((await sqlite.routineActionGroups().get("inbox", group.id)).status).toBe("failed");
    expect(JSON.parse(await readFile(path.join(root, "feeds", "inbox", "routine-actions", `${group.id}.json`), "utf8")).status).toBe("failed");
    sqlite.close();
  });

  test("migrates source runs from JSON files into SQLite and mirrors updates", async () => {
    const { root, domain: fileDomain } = await setup();
    const runId = await fileDomain.recordSourceRun("inbox", "gmail-inbox", [{ threadId: "gmail-1", subject: "Hello" }], [{ decision: "keep" }], { cursor: "gmail-1" });

    const sqlite = new LocalSqliteStore(path.join(root, "attention.db"));
    await sqlite.init();
    const store = new AttentionStore(root, {
      sourceRuns: new MirroredSourceRunRepository(
        sqlite.sourceRuns(),
        new FileSourceRunRepository(root),
      ),
      workspaceFeeds: new MirroredWorkspaceFeedRepository(
        sqlite.workspaceFeeds(),
        new FileWorkspaceFeedRepository(path.join(root, "workspace.json")),
      ),
    });
    await store.init();

    expect((await sqlite.sourceRuns().list("inbox")).map((run) => run.id)).toContain(runId);

    const run = await store.readRun("inbox", runId);
    await store.writeRun({ ...run, judgments: [{ decision: "keep" }, { decision: "promote" }] });

    expect((await sqlite.sourceRuns().get("inbox", runId)).judgments).toHaveLength(2);
    expect(JSON.parse(await readFile(path.join(root, "feeds", "inbox", "runs", `${runId}.json`), "utf8")).judgments).toHaveLength(2);
    sqlite.close();
  });

  test("migrates sweep state and artifacts from JSON files into SQLite and mirrors updates", async () => {
    const { root, store: fileStore } = await setup();
    const createdAt = new Date().toISOString();
    await fileStore.writeSweepBatch({ id: "batch-old", feedId: "inbox", sourceRunIds: [], createdAt });
    await fileStore.writeSweepFeedback({
      id: "feedback-old",
      feedId: "inbox",
      batchId: "batch-old",
      instruction: "Reorder this sweep.",
      visibleCardIds: ["inbox-ready-to-collect"],
      orderedCardIds: ["inbox-ready-to-collect"],
      removedCardIds: [],
      createdAt,
    });
    await fileStore.writeSweepState("inbox", { currentBatchId: "batch-old", lastFeedbackId: "feedback-old", recollectionOffered: true, statusMessage: "Needs source search" });

    const sqlite = new LocalSqliteStore(path.join(root, "attention.db"));
    await sqlite.init();
    const store = new AttentionStore(root, {
      sweeps: new MirroredSweepRepository(
        sqlite.sweeps(),
        new FileSweepRepository(root),
      ),
      workspaceFeeds: new MirroredWorkspaceFeedRepository(
        sqlite.workspaceFeeds(),
        new FileWorkspaceFeedRepository(path.join(root, "workspace.json")),
      ),
    });
    await store.init();

    expect((await sqlite.sweeps().readState("inbox")).lastFeedbackId).toBe("feedback-old");
    expect((await sqlite.sweeps().getBatch("inbox", "batch-old")).id).toBe("batch-old");
    expect((await sqlite.sweeps().getFeedback("inbox", "feedback-old")).instruction).toBe("Reorder this sweep.");

    await store.writeSweepState("inbox", { currentBatchId: "batch-old", lastFeedbackId: null, recollectionOffered: false, statusMessage: null });
    const trace = await store.readSweepFeedback("inbox", "feedback-old");
    await store.writeSweepFeedback({ ...trace, rejudgedAt: createdAt });

    expect((await sqlite.sweeps().readState("inbox")).lastFeedbackId).toBeNull();
    expect((await sqlite.sweeps().getFeedback("inbox", "feedback-old")).rejudgedAt).toBe(createdAt);
    expect(JSON.parse(await readFile(path.join(root, "feeds", "inbox", "sweep-state.json"), "utf8")).lastFeedbackId).toBeNull();
    expect(JSON.parse(await readFile(path.join(root, "feeds", "inbox", "sweep-feedback", "feedback-old.json"), "utf8")).rejudgedAt).toBe(createdAt);
    sqlite.close();
  });

  test("normalizes escaped newlines and removes a source recipe without deleting evidence files", async () => {
    const { root, domain, store } = await setup();
    const source = await domain.addSourceFromBrief("company-attention", "Local pulse artifact\\nRead the current ignored JSON batch.");
    expect(source.id).toBe("local-pulse-artifact");
    await domain.removeSource("company-attention", source.id);
    expect((await store.readFeed("company-attention")).sources.some((item) => item.id === source.id)).toBe(false);
    expect(await readFile(path.join(root, "feeds", "company-attention", "sources", source.filename), "utf8")).toContain("Read the current");
  });

  test("edits feed recipes and allowlisted global prompt files from the workspace", async () => {
    const { root, domain } = await setup();
    await domain.updateSourceRecipe("inbox", "gmail-inbox", "# Gmail inbox\n\nInspect the authoritative inbox carefully.");
    expect(await readFile(path.join(root, "feeds", "inbox", "sources", "gmail-inbox.md"), "utf8")).toContain("authoritative inbox");
    await domain.updateGlobalPolicy("# Global policy\n\n- Keep the bar high.");
    await domain.updateGlobalPrompt("judge.md", "# Judge\n\nKeep only meaningful changes.");
    const workspace = await domain.inspectGlobalPromptWorkspace();
    expect(workspace.globalPolicy).toContain("Keep the bar high");
    expect(workspace.prompts.find((prompt) => prompt.name === "judge.md")?.content).toContain("meaningful changes");
    await expect(domain.updateGlobalPrompt("../feed.md", "Nope")).rejects.toThrow("Unknown global prompt");
  });

  test("lets Codex upsert a structured card without adding server code", async () => {
    const { store, domain } = await setup();
    await domain.upsertCard("company-attention", {
      id: "company-real-signal",
      title: "A real company signal",
      why: "It changes a decision.",
      blocks: [{ id: "brief", type: "memo", label: "Brief", text: "Concrete evidence belongs here." }],
    });
    const card = await store.readCard("company-attention", "company-real-signal");
    expect(card.blocks[0].type).toBe("memo");
    expect(card.status).toBe("to_review_new");
  });

  test("queues a feed-level instruction when an empty feed has no active card", async () => {
    const { domain } = await setup();
    const feed = await domain.createFeedFromBrief("Research Watch\nTrack a narrow research topic.", "thread-research");
    const work = await domain.queueFeedInstruction(feed.id, "Also inspect my saved reading notes.");
    expect(work.cardId).toBe("__feed__");
    expect(work.kind).toBe("instruction");
    expect((await domain.claimWork(feed.id, "thread-research"))?.id).toBe(work.id);
  });
});

describe("thread-owned work drain", () => {
  test("queues, claims, completes, and buffers finished work for the next pass", async () => {
    const { store, domain } = await setup();
    await domain.bindFeed("inbox", "thread-inbox");
    const queued = await domain.queueInstruction("inbox", "inbox-ready-to-collect", "Collect the first real sweep.");
    expect((await store.readCard("inbox", "inbox-ready-to-collect")).status).toBe("queued");
    const claimed = await domain.claimWork("inbox", "thread-inbox");
    expect(claimed?.id).toBe(queued.id);
    expect((await store.readCard("inbox", "inbox-ready-to-collect")).status).toBe("working");
    await domain.completeWork("inbox", queued.id, queued.capabilityToken, { response: "Collection complete." });
    const workspace = await store.readWorkspace("inbox");
    expect(workspace.active.cards.find((card) => card.id === "inbox-ready-to-collect")?.status).toBe("to_review_updated");
    expect(workspace.active.readyNextPass).toBe(1);
    await domain.beginNextPass("inbox");
    expect((await store.readConfig("inbox")).currentPass).toBe(2);
  });

  test("cancels a stray queued instruction before Codex starts and restores the card", async () => {
    const { store, domain } = await setup();
    const queued = await domain.queueInstruction("inbox", "inbox-ready-to-collect", "Stray dictated text.");
    expect((await store.readCard("inbox", "inbox-ready-to-collect")).status).toBe("queued");
    expect((await domain.cancelQueuedWork("inbox", queued.id, "Accidental dictation.")).status).toBe("cancelled");
    expect((await store.readCard("inbox", "inbox-ready-to-collect")).status).toBe("to_review_updated");
    await expect(domain.claimWork("inbox", "thread-inbox")).rejects.toThrow("no bound home thread");
  });

  test("requires the home thread unless cross-feed work is explicit", async () => {
    const { domain } = await setup();
    await domain.bindFeed("company-attention", "thread-company");
    await domain.queueInstruction("company-attention", "company-source-confirmation", "Refine the sources.");
    await expect(domain.claimWork("company-attention", "thread-other")).rejects.toThrow("does not own");
    expect((await domain.claimWork("company-attention", "thread-other", true))?.status).toBe("working");
  });

  test("replays the active claim rather than claiming a second item", async () => {
    const { domain } = await setup();
    await domain.bindFeed("company-attention", "thread-company");
    const first = await domain.queueInstruction("company-attention", "company-source-confirmation", "Inspect source options.");
    await domain.seedDemo();
    await domain.queueInstruction("company-attention", "demo-company-models", "Draft the feed recipe.");
    expect((await domain.claimWork("company-attention", "thread-company"))?.id).toBe(first.id);
    expect((await domain.claimWork("company-attention", "thread-company"))?.id).toBe(first.id);
  });
});

describe("approval, learning, and heartbeat safety", () => {
  test("collapses concurrent approvals for the same visible action snapshot", async () => {
    const { store, domain } = await setup();
    await domain.seedDemo();
    const [first, second] = await Promise.all([
      domain.approveAction("inbox", "demo-inbox-partnership"),
      domain.approveAction("inbox", "demo-inbox-partnership"),
    ]);
    expect(second.id).toBe(first.id);
    expect((await store.readFeed("inbox")).work.filter((work) => work.kind === "execute_approved_action" && (work.status === "queued" || work.status === "working"))).toHaveLength(1);
  });

  test("refuses approved external work when the editable artifact changed", async () => {
    const { store, domain } = await setup();
    await domain.upsertCard("inbox", {
      id: "external-reply-safety-fixture",
      title: "Send this reply.",
      why: "Approval must bind to the exact visible artifact.",
      sourceMailbox: "dan@every.to",
      blocks: [{ id: "draft", type: "editable_text", label: "Draft reply", value: "Original draft.", editable: true }],
      proposedAction: { label: "Send this reply", instruction: "Send the exact currently approved reply.", artifactBlockId: "draft", externalMutation: true, mailboxPolicy: "reply_from_source" },
    });
    await domain.bindFeed("inbox", "thread-inbox");
    const work = await domain.approveAction("inbox", "external-reply-safety-fixture");
    await domain.claimWork("inbox", "thread-inbox");
    expect((await domain.verifyApprovedAction("inbox", work.id, work.capabilityToken, "dan@every.to")).action.label).toBe("Send this reply");
    await domain.updateBlock("inbox", "external-reply-safety-fixture", "draft", "A different draft.");
    await expect(domain.verifyApprovedAction("inbox", work.id, work.capabilityToken)).rejects.toThrow("Approval stale");
    await expect(domain.completeWork("inbox", work.id, work.capabilityToken, { response: "Sent." })).rejects.toThrow("Approval stale");
    expect((await store.readWork("inbox", work.id)).status).toBe("stale");
    expect((await store.readCard("inbox", "external-reply-safety-fixture")).status).toBe("to_review_updated");
  });

  test("persists editable-text changes even when an agent omitted the redundant editable flag", async () => {
    const { store, domain } = await setup();
    await domain.upsertCard("inbox", {
      id: "agent-draft-without-flag",
      title: "Review this reply.",
      why: "The visible draft should be editable.",
      blocks: [{ id: "draft", type: "editable_text", label: "Suggested reply", value: "Original draft." }],
    });
    await domain.updateBlock("inbox", "agent-draft-without-flag", "draft", "Visible revised draft.");
    expect((await store.readCard("inbox", "agent-draft-without-flag")).blocks[0]).toMatchObject({
      type: "editable_text",
      value: "Visible revised draft.",
      editable: true,
    });
  });

  test("refuses Inbox reply approval without the mailbox that received the source email", async () => {
    const { domain } = await setup();
    await domain.upsertCard("inbox", {
      id: "reply-without-source-mailbox",
      title: "Send this reply.",
      why: "Mailbox identity must be known before approval.",
      blocks: [{ id: "draft", type: "editable_text", label: "Draft reply", value: "Hello.", editable: true }],
      actions: [
        { id: "send-reply", label: "Send reply", behavior: "approve_action", instruction: "Send the exact currently approved reply.", artifactBlockId: "draft", externalMutation: true, variant: "primary" },
      ],
    });
    await expect(domain.runCardAction("inbox", "reply-without-source-mailbox", "send-reply")).rejects.toThrow("mailbox that received");
  });

  test("requires the authenticated Gmail mailbox to match before an Inbox reply can complete", async () => {
    const { domain } = await setup();
    await domain.bindFeed("inbox", "thread-inbox");
    await domain.upsertCard("inbox", {
      id: "reply-with-source-mailbox",
      title: "Send this reply.",
      why: "The connector account must match the source mailbox.",
      sourceMailbox: "dan@every.to",
      blocks: [{ id: "draft", type: "editable_text", label: "Draft reply", value: "Hello.", editable: true }],
      actions: [
        { id: "send-reply", label: "Send reply", behavior: "approve_action", instruction: "Send the exact currently approved reply.", artifactBlockId: "draft", externalMutation: true, variant: "primary" },
      ],
    });
    const work = await domain.runCardAction("inbox", "reply-with-source-mailbox", "send-reply");
    await domain.claimWork("inbox", "thread-inbox");
    await expect(domain.completeWork("inbox", work.id, work.capabilityToken, { response: "Sent." })).rejects.toThrow("must pass action:verify");
    await expect(domain.verifyApprovedAction("inbox", work.id, work.capabilityToken)).rejects.toThrow("requires the authenticated Gmail mailbox");
    await expect(domain.verifyApprovedAction("inbox", work.id, work.capabilityToken, "dshipper@gmail.com")).rejects.toThrow("mailbox mismatch");
    expect((await domain.verifyApprovedAction("inbox", work.id, work.capabilityToken, "DAN@EVERY.TO")).verifiedMailbox).toBe("dan@every.to");
    expect((await domain.completeWork("inbox", work.id, work.capabilityToken, { response: "Sent." })).status).toBe("completed");
  });

  test("keeps an approved blocked send out of review and retries only the unchanged snapshot", async () => {
    const { store, domain } = await setup();
    await domain.bindFeed("inbox", "thread-inbox");
    await domain.upsertCard("inbox", {
      id: "blocked-send",
      title: "Send this exact reply.",
      why: "The user approved the visible artifact.",
      sourceMailbox: "dan@every.to",
      blocks: [{ id: "draft", type: "editable_text", label: "Draft reply", value: "Approved draft.", editable: true }],
      actions: [
        { id: "send-reply", label: "Send reply", behavior: "approve_action", instruction: "Send the exact currently approved reply.", artifactBlockId: "draft", externalMutation: true, variant: "primary" },
      ],
    });
    const approved = await domain.runCardAction("inbox", "blocked-send", "send-reply");
    await domain.claimWork("inbox", "thread-inbox");
    await domain.blockApprovedWork("inbox", approved.id, approved.capabilityToken, "Connector temporarily refused the approved send.");
    expect((await store.readWork("inbox", approved.id)).status).toBe("approved_blocked");
    expect((await store.readCard("inbox", "blocked-send")).status).toBe("approved_blocked");
    const retry = await domain.retryApprovedWork("inbox", approved.id);
    expect(retry.status).toBe("queued");
    expect((await store.readCard("inbox", "blocked-send")).status).toBe("queued");
    const claimed = await domain.claimWork("inbox", "thread-inbox");
    expect(claimed?.id).toBe(approved.id);
    expect((await domain.verifyApprovedAction("inbox", approved.id, claimed!.capabilityToken, "dan@every.to")).artifact?.value).toBe("Approved draft.");
  });

  test("moves a completed approved action to done without an extra worker flag", async () => {
    const { store, domain } = await setup();
    await domain.bindFeed("inbox", "thread-inbox");
    await domain.upsertCard("inbox", {
      id: "approved-and-completed",
      title: "Archive this handled notice.",
      why: "The approved action should close the card when it succeeds.",
      blocks: [{ id: "brief", type: "memo", text: "Already handled." }],
      actions: [
        { id: "archive", label: "Archive", behavior: "approve_action", instruction: "Archive the handled notice.", variant: "primary" },
      ],
    });
    const approved = await domain.runCardAction("inbox", "approved-and-completed", "archive");
    await domain.claimWork("inbox", "thread-inbox");
    await domain.verifyApprovedAction("inbox", approved.id, approved.capabilityToken);
    await domain.completeWork("inbox", approved.id, approved.capabilityToken, { response: "Archived." });
    expect((await store.readCard("inbox", "approved-and-completed")).status).toBe("done");
  });

  test("routes card-specific buttons through preparation, exact approval, and default-cleanup semantics", async () => {
    const { store, domain } = await setup();
    await domain.bindFeed("inbox", "thread-inbox");
    await domain.upsertCard("inbox", {
      id: "custom-actions",
      title: "Choose the right email response.",
      why: "The reply direction is not obvious yet.",
      sourceMailbox: "dan@every.to",
      blocks: [{ id: "draft", type: "editable_text", label: "Suggested reply", value: "Current exact draft.", editable: true }],
      actions: [
        { id: "draft-pass", label: "Draft a pass", behavior: "queue_instruction", instruction: "Draft a polite pass for review.", shortcut: "p" },
        { id: "send-reply", label: "Send reply", behavior: "approve_action", instruction: "Send the exact currently approved reply.", artifactBlockId: "draft", externalMutation: true, variant: "primary", shortcut: "s" },
        { id: "archive", label: "Archive", behavior: "default_cleanup", shortcut: "x" },
      ],
    });

    const preparation = await domain.runCardAction("inbox", "custom-actions", "draft-pass");
    expect(preparation.kind).toBe("instruction");
    expect(preparation.instruction).toBe("Draft a polite pass for review.");
    expect((await domain.claimWork("inbox", "thread-inbox"))?.id).toBe(preparation.id);
    await domain.completeWork("inbox", preparation.id, preparation.capabilityToken, { response: "Prepared a pass for review." });

    const send = await domain.runCardAction("inbox", "custom-actions", "send-reply");
    expect(send.kind).toBe("execute_approved_action");
    expect(send.cardActionId).toBe("send-reply");
    expect((await domain.claimWork("inbox", "thread-inbox"))?.id).toBe(send.id);
    expect((await domain.verifyApprovedAction("inbox", send.id, send.capabilityToken, "dan@every.to")).action.label).toBe("Send reply");
    await domain.updateBlock("inbox", "custom-actions", "draft", "Changed after approval.");
    await expect(domain.verifyApprovedAction("inbox", send.id, send.capabilityToken)).rejects.toThrow("Approval stale");

    await domain.upsertCard("inbox", {
      id: "custom-cleanup",
      title: "Archive this FYI.",
      why: "No response is needed.",
      blocks: [{ id: "brief", type: "memo", text: "A low-attention notification." }],
      actions: [{ id: "archive", label: "Archive", behavior: "default_cleanup", shortcut: "x" }],
    });
    expect((await domain.runCardAction("inbox", "custom-cleanup", "archive")).kind).toBe("default_cleanup");
    expect((await store.readCard("inbox", "custom-cleanup")).status).toBe("queued");
  });

  test("queues default cleanup for Codex and allows a brief undo", async () => {
    const { store, domain } = await setup();
    const cleanup = await domain.dismissCard("inbox", "inbox-ready-to-collect");
    expect(cleanup.kind).toBe("default_cleanup");
    expect((await store.readCard("inbox", "inbox-ready-to-collect")).status).toBe("queued");
    await domain.undoDismiss("inbox", "inbox-ready-to-collect");
    expect((await store.readWork("inbox", cleanup.id)).status).toBe("cancelled");
    expect((await store.readCard("inbox", "inbox-ready-to-collect")).status).toBe("to_review_updated");
    await domain.bindFeed("inbox", "thread-inbox");
    const secondCleanup = await domain.dismissCard("inbox", "inbox-ready-to-collect");
    await domain.claimWork("inbox", "thread-inbox");
    expect((await domain.verifyApprovedAction("inbox", secondCleanup.id, secondCleanup.capabilityToken)).action.instruction).toBe("Archive the email thread.");
    await domain.completeWork("inbox", secondCleanup.id, secondCleanup.capabilityToken, { response: "Archived the authoritative email thread." });
    expect((await store.readCard("inbox", "inbox-ready-to-collect")).status).toBe("done");
  });

  test("queues one exact approval for a conservative routine-action group and records a collapsed audit", async () => {
    const { store, domain } = await setup();
    await domain.bindFeed("inbox", "thread-inbox");
    const group = await domain.upsertRoutineActionGroup("inbox", {
      id: "likely-archive",
      label: "Likely archive",
      summary: "Low-attention threads with an obvious shared cleanup.",
      proposedAction: { label: "Archive all", instruction: "Reread and archive each listed Gmail thread.", externalMutation: true },
      items: [{ id: "setup-noise", cardId: "inbox-ready-to-collect", title: "Routine notice", reason: "No reply or decision is needed." }],
    });
    expect((await store.readCard("inbox", "inbox-ready-to-collect")).routineActionGroupId).toBe(group.id);
    const [first, second] = await Promise.all([
      domain.approveRoutineActionGroup("inbox", group.id),
      domain.approveRoutineActionGroup("inbox", group.id),
    ]);
    expect(second.id).toBe(first.id);
    expect((await domain.claimWork("inbox", "thread-inbox"))?.id).toBe(first.id);
    expect((await store.readRoutineActionGroup("inbox", group.id)).status).toBe("working");
    expect((await domain.verifyApprovedAction("inbox", first.id, first.capabilityToken)).action.label).toBe("Archive all");
    await domain.completeWork("inbox", first.id, first.capabilityToken, { response: "Archived the authoritative threads." });
    expect((await store.readRoutineActionGroup("inbox", group.id)).status).toBe("completed");
    const card = await store.readCard("inbox", "inbox-ready-to-collect");
    expect(card.status).toBe("done");
    expect(card.routineActionGroupId).toBe(group.id);
    await domain.upsertCard("inbox", {
      id: card.id,
      status: "to_review_updated",
      title: "A newly relevant update",
      why: "The source thread changed after the completed cleanup.",
      blocks: [{ id: "brief", type: "memo", text: "Review this fresh source delta." }],
    });
    expect((await store.readCard("inbox", card.id)).routineActionGroupId).toBeUndefined();
  });

  test("restores a cancelled routine batch and rejects a batch whose visible snapshot changed after approval", async () => {
    const { store, domain } = await setup();
    await domain.bindFeed("inbox", "thread-inbox");
    await domain.upsertRoutineActionGroup("inbox", {
      id: "likely-archive",
      label: "Likely archive",
      summary: "Low-attention threads with an obvious shared cleanup.",
      proposedAction: { label: "Archive all", instruction: "Reread and archive each listed Gmail thread.", externalMutation: true },
      items: [{ id: "setup-noise", cardId: "inbox-ready-to-collect", title: "Routine notice", reason: "No reply or decision is needed." }],
    });
    const cancelled = await domain.approveRoutineActionGroup("inbox", "likely-archive");
    await domain.cancelQueuedWork("inbox", cancelled.id, "User changed their mind.");
    expect((await store.readRoutineActionGroup("inbox", "likely-archive")).status).toBe("proposed");
    expect((await store.readCard("inbox", "inbox-ready-to-collect")).routineActionGroupId).toBe("likely-archive");

    const work = await domain.approveRoutineActionGroup("inbox", "likely-archive");
    expect((await domain.claimWork("inbox", "thread-inbox"))?.id).toBe(work.id);
    const changed = await store.readRoutineActionGroup("inbox", "likely-archive");
    changed.summary = "The visible approved snapshot changed.";
    await store.writeRoutineActionGroup(changed);
    await expect(domain.verifyApprovedAction("inbox", work.id, work.capabilityToken)).rejects.toThrow("Approval stale");
    await expect(domain.completeWork("inbox", work.id, work.capabilityToken, { response: "Archived." })).rejects.toThrow("Approval stale");
    expect((await store.readRoutineActionGroup("inbox", "likely-archive")).status).toBe("stale");
    const card = await store.readCard("inbox", "inbox-ready-to-collect");
    expect(card.status).toBe("to_review_updated");
    expect(card.routineActionGroupId).toBeUndefined();
  });

  test("returns routine-batch items to full review when execution cannot safely proceed", async () => {
    const { store, domain } = await setup();
    await domain.bindFeed("inbox", "thread-inbox");
    await domain.upsertRoutineActionGroup("inbox", {
      id: "likely-archive",
      label: "Likely archive",
      summary: "Low-attention threads with an obvious shared cleanup.",
      proposedAction: { label: "Archive all", instruction: "Reread and archive each listed Gmail thread.", externalMutation: true },
      items: [{ id: "setup-noise", cardId: "inbox-ready-to-collect", title: "Routine notice", reason: "No reply or decision is needed." }],
    });
    const work = await domain.approveRoutineActionGroup("inbox", "likely-archive");
    expect((await domain.claimWork("inbox", "thread-inbox"))?.id).toBe(work.id);
    await domain.failWork("inbox", work.id, work.capabilityToken, "One source item changed before cleanup.");
    expect((await store.readRoutineActionGroup("inbox", "likely-archive")).status).toBe("failed");
    const card = await store.readCard("inbox", "inbox-ready-to-collect");
    expect(card.status).toBe("to_review_updated");
    expect(card.routineActionGroupId).toBeUndefined();
  });

  test("collapses concurrent dismiss cleanup and rejects changed cleanup configuration", async () => {
    const { store, domain } = await setup();
    await domain.bindFeed("inbox", "thread-inbox");
    const [first, second] = await Promise.all([
      domain.dismissCard("inbox", "inbox-ready-to-collect"),
      domain.dismissCard("inbox", "inbox-ready-to-collect"),
    ]);
    expect(second.id).toBe(first.id);
    expect((await store.readFeed("inbox")).work.filter((work) => work.kind === "default_cleanup" && (work.status === "queued" || work.status === "working"))).toHaveLength(1);
    await domain.claimWork("inbox", "thread-inbox");
    const config = await store.readConfig("inbox");
    config.defaultCleanup = "Archive the email thread and add a label.";
    await store.writeConfig(config);
    await expect(domain.verifyApprovedAction("inbox", first.id, first.capabilityToken)).rejects.toThrow("Approval stale");
    await expect(domain.completeWork("inbox", first.id, first.capabilityToken, { response: "Archived." })).rejects.toThrow("Approval stale");
    expect((await store.readWork("inbox", first.id)).status).toBe("stale");
  });

  test("quarantines legacy mutation work without an approval digest and continues draining", async () => {
    const { store, domain } = await setup();
    await domain.bindFeed("inbox", "thread-inbox");
    const legacy = await domain.dismissCard("inbox", "inbox-ready-to-collect");
    legacy.approvalDigest = undefined;
    await store.writeWork(legacy);
    const next = await domain.queueFeedInstruction("inbox", "Process the next safe item.");

    expect((await domain.claimWork("inbox", "thread-inbox"))?.id).toBe(next.id);
    expect((await store.readWork("inbox", legacy.id)).status).toBe("stale");
    expect((await store.readCard("inbox", "inbox-ready-to-collect")).status).toBe("to_review_updated");
  });

  test("quarantines claimed legacy approval work and continues draining", async () => {
    const { store, domain } = await setup();
    await domain.bindFeed("inbox", "thread-inbox");
    await domain.upsertCard("inbox", {
      id: "legacy-approved-action",
      title: "Publish the approved artifact.",
      why: "Legacy claimed work must not wedge newer safe work.",
      blocks: [{ id: "brief", type: "memo", text: "The exact visible artifact." }],
      proposedAction: { label: "Publish", instruction: "Publish the exact approved artifact.", externalMutation: true },
    });
    const legacy = await domain.approveAction("inbox", "legacy-approved-action");
    legacy.approvalDigest = undefined;
    legacy.status = "working";
    await store.writeWork(legacy);
    const next = await domain.queueFeedInstruction("inbox", "Process the next safe item.");

    expect((await domain.claimWork("inbox", "thread-inbox"))?.id).toBe(next.id);
    expect((await store.readWork("inbox", legacy.id)).status).toBe("stale");
    expect((await store.readCard("inbox", "legacy-approved-action")).status).toBe("to_review_updated");
  });

  test("quarantines legacy routine batches and restores their cards for review", async () => {
    const { store, domain } = await setup();
    await domain.bindFeed("inbox", "thread-inbox");
    await domain.upsertRoutineActionGroup("inbox", {
      id: "legacy-routine-cleanup",
      label: "Likely archive",
      summary: "Low-attention threads with an obvious shared cleanup.",
      proposedAction: { label: "Archive all", instruction: "Reread and archive each listed Gmail thread.", externalMutation: true },
      items: [{ id: "setup-noise", cardId: "inbox-ready-to-collect", title: "Routine notice", reason: "No reply or decision is needed." }],
    });
    const legacy = await domain.approveRoutineActionGroup("inbox", "legacy-routine-cleanup");
    legacy.approvalDigest = undefined;
    await store.writeWork(legacy);
    const next = await domain.queueFeedInstruction("inbox", "Process the next safe item.");

    expect((await domain.claimWork("inbox", "thread-inbox"))?.id).toBe(next.id);
    expect((await store.readWork("inbox", legacy.id)).status).toBe("stale");
    expect((await store.readRoutineActionGroup("inbox", "legacy-routine-cleanup")).status).toBe("stale");
    const card = await store.readCard("inbox", "inbox-ready-to-collect");
    expect(card.status).toBe("to_review_updated");
    expect(card.routineActionGroupId).toBeUndefined();
  });

  test("clears visual QA demo cards without touching setup cards", async () => {
    const { store, domain } = await setup();
    await domain.seedDemo();
    await domain.clearDemo();
    expect((await store.readFeed("inbox")).cards.map((card) => card.id)).toEqual(["inbox-ready-to-collect"]);
    expect((await store.readFeed("company-attention")).cards.map((card) => card.id)).toEqual(["company-source-confirmation"]);
  });

  test("applies and reverts compact policy revisions", async () => {
    const { store, domain } = await setup();
    const original = (await store.readFeed("inbox")).policy;
    const revision = await domain.applyPolicyRevision("inbox", "# Inbox policy\n\n- Prefer replies only when an answer is actually required.", "Learned from a corrected card.", "micro_learning");
    expect((await store.readFeed("inbox")).policy).toContain("actually required");
    await store.revertPolicy("inbox", revision.id);
    expect((await store.readFeed("inbox")).policy).toBe(original);
  });

  test("records a proposed heartbeat before installation", async () => {
    const { domain } = await setup();
    await expect(domain.recordHeartbeatInstalled("inbox", "auto-1")).rejects.toThrow("proposed");
    expect((await domain.proposeHeartbeat("inbox", "Every 30 minutes on weekdays")).heartbeat.status).toBe("proposed");
    expect((await domain.recordHeartbeatInstalled("inbox", "auto-1")).heartbeat.status).toBe("installed");
  });

  test("preserves a thread binding when heartbeat setup happens concurrently", async () => {
    const { root, store, domain } = await setup();
    const secondProcessDomain = new AttentionDomain(new AttentionStore(root));
    await Promise.all([
      domain.bindFeed("inbox", "thread-inbox"),
      secondProcessDomain.proposeHeartbeat("inbox", "Every 30 minutes"),
    ]);
    const thread = await store.readThread("inbox");
    expect(thread.homeThreadId).toBe("thread-inbox");
    expect(thread.heartbeat.status).toBe("proposed");
  });
});

describe("scoped persistent voice dock routing", () => {
  test("returns to the narrowest live dock target after an automatic fallback", () => {
    const sweep = { kind: "sweep" as const, feedId: "inbox", batchId: "batch-current" };
    const card = { kind: "card" as const, feedId: "inbox", cardId: "card-current" };
    const broadLadder = [sweep, { kind: "feed" as const, feedId: "inbox" }, { kind: "attention" as const }];
    const narrowLadder = [card, ...broadLadder];

    expect(preferredTarget(sweep, narrowLadder, false)).toEqual(card);
    expect(preferredTarget(sweep, narrowLadder, true)).toEqual(sweep);
  });

  test("rebinds stale client card and sweep targets to the live sweep rung", () => {
    const sweep = { kind: "sweep" as const, feedId: "inbox", batchId: "batch-current" };
    const ladder = [sweep, { kind: "feed" as const, feedId: "inbox" }, { kind: "attention" as const }];
    expect(closestTarget({ kind: "card", feedId: "inbox", cardId: "missing-card" }, ladder)).toEqual(sweep);
    expect(closestTarget({ kind: "sweep", feedId: "inbox", batchId: "batch-old" }, ladder)).toEqual(sweep);
  });

  test("falls back from stale object targets to the nearest valid parent scope", async () => {
    const { domain } = await setup();
    const batchId = await domain.recordSweepBatch("inbox", []);
    expect(await domain.store.validateVoiceTarget({ kind: "card", feedId: "inbox", cardId: "missing-card" })).toEqual({ kind: "sweep", feedId: "inbox", batchId });
    expect(await domain.store.validateVoiceTarget({ kind: "source_recipe", feedId: "inbox", sourceId: "missing-source" })).toEqual({ kind: "feed", feedId: "inbox" });
    expect(await domain.store.validateVoiceTarget({ kind: "prompt_layer", feedId: "missing-feed", promptId: "judge.md" })).toEqual({ kind: "attention" });
    expect(await domain.store.validateVoiceTarget({ kind: "global_prompt", promptId: "../nope.md" })).toEqual({ kind: "attention" });
  });

  test("queues card speech through the existing scoped work queue", async () => {
    const { store, domain } = await setup();
    const result = await domain.submitVoiceInstruction("inbox", { kind: "card", feedId: "inbox", cardId: "inbox-ready-to-collect" }, "Collect the first real sweep.");
    expect(result.kind).toBe("scoped_work");
    expect(result.work.cardId).toBe("inbox-ready-to-collect");
    expect(result.work.kind).toBe("scoped_instruction");
    expect(result.work.target).toEqual({ kind: "card", feedId: "inbox", cardId: "inbox-ready-to-collect" });
    expect((await store.readCard("inbox", "inbox-ready-to-collect")).status).toBe("queued");
    expect((await store.readEvents("inbox")).map((event) => event.type)).toContain("voice.instruction_submitted");
  });

  test("queues sweep feedback for Codex and only changes cards after an explicit rejudgment write-back", async () => {
    const { store, domain } = await setup();
    await domain.seedDemo();
    await domain.bindFeed("company-attention", "thread-company");
    const result = await domain.submitVoiceInstruction("company-attention", { kind: "sweep", feedId: "company-attention" }, "These are too infrastructure-heavy. I want product taste and evidence.");
    expect(result.kind).toBe("scoped_work");
    if (!("trace" in result)) throw new Error("Expected sweep trace");
    expect(result.trace.visibleCardIds.length).toBeGreaterThan(1);
    expect(result.trace.removedCardIds).toEqual([]);
    let feed = await store.readFeed("company-attention");
    expect(feed.sweep.recollectionOffered).toBe(false);
    expect(feed.work).toHaveLength(1);
    expect(feed.work[0].intent).toBe("sweep_rejudge");
    expect(feed.work[0].feedbackId).toBe(result.trace.id);
    expect(feed.work[0].startingBatchId).toBe(null);
    expect(feed.cards.filter((card) => card.sweep?.hidden)).toHaveLength(0);

    const removedCardIds = ["demo-company-q3"];
    const orderedCardIds = result.trace.visibleCardIds.filter((cardId) => !removedCardIds.includes(cardId));
    expect((await domain.claimWork("company-attention", "thread-company"))?.id).toBe(result.work.id);
    await domain.recordSweepRejudgment("company-attention", result.trace.id, orderedCardIds, removedCardIds);
    feed = await store.readFeed("company-attention");
    expect(feed.sweep.recollectionOffered).toBe(true);
    expect(feed.cards.filter((card) => card.sweep?.hidden).map((card) => card.id)).toEqual(removedCardIds);
    expect((await store.readEvents("company-attention")).map((event) => event.type)).toEqual(expect.arrayContaining([
      "sweep.feedback_recorded",
      "sweep.rejudged",
      "sweep.recollection_offered",
    ]));
  });

  test("collapses concurrent recollection requests into one queued item", async () => {
    const { store, domain } = await setup();
    await domain.seedDemo();
    await domain.bindFeed("company-attention", "thread-company");
    const result = await domain.submitVoiceInstruction("company-attention", { kind: "sweep", feedId: "company-attention" }, "Search again after this correction.");
    if (!("trace" in result)) throw new Error("Expected sweep trace");
    expect((await domain.claimWork("company-attention", "thread-company"))?.id).toBe(result.work.id);
    await domain.recordSweepRejudgment("company-attention", result.trace.id, result.trace.visibleCardIds, []);
    await domain.completeWork("company-attention", result.work.id, result.work.capabilityToken, { response: "Rejudged." });
    const [first, second] = await Promise.all([
      domain.requestSweepRecollection("company-attention"),
      domain.requestSweepRecollection("company-attention"),
    ]);
    expect(second.id).toBe(first.id);
    expect((await store.readFeed("company-attention")).work.filter((work) => work.intent === "recollect_sources")).toHaveLength(1);
  });

  test("restores sweep state when queued feedback is cancelled or claimed feedback fails", async () => {
    const { store, domain } = await setup();
    await domain.seedDemo();
    const previous = await store.readSweepState("company-attention");
    const cancelled = await domain.submitVoiceInstruction("company-attention", { kind: "sweep", feedId: "company-attention" }, "Cancel this correction.");
    if (!("trace" in cancelled)) throw new Error("Expected sweep trace");
    await domain.cancelQueuedWork("company-attention", cancelled.work.id, "Undid dictated feedback.");
    expect(await store.readSweepState("company-attention")).toEqual(previous);
    await expect(domain.recordSweepRejudgment("company-attention", cancelled.trace.id, cancelled.trace.visibleCardIds, [])).rejects.toThrow("must be claimed");

    await domain.bindFeed("company-attention", "thread-company");
    const failed = await domain.submitVoiceInstruction("company-attention", { kind: "sweep", feedId: "company-attention" }, "This review will fail.");
    if (!("trace" in failed)) throw new Error("Expected sweep trace");
    expect((await domain.claimWork("company-attention", "thread-company"))?.id).toBe(failed.work.id);
    await domain.failWork("company-attention", failed.work.id, failed.work.capabilityToken, "Could not rejudge.");
    expect(await store.readSweepState("company-attention")).toEqual(previous);
    await expect(domain.recordSweepRejudgment("company-attention", failed.trace.id, failed.trace.visibleCardIds, [])).rejects.toThrow("must be claimed");
    expect((await store.readEvents("company-attention")).map((event) => event.type)).toEqual(expect.arrayContaining([
      "sweep.feedback_cancelled",
      "sweep.feedback_failed",
    ]));
  });

  test("does not revive abandoned sweep feedback while unwinding stacked corrections", async () => {
    const { store, domain } = await setup();
    await domain.seedDemo();
    const previous = await store.readSweepState("company-attention");
    const first = await domain.submitVoiceInstruction("company-attention", { kind: "sweep", feedId: "company-attention" }, "First pending correction.");
    const second = await domain.submitVoiceInstruction("company-attention", { kind: "sweep", feedId: "company-attention" }, "Second pending correction.");
    if (!("trace" in first) || !("trace" in second)) throw new Error("Expected sweep traces");
    await domain.cancelQueuedWork("company-attention", first.work.id, "Cancel first.");
    expect((await store.readSweepState("company-attention")).lastFeedbackId).toBe(second.trace.id);
    await domain.cancelQueuedWork("company-attention", second.work.id, "Cancel second.");
    expect(await store.readSweepState("company-attention")).toEqual(previous);

    await domain.bindFeed("company-attention", "thread-company");
    const failed = await domain.submitVoiceInstruction("company-attention", { kind: "sweep", feedId: "company-attention" }, "Claimed correction that fails.");
    if (!("trace" in failed)) throw new Error("Expected sweep trace");
    expect((await domain.claimWork("company-attention", "thread-company"))?.id).toBe(failed.work.id);
    const pending = await domain.submitVoiceInstruction("company-attention", { kind: "sweep", feedId: "company-attention" }, "Newer pending correction.");
    if (!("trace" in pending)) throw new Error("Expected sweep trace");
    await domain.failWork("company-attention", failed.work.id, failed.work.capabilityToken, "Could not rejudge.");
    expect((await store.readSweepState("company-attention")).lastFeedbackId).toBe(pending.trace.id);
    await domain.cancelQueuedWork("company-attention", pending.work.id, "Undo newer correction.");
    expect(await store.readSweepState("company-attention")).toEqual(previous);
  });

  test("rejects a rejudgment write-back after a newer sweep batch becomes active", async () => {
    const { domain } = await setup();
    await domain.seedDemo();
    await domain.bindFeed("company-attention", "thread-company");
    const firstRun = await domain.recordSourceRun("company-attention", "company-attention", [], [], { cursor: "first" });
    await domain.recordSweepBatch("company-attention", [firstRun]);
    const result = await domain.submitVoiceInstruction("company-attention", { kind: "sweep", feedId: "company-attention" }, "Prefer more product evidence.");
    if (!("trace" in result)) throw new Error("Expected sweep trace");
    expect((await domain.claimWork("company-attention", "thread-company"))?.id).toBe(result.work.id);
    const secondRun = await domain.recordSourceRun("company-attention", "company-attention", [], [], { cursor: "second" });
    await domain.recordSweepBatch("company-attention", [secondRun]);
    await expect(domain.recordSweepRejudgment("company-attention", result.trace.id, result.trace.visibleCardIds, [])).rejects.toThrow("newer batch");
  });

  test("rejects pre-batch feedback after the first sweep batch becomes active", async () => {
    const { domain } = await setup();
    await domain.seedDemo();
    await domain.bindFeed("company-attention", "thread-company");
    const result = await domain.submitVoiceInstruction("company-attention", { kind: "sweep", feedId: "company-attention" }, "Prefer more product evidence.");
    if (!("trace" in result)) throw new Error("Expected sweep trace");
    expect((await domain.claimWork("company-attention", "thread-company"))?.id).toBe(result.work.id);
    const run = await domain.recordSourceRun("company-attention", "company-attention", [], [], { cursor: "first" });
    await domain.recordSweepBatch("company-attention", [run]);
    await expect(domain.recordSweepRejudgment("company-attention", result.trace.id, result.trace.visibleCardIds, [])).rejects.toThrow("newer batch");
  });

  test("requires sweep write-backs before specialized feed work can complete and reopens failed recollection", async () => {
    const { store, domain } = await setup();
    await domain.seedDemo();
    await domain.bindFeed("company-attention", "thread-company");
    const result = await domain.submitVoiceInstruction("company-attention", { kind: "sweep", feedId: "company-attention" }, "Prefer more product evidence.");
    if (!("trace" in result)) throw new Error("Expected sweep trace");

    const claimedRejudge = await domain.claimWork("company-attention", "thread-company");
    expect(claimedRejudge?.id).toBe(result.work.id);
    await expect(domain.completeWork("company-attention", result.work.id, result.work.capabilityToken, { response: "Rejudged." })).rejects.toThrow("must be recorded");
    await domain.recordSweepRejudgment("company-attention", result.trace.id, result.trace.visibleCardIds, []);
    expect((await domain.completeWork("company-attention", result.work.id, result.work.capabilityToken, { response: "Rejudged." })).status).toBe("completed");

    const firstRecollection = await domain.requestSweepRecollection("company-attention");
    expect(firstRecollection.feedbackId).toBe(result.trace.id);
    expect(firstRecollection.startingBatchId).toBe(null);
    expect((await domain.claimWork("company-attention", "thread-company"))?.id).toBe(firstRecollection.id);
    await expect(domain.completeWork("company-attention", firstRecollection.id, firstRecollection.capabilityToken, { response: "Collected." })).rejects.toThrow("new sweep batch");
    await domain.failWork("company-attention", firstRecollection.id, firstRecollection.capabilityToken, "Transient connector failure.");
    expect((await store.readSweepState("company-attention")).recollectionOffered).toBe(true);

    const retry = await domain.requestSweepRecollection("company-attention");
    expect(retry.id).not.toBe(firstRecollection.id);
    expect((await domain.claimWork("company-attention", "thread-company"))?.id).toBe(retry.id);
    const run = await domain.recordSourceRun("company-attention", "company-attention", [], [], { cursor: "retry" }, retry.id);
    await domain.recordSweepBatch("company-attention", [run], retry.id);
    expect((await domain.completeWork("company-attention", retry.id, retry.capabilityToken, { response: "Collected and judged." })).status).toBe("completed");
  });

  test("requires recollection batches to contain source runs recorded for the claimed recollection", async () => {
    const { store, domain } = await setup();
    await domain.seedDemo();
    await domain.bindFeed("company-attention", "thread-company");
    const oldRun = await domain.recordSourceRun("company-attention", "company-attention", [], [], { cursor: "old" });
    await domain.recordSweepBatch("company-attention", [oldRun]);
    const result = await domain.submitVoiceInstruction("company-attention", { kind: "sweep", feedId: "company-attention" }, "Search again with this correction.");
    if (!("trace" in result)) throw new Error("Expected sweep trace");
    expect((await domain.claimWork("company-attention", "thread-company"))?.id).toBe(result.work.id);
    await domain.recordSweepRejudgment("company-attention", result.trace.id, result.trace.visibleCardIds, []);
    await domain.completeWork("company-attention", result.work.id, result.work.capabilityToken, { response: "Rejudged." });
    const recollection = await domain.requestSweepRecollection("company-attention");
    expect((await domain.claimWork("company-attention", "thread-company"))?.id).toBe(recollection.id);
    await expect(domain.recordSweepBatch("company-attention", [oldRun], recollection.id)).rejects.toThrow("not recorded for this recollection");
    const newRun = await domain.recordSourceRun("company-attention", "company-attention", [], [], { cursor: "new" }, recollection.id);
    const batchId = await domain.recordSweepBatch("company-attention", [newRun], recollection.id);
    expect((await store.readSweepBatch("company-attention", batchId)).triggerWorkId).toBe(recollection.id);
    expect((await domain.completeWork("company-attention", recollection.id, recollection.capabilityToken, { response: "Collected." })).status).toBe("completed");
  });

  test("rejects sweep batches that reference missing source runs", async () => {
    const { domain } = await setup();
    await expect(domain.recordSweepBatch("inbox", ["run-does-not-exist"])).rejects.toThrow("Source run not found");
  });

  test("queues broader voice intent for Codex and preserves approval-gated revision history", async () => {
    const { store, domain } = await setup();
    const feedTarget = { kind: "feed" as const, feedId: "inbox" };
    const originalPolicy = await store.readTargetContent(feedTarget);
    const feedResult = await domain.submitVoiceInstruction("inbox", feedTarget, "Add Slack as a source and refresh this feed.");
    expect(feedResult.kind).toBe("scoped_work");
    expect(feedResult.work.cardId).toBe("__feed__");
    expect(feedResult.work.target).toEqual(feedTarget);
    expect(await store.readTargetContent(feedTarget)).toBe(originalPolicy);
    expect((await store.readWorkspace("inbox")).proposals).toHaveLength(0);

    const target = { kind: "source_recipe" as const, feedId: "inbox", sourceId: "gmail-inbox" };
    const original = await store.readTargetContent(target);
    const result = await domain.submitVoiceInstruction("inbox", target, "Exclude newsletters unless they require a decision.");
    expect(result.kind).toBe("scoped_work");
    expect(result.work.target).toEqual(target);
    expect(await store.readTargetContent(target)).toBe(original);
    expect((await store.readWorkspace("inbox")).proposals).toHaveLength(0);

    const proposal = await domain.proposeRevision("inbox", target, "Exclude newsletters unless they require a decision.", `${original}\n\n- Exclude newsletters unless they require a decision.`);
    const revision = await domain.applyRevisionProposal(proposal.id);
    expect(await store.readTargetContent(target)).toContain("Exclude newsletters");
    await domain.revertWorkspaceRevision(revision.id);
    expect(await store.readTargetContent(target)).toBe(original);
    expect((await store.readEvents("inbox")).map((event) => event.type)).toEqual(expect.arrayContaining([
      "revision.proposed",
      "revision.applied",
      "revision.reverted",
    ]));
  });

  test("records reversible direct prompt edits and approval-gated global proposals", async () => {
    const { store, domain } = await setup();
    const prompt = { kind: "prompt_layer" as const, feedId: "inbox", promptId: "judge.md" };
    const originalPrompt = await store.readTargetContent(prompt);
    const revision = await domain.updateWorkspaceDocument("inbox", prompt, `${originalPrompt}\n- Prefer a smaller set.`);
    expect(await store.readTargetContent(prompt)).toContain("smaller set");
    await domain.revertWorkspaceRevision(revision.id);
    expect(await store.readTargetContent(prompt)).toBe(originalPrompt);

    const globalPrompt = { kind: "global_prompt" as const, promptId: "judge.md" };
    const originalGlobal = await store.readTargetContent(globalPrompt);
    const proposal = await domain.proposeRevision("inbox", globalPrompt, "Require a concrete decision consequence.", `${originalGlobal}\n\n- Require a concrete decision consequence.`);
    expect(await store.readTargetContent(globalPrompt)).toBe(originalGlobal);
    expect((await store.readWorkspace("company-attention")).proposals.map((item) => item.id)).toContain(proposal.id);
    expect((await domain.rejectRevisionProposal(proposal.id)).status).toBe("rejected");
    expect((await store.readWorkspace("company-attention")).proposals.map((item) => item.id)).not.toContain(proposal.id);
    expect(await store.readTargetContent(globalPrompt)).toBe(originalGlobal);
  });

  test("queues one compound pass and keeps its editable policy proposal approval-gated", async () => {
    const { store, domain } = await setup();
    const first = await domain.queueCompound("inbox");
    const second = await domain.queueCompound("inbox");
    expect(second.id).toBe(first.id);

    const target = { kind: "feed" as const, feedId: "inbox" };
    const original = await store.readTargetContent(target);
    const proposal = await domain.proposeRevision("inbox", target, "Preserve the sweep's durable reply judgment.", `${original}\n\n- Prefer concrete reply moves.`, "compound");
    expect(proposal.source).toBe("compound");
    expect(await store.readTargetContent(target)).toBe(original);

    const edited = await domain.updateRevisionProposal(proposal.id, `${original}\n\n- Prefer concrete reply moves backed by the latest outcome.`);
    expect(edited.next).toContain("latest outcome");
    expect(await store.readTargetContent(target)).toBe(original);

    await domain.applyRevisionProposal(proposal.id);
    expect(await store.readTargetContent(target)).toContain("latest outcome");
    expect((await store.readEvents("inbox")).map((event) => event.type)).toEqual(expect.arrayContaining([
      "learning.compound_queued",
      "revision.proposed",
      "revision.proposal_updated",
      "revision.applied",
    ]));
  });
});
