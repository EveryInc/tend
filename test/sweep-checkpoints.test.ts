import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { createLocalRuntime } from "../server/runtime";
import { formatWorkClaimOutput } from "../server/operator";
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
      .rejects.toThrow(`1 of 1 judgments are not presented yet: run ${run} judgment 1 (review): no unclaimed card presents this review judgment (0 available for 1 review judgment without a cardId)`);
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
    await expect(domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." })).rejects.toThrow(`1 of 2 judgments are not presented yet: run ${missing} judgment 1 (review)`);
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
      .rejects.toThrow("2 of 3 judgments are not presented yet: run " + run + " judgment 2 (review): no unclaimed card presents this review judgment (1 available for 2 review judgments without a cardId)");
    await domain.upsertCard(FEED, { id: "the-other", title: "Two", why: "Covers the other review judgment.", blocks: [], sourceRunIds: [run] });
    await expect(domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." }))
      .rejects.toThrow("judgment 3 (routine_action): no card presents this routine_action judgment, and the 1 such judgment in this sweep exceeds the 0 routine action group items proposed since it was recorded");
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

test("a dismissed card that merely gains the run id does not count as presented", async () => {
  const { root, runtime, store, domain } = await setup();
  try {
    const before = await store.readSourceCheckpoint(FEED, SOURCE);
    await domain.upsertCard(FEED, { id: "old-thread", title: "Old thread", why: "Seen before.", blocks: [] });
    await domain.upsertCard(FEED, { id: "old-thread", title: "Old thread", why: "Seen before.", blocks: [], status: "done", completionDisposition: "dismissed" });
    const work = await claimRecollection(domain);
    const run = await domain.recordSourceRun(FEED, SOURCE, [{ thread: "old-thread", newMessage: true }], [{ decision: "review" }], { cursor: "after-old-thread" }, work.id);
    await domain.recordSweepBatch(FEED, [run], work.id);
    // The agent updates the same thread card with the new evidence but never resurfaces it.
    await domain.upsertCard(FEED, { id: "old-thread", title: "Old thread", why: "A new message arrived.", blocks: [], sourceRunIds: [run] });
    expect((await store.readCard(FEED, "old-thread")).status).toBe("done");
    await expect(domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." }))
      .rejects.toThrow("1 of 1 judgments are not presented yet: run " + run + " judgment 1 (review): no unclaimed card presents this review judgment");
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual(before);
    await domain.upsertCard(FEED, { id: "old-thread", title: "Old thread", why: "A new message arrived.", blocks: [], sourceRunIds: [run], status: "to_review_updated" });
    expect((await domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." })).status).toBe("completed");
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual({ cursor: "after-old-thread" });
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cards deferred to a later pass or merely re-tagged while active do not count as presented", async () => {
  const { root, runtime, store, domain } = await setup();
  try {
    const before = await store.readSourceCheckpoint(FEED, SOURCE);
    const currentPass = (await store.readConfig(FEED)).currentPass;
    await domain.upsertCard(FEED, { id: "already-queued", title: "Queued earlier", why: "Approved before the sweep.", blocks: [], status: "queued" });
    const work = await claimRecollection(domain);
    const run = await domain.recordSourceRun(FEED, SOURCE, [{ a: 1 }, { b: 2 }], [{ decision: "review" }, { decision: "review" }], { cursor: "visibility" }, work.id);
    await domain.recordSweepBatch(FEED, [run], work.id);
    // One card is pushed to the next pass; the other is a pre-existing queued card that only gained the run id.
    await domain.upsertCard(FEED, { id: "deferred", title: "Deferred", why: "Hidden until the next pass.", blocks: [], sourceRunIds: [run], readyForPass: currentPass + 1 });
    await domain.upsertCard(FEED, { id: "already-queued", title: "Queued earlier", why: "Approved before the sweep.", blocks: [], sourceRunIds: [run] });
    expect((await store.readCard(FEED, "already-queued")).status).toBe("queued");
    await expect(domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." }))
      .rejects.toThrow("2 of 2 judgments are not presented yet");
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual(before);
    await domain.upsertCard(FEED, { id: "deferred", title: "Deferred", why: "Now visible.", blocks: [], sourceRunIds: [run], readyForPass: currentPass });
    await domain.upsertCard(FEED, { id: "already-queued", title: "Queued earlier", why: "Back in review with new evidence.", blocks: [], sourceRunIds: [run], status: "to_review_updated" });
    expect((await domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." })).status).toBe("completed");
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual({ cursor: "visibility" });
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a routine action group proposed before the sweep does not present its routine judgments", async () => {
  const { root, runtime, store, domain } = await setup();
  try {
    const before = await store.readSourceCheckpoint(FEED, SOURCE);
    await domain.upsertRoutineActionGroup(FEED, {
      id: "stale-routine", label: "Old batch", summary: "Proposed before this sweep.",
      proposedAction: { label: "Archive", instruction: "Archive the listed items." },
      items: [{ id: "old-1", title: "Old digest", reason: "Routine." }, { id: "old-2", title: "Older digest", reason: "Routine." }],
    });
    const work = await claimRecollection(domain);
    const run = await domain.recordSourceRun(FEED, SOURCE, [{ a: 1 }, { b: 2 }], [{ decision: "routine_action" }, { decision: "routine_action" }], { cursor: "routine" }, work.id);
    await domain.recordSweepBatch(FEED, [run], work.id); // supersedes the earlier proposed group
    await expect(domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." }))
      .rejects.toThrow("2 of 2 judgments are not presented yet: run " + run + " judgment 1 (routine_action): no card presents this routine_action judgment, and the 2 such judgments in this sweep exceed the 0 routine action group items proposed since it was recorded");
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual(before);
    await domain.upsertRoutineActionGroup(FEED, {
      id: "fresh-routine", label: "New batch", summary: "Proposed for this sweep.",
      proposedAction: { label: "Archive", instruction: "Archive the listed items." },
      items: [{ id: "new-1", title: "Digest", reason: "Routine." }],
    });
    await expect(domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." }))
      .rejects.toThrow("2 of 2 judgments are not presented yet: run " + run + " judgment 1 (routine_action): no card presents this routine_action judgment, and the 2 such judgments in this sweep exceed the 1 routine action group item proposed since it was recorded");
    await domain.upsertRoutineActionGroup(FEED, {
      id: "fresh-routine", label: "New batch", summary: "Proposed for this sweep.",
      proposedAction: { label: "Archive", instruction: "Archive the listed items." },
      items: [{ id: "new-1", title: "Digest", reason: "Routine." }, { id: "new-2", title: "Other digest", reason: "Routine." }],
    });
    const covered = await domain.sweepPresentationStatus(FEED);
    expect(covered).toMatchObject({ ready: true, routineGroupItems: 2, routineCoveredByGroups: 2 });
    expect(covered.runs[0]).toMatchObject({ needingPresentation: 2, presented: 0 });
    expect((await domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." })).status).toBe("completed");
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual({ cursor: "routine" });
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("judgments that name a cardId are matched against that exact card, with precise reasons", async () => {
  const { root, runtime, store, domain } = await setup();
  try {
    const before = await store.readSourceCheckpoint(FEED, SOURCE);
    expect(await domain.sweepPresentationStatus(FEED)).toMatchObject({ status: "idle", ready: true, missing: [] });
    const work = await claimRecollection(domain);
    const run = await domain.recordSourceRun(FEED, SOURCE, [{ thread: "a" }, { thread: "b" }, { thread: "c" }],
      [{ decision: "review", cardId: "thread-a" }, { decision: "review", cardId: "thread-b" }, { decision: "suppress", cardId: "ignored" }], { cursor: "exact" }, work.id);
    await domain.recordSweepBatch(FEED, [run], work.id);

    let status = await domain.sweepPresentationStatus(FEED);
    expect(status).toMatchObject({ status: "pending", currentBatchId: expect.any(String), workId: work.id, workStatus: "working", ready: false });
    expect(status.missing.map((gap) => [gap.judgment, gap.cardId, gap.reason])).toEqual([
      [1, "thread-a", "no card with id thread-a exists"],
      [2, "thread-b", "no card with id thread-b exists"],
    ]);
    await expect(domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." }))
      .rejects.toThrow("2 of 2 judgments are not presented yet: run " + run + " judgment 1 (review, cardId thread-a): no card with id thread-a exists");

    // The right card id but no provenance, then a card that was dismissed before this run.
    await domain.upsertCard(FEED, { id: "thread-a", title: "A", why: "Forgot sourceRunIds.", blocks: [] });
    await domain.upsertCard(FEED, { id: "thread-b", title: "B", why: "Old.", blocks: [], sourceRunIds: [run], status: "done", completionDisposition: "dismissed", completedAt: "2020-01-01T00:00:00.000Z" });
    status = await domain.sweepPresentationStatus(FEED);
    expect(status.missing.map((gap) => gap.reason)).toEqual([
      `card thread-a does not list run ${run} in sourceRunIds`,
      "card thread-b was dismissed or completed before this run and has not been resurfaced (upsert it with status to_review_updated)",
    ]);
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual(before);

    await domain.upsertCard(FEED, { id: "thread-a", title: "A", why: "Now with provenance.", blocks: [], sourceRunIds: [run] });
    await domain.upsertCard(FEED, { id: "thread-b", title: "B", why: "Resurfaced.", blocks: [], sourceRunIds: [run], status: "to_review_updated" });
    status = await domain.sweepPresentationStatus(FEED);
    expect(status.ready).toBe(true);
    expect(status.runs[0]).toMatchObject({ runId: run, checkpointHeld: true, judgments: 3, needingPresentation: 2, presented: 2 });
    expect((await domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." })).status).toBe("completed");
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual({ cursor: "exact" });
    expect((await domain.sweepPresentationStatus(FEED)).status).toBe("committed");
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a card claimed by an exact match does not also count for a judgment without a cardId", async () => {
  const { root, runtime, store, domain } = await setup();
  try {
    const work = await claimRecollection(domain);
    const run = await domain.recordSourceRun(FEED, SOURCE, [{ a: 1 }, { b: 2 }], [{ decision: "review", cardId: "named" }, { decision: "review" }], { cursor: "mixed" }, work.id);
    await domain.recordSweepBatch(FEED, [run], work.id);
    await domain.upsertCard(FEED, { id: "named", title: "Named", why: "Exact match.", blocks: [], sourceRunIds: [run] });
    const status = await domain.sweepPresentationStatus(FEED);
    expect(status.missing).toHaveLength(1);
    expect(status.missing[0]).toMatchObject({ judgment: 2, decision: "review" });
    expect(status.missing[0].cardId).toBeUndefined();
    expect(status.missing[0].reason).toContain("0 available for 1 review judgment without a cardId");
    await domain.upsertCard(FEED, { id: "anonymous", title: "Other", why: "Counted.", blocks: [], sourceRunIds: [run] });
    expect((await domain.sweepPresentationStatus(FEED)).ready).toBe(true);
    expect((await domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." })).status).toBe("completed");
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual({ cursor: "mixed" });
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const order of ["named-first", "unnamed-first"] as const) {
  test(`a card named by one run's judgment is not counted for another run's unnamed judgment (${order})`, async () => {
    const { root, runtime, store, domain } = await setup();
    try {
      const work = await claimRecollection(domain);
      const second = await domain.addSourceFromBrief(FEED, "Read the dispute ledger.");
      const named = await domain.recordSourceRun(FEED, SOURCE, [{ a: 1 }], [{ decision: "review", cardId: "shared" }], { cursor: "named" }, work.id);
      const unnamed = await domain.recordSourceRun(FEED, second.id, [{ b: 2 }], [{ decision: "review" }], { cursor: "unnamed" }, work.id);
      await domain.recordSweepBatch(FEED, order === "named-first" ? [named, unnamed] : [unnamed, named], work.id);
      await domain.upsertCard(FEED, { id: "shared", title: "Shared", why: "Lists both runs but is named by only one judgment.", blocks: [], sourceRunIds: [named, unnamed] });
      const status = await domain.sweepPresentationStatus(FEED);
      expect(status.ready).toBe(false);
      expect(status.missing.map((gap) => [gap.runId, gap.judgment, gap.cardId])).toEqual([[unnamed, 1, undefined]]);
      await expect(domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." })).rejects.toThrow("1 of 2 judgments are not presented yet");
      // Naming the same card from the second judgment makes the sharing explicit.
      await domain.upsertCard(FEED, { id: "shared", title: "Shared", why: "Same card, now named by both.", blocks: [], sourceRunIds: [named, unnamed] });
      const rerecorded = await domain.recordSourceRun(FEED, second.id, [{ b: 2 }], [{ decision: "review", cardId: "shared" }], { cursor: "unnamed" }, work.id);
      await domain.recordSweepBatch(FEED, [named, rerecorded], work.id);
      await domain.upsertCard(FEED, { id: "shared", title: "Shared", why: "Same card, now named by both.", blocks: [], sourceRunIds: [named, rerecorded] });
      expect((await domain.sweepPresentationStatus(FEED)).ready).toBe(true);
      expect((await domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." })).status).toBe("completed");
      expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual({ cursor: "named" });
      expect(await store.readSourceCheckpoint(FEED, second.id)).toEqual({ cursor: "unnamed" });
    } finally {
      runtime.sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const order of ["named-first", "unnamed-first"] as const) {
  test(`a named card that does not yet present its run is still reserved, and gaps follow batch order (${order})`, async () => {
    const { root, runtime, domain } = await setup();
    try {
      const work = await claimRecollection(domain);
      const second = await domain.addSourceFromBrief(FEED, "Read the dispute ledger.");
      const named = await domain.recordSourceRun(FEED, SOURCE, [{ a: 1 }], [{ decision: "review", cardId: "shared" }], { cursor: "named" }, work.id);
      const unnamed = await domain.recordSourceRun(FEED, second.id, [{ b: 2 }], [{ decision: "review" }], { cursor: "unnamed" }, work.id);
      const batchOrder = order === "named-first" ? [named, unnamed] : [unnamed, named];
      await domain.recordSweepBatch(FEED, batchOrder, work.id);
      // The card exists but lists only the unnamed run: it must not count for that run's unnamed judgment either.
      await domain.upsertCard(FEED, { id: "shared", title: "Shared", why: "Wrong provenance.", blocks: [], sourceRunIds: [unnamed] });
      const status = await domain.sweepPresentationStatus(FEED);
      expect(status.missing.map((gap) => gap.runId)).toEqual(batchOrder);
      expect(status.missing.find((gap) => gap.runId === named)).toMatchObject({ judgment: 1, cardId: "shared", reason: `card shared does not list run ${named} in sourceRunIds` });
      expect(status.missing.find((gap) => gap.runId === unnamed)?.cardId).toBeUndefined();
    } finally {
      runtime.sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("readiness reflects the work's state, and the missing list follows batch order", async () => {
  const { root, runtime, domain } = await setup();
  try {
    const work = await claimRecollection(domain);
    const run = await domain.recordSourceRun(FEED, SOURCE, [{ a: 1 }, { b: 2 }, { c: 3 }],
      [{ decision: "review" }, { decision: "review", cardId: "named" }, { decision: "routine_action" }], { cursor: "ordered" }, work.id);
    await domain.recordSweepBatch(FEED, [run], work.id);
    let status = await domain.sweepPresentationStatus(FEED);
    expect(status.missing.map((gap) => gap.judgment)).toEqual([1, 2, 3]);
    await domain.upsertCard(FEED, { id: "named", title: "Named", why: "Exact.", blocks: [], sourceRunIds: [run] });
    await domain.upsertCard(FEED, { id: "counted-1", title: "One", why: "Counted.", blocks: [], sourceRunIds: [run] });
    await domain.upsertCard(FEED, { id: "counted-2", title: "Two", why: "Counted.", blocks: [], sourceRunIds: [run] });
    status = await domain.sweepPresentationStatus(FEED);
    expect(status).toMatchObject({ ready: true, workStatus: "working" });
    expect(status.summary).toContain("work:complete will commit the 1 held checkpoint");

    await domain.releaseWork(FEED, work.id, work.capabilityToken);
    status = await domain.sweepPresentationStatus(FEED);
    expect(status).toMatchObject({ ready: true, workStatus: "queued" });
    expect(status.summary).toContain(`claim work ${work.id} again`);

    const reclaimed = await domain.claimWork(FEED, THREAD) as WorkItem;
    await domain.failWork(FEED, work.id, reclaimed.capabilityToken, "Connector died.");
    status = await domain.sweepPresentationStatus(FEED);
    expect(status).toMatchObject({ ready: false, workStatus: "failed", missing: [] });
    expect(status.summary.startsWith(`Recollection work ${work.id} is failed and cannot complete`)).toBe(true);
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed owner is reported before the gap list", async () => {
  const { root, runtime, domain } = await setup();
  try {
    const work = await claimRecollection(domain);
    const run = await domain.recordSourceRun(FEED, SOURCE, [{ a: 1 }], [{ decision: "review", cardId: "never-made" }], { cursor: "failed" }, work.id);
    await domain.recordSweepBatch(FEED, [run], work.id);
    await domain.failWork(FEED, work.id, work.capabilityToken, "Died before presenting.");
    const status = await domain.sweepPresentationStatus(FEED);
    expect(status).toMatchObject({ status: "pending", ready: false, workStatus: "failed" });
    expect(status.missing).toHaveLength(1);
    expect(status.summary.startsWith(`Recollection work ${work.id} is failed and cannot complete; request a new recollection`)).toBe(true);
    expect(status.summary).toContain("1 of 1 judgments are not presented yet");
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a review card pulled into a proposed routine group no longer presents its judgment", async () => {
  const { root, runtime, domain } = await setup();
  try {
    const work = await claimRecollection(domain);
    const run = await domain.recordSourceRun(FEED, SOURCE, [{ a: 1 }], [{ decision: "review", cardId: "x" }], { cursor: "grouped" }, work.id);
    await domain.recordSweepBatch(FEED, [run], work.id);
    await domain.upsertCard(FEED, { id: "x", title: "X", why: "Reviewable.", blocks: [], sourceRunIds: [run] });
    expect((await domain.sweepPresentationStatus(FEED)).ready).toBe(true);
    await domain.upsertRoutineActionGroup(FEED, {
      id: "group-with-x", label: "Batch", summary: "Contains the review card.",
      proposedAction: { label: "Archive", instruction: "Archive these." },
      items: [{ id: "item-x", cardId: "x", title: "X", reason: "Routine." }],
    });
    const status = await domain.sweepPresentationStatus(FEED);
    expect(status.ready).toBe(false);
    expect(status.missing[0].reason).toBe("card x belongs to routine action group group-with-x, so it is not individually reviewable; a review judgment needs its own card");
    await expect(domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." })).rejects.toThrow("not individually reviewable");
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a routine action group re-proposed under a reused id counts for the new sweep", async () => {
  const { root, runtime, store, domain } = await setup();
  try {
    await domain.upsertRoutineActionGroup(FEED, {
      id: "weekly-digests", label: "Digests", summary: "Last sweep's group.",
      proposedAction: { label: "Archive", instruction: "Archive the digests." },
      items: [{ id: "old", title: "Old digest", reason: "Routine." }],
    });
    const work = await claimRecollection(domain);
    const run = await domain.recordSourceRun(FEED, SOURCE, [{ a: 1 }], [{ decision: "routine_action" }], { cursor: "reused" }, work.id);
    await domain.recordSweepBatch(FEED, [run], work.id); // supersedes the earlier proposal
    expect((await store.readFeed(FEED)).routineActions.find((group) => group.id === "weekly-digests")?.status).toBe("stale");
    expect((await domain.sweepPresentationStatus(FEED)).ready).toBe(false);
    await domain.upsertRoutineActionGroup(FEED, {
      id: "weekly-digests", label: "Digests", summary: "This sweep's group, same id.",
      proposedAction: { label: "Archive", instruction: "Archive the digests." },
      items: [{ id: "new", title: "New digest", reason: "Routine." }],
    });
    expect(await domain.sweepPresentationStatus(FEED)).toMatchObject({ ready: true, routineGroupItems: 1, routineCoveredByGroups: 1 });
    expect((await domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." })).status).toBe("completed");
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a batch must include every held run recorded for its work unless a newer run for that source supersedes it", async () => {
  const { root, runtime, store, domain } = await setup();
  try {
    const work = await claimRecollection(domain);
    const second = await domain.addSourceFromBrief(FEED, "Read the dispute ledger.");
    const a = await domain.recordSourceRun(FEED, SOURCE, [{ a: 1 }], [{ decision: "review", cardId: "a-card" }], { cursor: "a" }, work.id);
    const b = await domain.recordSourceRun(FEED, second.id, [{ b: 1 }], [{ decision: "suppress" }], { cursor: "b" }, work.id);
    await expect(domain.recordSweepBatch(FEED, [b], work.id)).rejects.toThrow(`Source run ${a} (Company Attention) recorded for this recollection is missing from the batch`);
    const aAgain = await domain.recordSourceRun(FEED, SOURCE, [{ a: 2 }], [{ decision: "suppress" }], { cursor: "a2" }, work.id);
    await domain.recordSweepBatch(FEED, [b, aAgain], work.id); // the newer run for the same source supersedes the first
    expect((await domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." })).status).toBe("completed");
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual({ cursor: "a2" });
    const superseded = await store.readRun(FEED, a);
    expect(superseded.pendingCheckpoint).toBeUndefined();
    expect(typeof superseded.checkpointCommittedAt).toBe("string");
    const event = (await store.readEvents(FEED)).find((item) => item.type === "sweep.checkpoints_committed");
    expect(event?.detail).toMatchObject({ skipped: expect.arrayContaining([{ runId: a, reason: "superseded by a newer run for the same source, which the batch included" }]) });
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a card that already presents a judgment adds no routine group capacity", async () => {
  const { root, runtime, domain } = await setup();
  try {
    const work = await claimRecollection(domain);
    const run = await domain.recordSourceRun(FEED, SOURCE, [{ a: 1 }, { b: 2 }], [{ decision: "routine_action", cardId: "x" }, { decision: "routine_action" }], { cursor: "double" }, work.id);
    await domain.recordSweepBatch(FEED, [run], work.id);
    await domain.upsertCard(FEED, { id: "x", title: "X", why: "Presents judgment 1.", blocks: [], sourceRunIds: [run] });
    await domain.upsertRoutineActionGroup(FEED, {
      id: "one-item", label: "Batch", summary: "Only card x.",
      proposedAction: { label: "Archive", instruction: "Archive these." },
      items: [{ id: "item-x", cardId: "x", title: "X", reason: "Routine." }],
    });
    const status = await domain.sweepPresentationStatus(FEED);
    expect(status).toMatchObject({ ready: false, routineGroupItems: 0, routineCoveredByGroups: 0 });
    expect(status.missing.map((gap) => gap.judgment)).toEqual([2]);
    await domain.upsertRoutineActionGroup(FEED, {
      id: "one-item", label: "Batch", summary: "Card x plus a card-less item for judgment 2.",
      proposedAction: { label: "Archive", instruction: "Archive these." },
      items: [{ id: "item-x", cardId: "x", title: "X", reason: "Routine." }, { id: "item-2", title: "Other", reason: "Routine." }],
    });
    expect(await domain.sweepPresentationStatus(FEED)).toMatchObject({ ready: true, routineGroupItems: 1, routineCoveredByGroups: 1 });
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a run recorded after the batch must be batched before the work can complete", async () => {
  const { root, runtime, store, domain } = await setup();
  try {
    const work = await claimRecollection(domain);
    const second = await domain.addSourceFromBrief(FEED, "Read the dispute ledger.");
    const a = await domain.recordSourceRun(FEED, SOURCE, [{ a: 1 }], [{ decision: "suppress" }], { cursor: "a" }, work.id);
    await domain.recordSweepBatch(FEED, [a], work.id);
    const b = await domain.recordSourceRun(FEED, second.id, [{ b: 1 }], [{ decision: "review", cardId: "b-card" }], { cursor: "b" }, work.id);
    const status = await domain.sweepPresentationStatus(FEED);
    expect(status).toMatchObject({ ready: false, status: "pending", unbatchedRuns: [{ runId: b, sourceId: second.id }] });
    expect(status.summary).toMatch(new RegExp(`^Source run ${b} \\(.+\\) recorded for this work after batch .+ is not in it; record the batch again`));
    await expect(domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." })).rejects.toThrow("record the batch again");
    expect((await store.readRun(FEED, b)).pendingCheckpoint).toEqual({ cursor: "b" });
    await domain.recordSweepBatch(FEED, [a, b], work.id);
    await domain.upsertCard(FEED, { id: "b-card", title: "B", why: "Presented.", blocks: [], sourceRunIds: [b] });
    expect((await domain.sweepPresentationStatus(FEED)).ready).toBe(true);
    expect((await domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." })).status).toBe("completed");
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual({ cursor: "a" });
    expect(await store.readSourceCheckpoint(FEED, second.id)).toEqual({ cursor: "b" });
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a card counted for one run's unnamed judgment is not counted again for another run", async () => {
  const { root, runtime, domain } = await setup();
  try {
    const work = await claimRecollection(domain);
    const second = await domain.addSourceFromBrief(FEED, "Read the dispute ledger.");
    const a = await domain.recordSourceRun(FEED, SOURCE, [{ a: 1 }], [{ decision: "review" }], { cursor: "a" }, work.id);
    const b = await domain.recordSourceRun(FEED, second.id, [{ b: 1 }], [{ decision: "review" }], { cursor: "b" }, work.id);
    await domain.recordSweepBatch(FEED, [a, b], work.id);
    await domain.upsertCard(FEED, { id: "both", title: "Both", why: "Lists both runs without being named by either judgment.", blocks: [], sourceRunIds: [a, b] });
    const status = await domain.sweepPresentationStatus(FEED);
    expect(status.ready).toBe(false);
    expect(status.missing.map((gap) => gap.runId)).toEqual([b]);
    expect(status.runs.map((run) => run.presented)).toEqual([1, 0]);
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a card dismissed between the run and its refresh does not present the refreshed content", async () => {
  const { root, runtime, store, domain } = await setup();
  try {
    await domain.upsertCard(FEED, { id: "thread-r", title: "Old content", why: "Seen before.", blocks: [] });
    const work = await claimRecollection(domain);
    const run = await domain.recordSourceRun(FEED, SOURCE, [{ thread: "thread-r" }], [{ decision: "review", cardId: "thread-r" }], { cursor: "race" }, work.id);
    await domain.recordSweepBatch(FEED, [run], work.id);
    // The user dismisses the old card after the run was recorded, then the agent refreshes it without resurfacing.
    await domain.dismissCard(FEED, "thread-r");
    await Bun.sleep(1_100);
    await domain.upsertCard(FEED, { id: "thread-r", title: "New content", why: "A new message arrived.", blocks: [], sourceRunIds: [run] });
    expect((await store.readCard(FEED, "thread-r")).status).toBe("done");
    const status = await domain.sweepPresentationStatus(FEED);
    expect(status.ready).toBe(false);
    expect(status.missing[0].reason).toBe("card thread-r was updated after the user dismissed or completed it, so its current content was never reviewed; upsert it with status to_review_updated");
    await domain.upsertCard(FEED, { id: "thread-r", title: "New content", why: "A new message arrived.", blocks: [], sourceRunIds: [run], status: "to_review_updated" });
    expect((await domain.sweepPresentationStatus(FEED)).ready).toBe(true);
    // A dismissal of the presented content still counts.
    await domain.dismissCard(FEED, "thread-r");
    expect((await domain.sweepPresentationStatus(FEED)).ready).toBe(true);
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a card hidden by sweep feedback does not present its judgment", async () => {
  const { root, runtime, store, domain } = await setup();
  try {
    const work = await claimRecollection(domain);
    const run = await domain.recordSourceRun(FEED, SOURCE, [{ a: 1 }], [{ decision: "review", cardId: "hidden-card" }], { cursor: "hidden" }, work.id);
    await domain.recordSweepBatch(FEED, [run], work.id);
    await domain.upsertCard(FEED, { id: "hidden-card", title: "Hidden", why: "Rejudged away.", blocks: [], sourceRunIds: [run] });
    expect((await domain.sweepPresentationStatus(FEED)).ready).toBe(true);
    const card = await store.readCard(FEED, "hidden-card");
    await store.writeCard({ ...card, sweep: { rank: 0, hidden: true, feedbackId: "feedback-1" } });
    const status = await domain.sweepPresentationStatus(FEED);
    expect(status.ready).toBe(false);
    expect(status.missing[0].reason).toContain("is hidden by sweep feedback feedback-1");
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an older routine group approved after the run is not new coverage", async () => {
  const { root, runtime, store, domain } = await setup();
  try {
    await domain.upsertRoutineActionGroup(FEED, {
      id: "older", label: "Older", summary: "Proposed before this sweep.",
      proposedAction: { label: "Archive", instruction: "Archive these." },
      items: [{ id: "i1", title: "One", reason: "Routine." }],
    });
    const work = await claimRecollection(domain);
    const run = await domain.recordSourceRun(FEED, SOURCE, [{ a: 1 }], [{ decision: "routine_action" }], { cursor: "approved-later" }, work.id);
    // Approved (queued) after the run but before the batch, so recording the batch does not stale it.
    await domain.approveRoutineActionGroup(FEED, "older");
    expect((await store.readFeed(FEED)).routineActions.find((group) => group.id === "older")?.status).toBe("queued");
    await domain.recordSweepBatch(FEED, [run], work.id);
    const status = await domain.sweepPresentationStatus(FEED);
    expect(status).toMatchObject({ ready: false, routineGroupItems: 0 });
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a re-proposed group that the user approves before completion keeps counting", async () => {
  const { root, runtime, store, domain } = await setup();
  try {
    await domain.upsertRoutineActionGroup(FEED, {
      id: "weekly", label: "Weekly", summary: "Last sweep's proposal.",
      proposedAction: { label: "Archive", instruction: "Archive the digests." },
      items: [{ id: "old", title: "Old digest", reason: "Routine." }],
    });
    const work = await claimRecollection(domain);
    const run = await domain.recordSourceRun(FEED, SOURCE, [{ a: 1 }], [{ decision: "routine_action" }], { cursor: "revived" }, work.id);
    await domain.recordSweepBatch(FEED, [run], work.id); // stales the earlier proposal
    await domain.upsertRoutineActionGroup(FEED, {
      id: "weekly", label: "Weekly", summary: "This sweep's proposal under the same id.",
      proposedAction: { label: "Archive", instruction: "Archive the digests." },
      items: [{ id: "new", title: "New digest", reason: "Routine." }],
    });
    expect((await domain.sweepPresentationStatus(FEED)).ready).toBe(true);
    await domain.approveRoutineActionGroup(FEED, "weekly");
    expect((await store.readFeed(FEED)).routineActions.find((group) => group.id === "weekly")?.status).toBe("queued");
    expect(await domain.sweepPresentationStatus(FEED)).toMatchObject({ ready: true, routineGroupItems: 1 });
    expect((await domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." })).status).toBe("completed");
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("two judgments may deliberately share one cardId", async () => {
  const { root, runtime, store, domain } = await setup();
  try {
    const work = await claimRecollection(domain);
    const run = await domain.recordSourceRun(FEED, SOURCE, [{ a: 1 }, { b: 2 }], [{ decision: "review", cardId: "merged" }, { decision: "routine_action", cardId: "merged" }], { cursor: "shared" }, work.id);
    await domain.recordSweepBatch(FEED, [run], work.id);
    await domain.upsertCard(FEED, { id: "merged", title: "Merged", why: "Presents both.", blocks: [], sourceRunIds: [run] });
    expect((await domain.sweepPresentationStatus(FEED)).ready).toBe(true);
    expect((await domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Done." })).status).toBe("completed");
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual({ cursor: "shared" });
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a judgment cardId is validated when the run is recorded", async () => {
  const { root, runtime, domain } = await setup();
  try {
    const work = await claimRecollection(domain);
    await expect(domain.recordSourceRun(FEED, SOURCE, [{ a: 1 }], [{ decision: "review", cardId: "has spaces" }], { cursor: "bad" }, work.id))
      .rejects.toThrow("Judgment 1 cardId must use only letters, numbers, dots, underscores, and hyphens.");
    await expect(domain.recordSourceRun(FEED, SOURCE, [{ a: 1 }], [{ decision: "suppress" }, { decision: "review", cardId: 7 }], { cursor: "bad" }, work.id))
      .rejects.toThrow("Judgment 2 cardId must be a non-empty string.");
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("re-claiming an interrupted recollection returns what is still missing", async () => {
  const { root, runtime, domain } = await setup();
  try {
    const work = await claimRecollection(domain);
    const run = await domain.recordSourceRun(FEED, SOURCE, [{ a: 1 }], [{ decision: "review", cardId: "thread-x" }], { cursor: "reclaim" }, work.id);
    await domain.recordSweepBatch(FEED, [run], work.id);
    // The claiming session dies; a fresh session re-claims the same work through the lane replay path.
    const released = await domain.releaseWork(FEED, work.id, work.capabilityToken);
    expect(released.status).toBe("queued");
    const reclaimed = await domain.claimWork(FEED, THREAD) as WorkItem;
    expect(reclaimed.id).toBe(work.id);
    const output = formatWorkClaimOutput(FEED, reclaimed, { sweepPresentation: await domain.sweepPresentationStatus(FEED) });
    if (!("operatorGuidance" in output)) throw new Error("Expected claim guidance.");
    expect(output.operatorGuidance?.completionPrerequisite).toContain("present the judgments listed in pendingPresentation.missing, rerun sweep:status");
    expect(output.operatorGuidance?.pendingPresentation?.missing.map((gap) => gap.cardId)).toEqual(["thread-x"]);
    expect(output.operatorGuidance?.requiredWriteBack).toContain("cardId");
    // A run recorded after the batch changes the instruction: re-record the batch first.
    const late = await domain.recordSourceRun(FEED, SOURCE, [{ later: true }], [{ decision: "suppress" }], { cursor: "late" }, work.id);
    const lateOutput = formatWorkClaimOutput(FEED, reclaimed, { sweepPresentation: await domain.sweepPresentationStatus(FEED) });
    if (!("operatorGuidance" in lateOutput)) throw new Error("Expected claim guidance.");
    expect(lateOutput.operatorGuidance?.completionPrerequisite).toContain(`${late} recorded afterwards is not in it. Record the batch again with sweep:record-batch --work ${work.id}`);
    expect(lateOutput.operatorGuidance?.completionPrerequisite).toContain("then rerun sweep:status");
    await domain.recordSweepBatch(FEED, [late], work.id); // supersedes run and its judgment moves out of the batch
    expect((await domain.sweepPresentationStatus(FEED)).ready).toBe(true);
    expect((await domain.completeWork(FEED, work.id, reclaimed.capabilityToken, { response: "Finished." })).status).toBe("completed");
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
