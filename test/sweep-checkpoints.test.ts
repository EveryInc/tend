import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
  return { root, runtime, store: runtime.store, domain };
}

async function claimRecollection(domain: AttentionDomain): Promise<WorkItem> {
  const sweep = await domain.store.readSweepState(FEED);
  await domain.store.writeSweepState(FEED, { ...sweep, recollectionOffered: true });
  const requested = await domain.requestSweepRecollection(FEED);
  const claimed = await domain.claimWork(FEED, THREAD) as WorkItem;
  expect(claimed.id).toBe(requested.id);
  return claimed;
}

test("a recollection checkpoint advances only when the work completes with cards for every kept judgment", async () => {
  const { root, runtime, store, domain } = await setup();
  try {
    const before = await store.readSourceCheckpoint(FEED, SOURCE);
    const work = await claimRecollection(domain);
    const run = await domain.recordSourceRun(FEED, SOURCE, [{ transcript: "A kept fixture." }], [{ decision: "keep" }, { decision: "suppress" }], { cursor: "after-fixture" }, work.id);
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual(before);
    expect((await store.readRun(FEED, run)).pendingCheckpoint).toEqual({ cursor: "after-fixture" });

    await domain.recordSweepBatch(FEED, [run], work.id);
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual(before);

    await expect(domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Collected." }))
      .rejects.toThrow(`Source run ${run} (Company Attention) has 1 kept judgment but no card references it`);
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual(before);
    expect((await store.readWork(FEED, work.id)).status).toBe("working");

    await domain.upsertCard(FEED, { id: "kept-fixture", title: "Kept fixture", why: "The kept judgment needs a card.", blocks: [], sourceRunIds: [run] });
    expect((await domain.completeWork(FEED, work.id, work.capabilityToken, { response: "Collected and presented." })).status).toBe("completed");
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual({ cursor: "after-fixture" });
    const committed = await store.readRun(FEED, run);
    expect(committed.pendingCheckpoint).toBeUndefined();
    expect(typeof committed.checkpointCommittedAt).toBe("string");
    const events = await store.readEvents(FEED);
    expect(events.some((event) => event.type === "sweep.checkpoints_committed" && event.workId === work.id)).toBe(true);
    expect(events.find((event) => event.type === "source.run_completed")?.detail).toMatchObject({ checkpointHeld: true });
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted recollection leaves the previous checkpoint for the next sweep to resume from", async () => {
  const { root, runtime, store, domain } = await setup();
  try {
    const before = await store.readSourceCheckpoint(FEED, SOURCE);
    const interrupted = await claimRecollection(domain);
    const lostRun = await domain.recordSourceRun(FEED, SOURCE, [{ transcript: "Judged but never presented." }], [{ decision: "keep" }], { cursor: "would-skip-this" }, interrupted.id);
    await domain.recordSweepBatch(FEED, [lostRun], interrupted.id);
    // The agent dies before creating cards: its work fails or is abandoned, and nothing moved the checkpoint.
    await domain.failWork(FEED, interrupted.id, interrupted.capabilityToken, "Agent backend crashed while preparing cards.");
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual(before);
    const how = await domain.inspectHowFeedWorks(FEED) as { sources: Array<{ id: string; checkpoint: string }> };
    expect(JSON.parse(how.sources.find((source) => source.id === SOURCE)!.checkpoint)).toEqual(before);

    // The next sweep starts from the untouched checkpoint; an empty sweep commits immediately on completion.
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

test("runs recorded without recollection work still advance the checkpoint immediately", async () => {
  const { root, runtime, store, domain } = await setup();
  try {
    const run = await domain.recordSourceRun(FEED, SOURCE, [{ transcript: "Manual import." }], [{ decision: "keep" }], { cursor: "manual" });
    expect(await store.readSourceCheckpoint(FEED, SOURCE)).toEqual({ cursor: "manual" });
    expect((await store.readRun(FEED, run)).pendingCheckpoint).toBeUndefined();
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});
