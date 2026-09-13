import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { createLocalRuntime } from "../server/runtime";
import type { WorkItem } from "../shared/types";

const FEED = "company-attention";
const SOURCE = "company-attention";
const THREAD = "thread-company";

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-sweep-checkpoints-"));
  const runtime = await createLocalRuntime(path.join(root, "data"), path.join(root, "attention.db"));
  const domain = new AttentionDomain(runtime.store);
  await domain.seedDemo();
  await domain.bindFeed(FEED, THREAD);
  // A fresh demo feed has not offered "search again" yet; the first request needs that offer.
  const sweep = await runtime.store.readSweepState(FEED);
  await runtime.store.writeSweepState(FEED, { ...sweep, recollectionOffered: true });
  const mirrorCheckpoint = async () => JSON.parse(await readFile(path.join(root, "data", "feeds", FEED, "checkpoints", `${SOURCE}.json`), "utf8")) as unknown;
  return { root, runtime, store: runtime.store, domain, mirrorCheckpoint };
}

async function claimRecollection(domain: AttentionDomain): Promise<WorkItem> {
  const requested = await domain.requestSweepRecollection(FEED);
  const claimed = await domain.claimWork(FEED, THREAD) as WorkItem;
  expect(claimed.id).toBe(requested.id);
  return claimed;
}

test("a recollection checkpoint advances only when the work completes with cards for every review judgment", async () => {
  const { root, runtime, store, domain, mirrorCheckpoint } = await setup();
  try {
    const before = await store.readSourceCheckpoint(FEED, SOURCE);
    const work = await claimRecollection(domain);
    const run = await domain.recordSourceRun(FEED, SOURCE, [{ transcript: "A reviewed fixture." }], [{ decision: "review" }, { decision: "suppress" }], { cursor: "after-fixture" }, work.id);
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual(before);
    expect((await store.readRun(FEED, run)).pendingCheckpoint).toEqual({ cursor: "after-fixture" });

    await domain.recordSweepBatch(FEED, [run], work.id);
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual(before);

    await expect(domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Collected." }))
      .rejects.toThrow(`Source run ${run} (Company Attention) has 1 review judgment but only 0 cards reference it`);
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual(before);
    expect(await mirrorCheckpoint()).toEqual(before);
    expect((await store.readWork(FEED, work.id)).status).toBe("working");

    await domain.upsertCard(FEED, { id: "reviewed-fixture", title: "Reviewed fixture", why: "The review judgment needs a card.", blocks: [], sourceRunIds: [run] });
    expect((await domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Collected and presented." })).status).toBe("completed");
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual({ cursor: "after-fixture" });
    expect(await mirrorCheckpoint()).toEqual({ cursor: "after-fixture" });
    const committed = await store.readRun(FEED, run);
    expect(committed.pendingCheckpoint).toBeUndefined();
    expect(typeof committed.checkpointCommittedAt).toBe("string");
    const events = await store.readEvents(FEED);
    expect(events.find((event) => event.type === "sweep.checkpoints_committed")?.detail).toMatchObject({ sourceRunIds: [run], skipped: [] });
    expect(events.find((event) => event.type === "source.run_completed")?.detail).toMatchObject({ checkpointHeld: true });
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted recollection keeps the previous checkpoint and offers searching again", async () => {
  const { root, runtime, store, domain } = await setup();
  try {
    const before = await store.readSourceCheckpoint(FEED, SOURCE);
    const interrupted = await claimRecollection(domain);
    const lostRun = await domain.recordSourceRun(FEED, SOURCE, [{ transcript: "Judged but never presented." }], [{ decision: "review" }], { cursor: "would-skip-this" }, interrupted.id);
    await domain.recordSweepBatch(FEED, [lostRun], interrupted.id);
    // The agent dies before creating cards: its work fails, and nothing moved the checkpoint.
    await domain.failWork(FEED, interrupted.id, interrupted.capabilityToken, "Agent backend crashed while preparing cards.");
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual(before);
    const how = await domain.inspectHowFeedWorks(FEED) as { sources: Array<{ id: string; checkpoint: string }> };
    expect(JSON.parse(how.sources.find((source) => source.id === SOURCE)!.checkpoint)).toEqual(before);
    const sweep = await store.readSweepState(FEED);
    expect(sweep.recollectionOffered).toBe(true);
    expect(sweep.statusMessage).toBe("Source search failed before its results were presented");

    // Searching again is offered without any manual reset; the next sweep resumes from the untouched checkpoint.
    const retry = await claimRecollection(domain);
    const run = await domain.recordSourceRun(FEED, SOURCE, [], [], { cursor: "resumed" }, retry.id);
    await domain.recordSweepBatch(FEED, [run], retry.id);
    expect((await domain.completeWork(FEED, retry.id, retry.capabilityToken, { response: "Nothing new." })).status).toBe("completed");
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual({ cursor: "resumed" });
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a held checkpoint never overwrites one that advanced after the run was recorded", async () => {
  const { root, runtime, store, domain } = await setup();
  try {
    const work = await claimRecollection(domain);
    const heldRun = await domain.recordSourceRun(FEED, SOURCE, [], [{ decision: "suppress" }], { cursor: "10" }, work.id);
    await domain.recordSweepBatch(FEED, [heldRun], work.id);
    // A work-less run (an import, say) advances the same source in the meantime.
    await domain.recordSourceRun(FEED, SOURCE, [], [], { cursor: "20" });
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual({ cursor: "20" });
    expect((await domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." })).status).toBe("completed");
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual({ cursor: "20" });
    const settled = await store.readRun(FEED, heldRun);
    expect(settled.pendingCheckpoint).toBeUndefined();
    expect(typeof settled.checkpointCommittedAt).toBe("string");
    const event = (await store.readEvents(FEED)).find((item) => item.type === "sweep.checkpoints_committed");
    expect(event?.detail).toMatchObject({ sourceRunIds: [], skipped: [{ runId: heldRun, reason: "source checkpoint advanced after this run was recorded" }] });
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the newest run for a source owns its checkpoint regardless of batch order", async () => {
  const { root, runtime, store, domain } = await setup();
  try {
    const work = await claimRecollection(domain);
    const first = await domain.recordSourceRun(FEED, SOURCE, [], [], { cursor: "first" }, work.id);
    const second = await domain.recordSourceRun(FEED, SOURCE, [], [], { cursor: "second" }, work.id);
    expect((await store.readRun(FEED, second)).checkpointSequence).toBe((await store.readRun(FEED, first)).checkpointSequence! + 1);
    await domain.recordSweepBatch(FEED, [second, first], work.id);
    expect((await domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." })).status).toBe("completed");
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual({ cursor: "second" });
    const event = (await store.readEvents(FEED)).find((item) => item.type === "sweep.checkpoints_committed");
    expect(event?.detail).toMatchObject({ sourceRunIds: [second], skipped: [{ runId: first, reason: "superseded by a newer run for the same source in this batch" }] });
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a refused completion writes nothing, even when an earlier run in the batch was complete", async () => {
  const { root, runtime, store, domain, mirrorCheckpoint } = await setup();
  try {
    const before = await store.readSourceCheckpoint(FEED, SOURCE);
    const beforeMirror = await mirrorCheckpoint();
    const work = await claimRecollection(domain);
    const presented = await domain.recordSourceRun(FEED, SOURCE, [{ transcript: "Presented." }], [{ decision: "review" }], { cursor: "presented" }, work.id);
    const second = await domain.addSourceFromBrief(FEED, "Read the dispute ledger.");
    const missing = await domain.recordSourceRun(FEED, second.id, [{ note: "Not presented." }], [{ decision: "review" }], { cursor: "missing" }, work.id);
    await domain.recordSweepBatch(FEED, [presented, missing], work.id);
    await domain.upsertCard(FEED, { id: "presented-card", title: "Presented", why: "Has a card.", blocks: [], sourceRunIds: [presented] });
    await expect(domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." })).rejects.toThrow(`Source run ${missing}`);
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual(before);
    expect(await mirrorCheckpoint()).toEqual(beforeMirror);
    expect((await store.readRun(FEED, presented)).pendingCheckpoint).toEqual({ cursor: "presented" });
    expect((await store.readWork(FEED, work.id)).status).toBe("working");
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("every review judgment needs its own card, and routine_action judgments need a card or a proposed group", async () => {
  const { root, runtime, store, domain } = await setup();
  try {
    const before = await store.readSourceCheckpoint(FEED, SOURCE);
    const work = await claimRecollection(domain);
    const run = await domain.recordSourceRun(FEED, SOURCE, [{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }], [{ decision: "review" }, { decision: "review" }, { decision: "routine_action" }, { decision: "suppress" }], { cursor: "counted" }, work.id);
    await domain.recordSweepBatch(FEED, [run], work.id);
    await domain.upsertCard(FEED, { id: "only-one", title: "One", why: "Covers one review judgment.", blocks: [], sourceRunIds: [run] });
    await expect(domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." }))
      .rejects.toThrow(`has 2 review judgments but only 1 card references it`);
    await domain.upsertCard(FEED, { id: "the-other", title: "Two", why: "Covers the other review judgment.", blocks: [], sourceRunIds: [run] });
    await expect(domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." }))
      .rejects.toThrow(`has 1 routine_action judgment but neither a card referencing the run nor a routine action group proposed since the run presents it`);
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual(before);
    await domain.upsertRoutineActionGroup(FEED, {
      id: "routine-fixture", label: "Archive newsletters", summary: "Three newsletters with the same obvious cleanup.",
      proposedAction: { label: "Archive", instruction: "Archive the listed newsletters." },
      items: [{ id: "item-1", title: "Weekly digest", reason: "Routine newsletter." }],
    });
    expect((await domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." })).status).toBe("completed");
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual({ cursor: "counted" });
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failure after checkpoint writes begin rolls back SQLite and the file mirrors together", async () => {
  const { root, runtime, store, domain, mirrorCheckpoint } = await setup();
  try {
    const before = await store.readSourceCheckpoint(FEED, SOURCE);
    const beforeMirror = await mirrorCheckpoint();
    const work = await claimRecollection(domain);
    const run = await domain.recordSourceRun(FEED, SOURCE, [], [], { cursor: "rolled-back" }, work.id);
    await domain.recordSweepBatch(FEED, [run], work.id);
    const appendEvent = store.appendEvent.bind(store);
    store.appendEvent = async (event) => {
      if (event.type === "work.completed") throw new Error("injected failure after checkpoint writes");
      return appendEvent(event);
    };
    await expect(domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." })).rejects.toThrow("injected failure after checkpoint writes");
    store.appendEvent = appendEvent;
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual(before);
    expect(await mirrorCheckpoint()).toEqual(beforeMirror);
    expect((await store.readRun(FEED, run)).pendingCheckpoint).toEqual({ cursor: "rolled-back" });
    const runMirror = JSON.parse(await readFile(path.join(root, "data", "feeds", FEED, "runs", `${run}.json`), "utf8")) as { pendingCheckpoint?: unknown };
    expect(runMirror.pendingCheckpoint).toEqual({ cursor: "rolled-back" });
    expect((await store.readWork(FEED, work.id)).status).toBe("working");
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("runs recorded without recollection work still advance the checkpoint immediately", async () => {
  const { root, runtime, store, domain } = await setup();
  try {
    const run = await domain.recordSourceRun(FEED, SOURCE, [{ transcript: "Manual import." }], [{ decision: "review" }], { cursor: "manual" });
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual({ cursor: "manual" });
    expect((await store.readRun(FEED, run)).pendingCheckpoint).toBeUndefined();
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});
