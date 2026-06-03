import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { SweepBatch, SweepFeedbackTrace, SweepState } from "../../src/types";
import { readJson, writeJson } from "../util";

export interface SweepRepository {
  init(feedIds: string[]): Promise<void>;
  hasState(feedId: string): Promise<boolean>;
  readState(feedId: string): Promise<SweepState>;
  writeState(feedId: string, state: SweepState): Promise<void>;
  listBatches(feedId: string): Promise<SweepBatch[]>;
  getBatch(feedId: string, batchId: string): Promise<SweepBatch>;
  writeBatch(batch: SweepBatch): Promise<void>;
  listFeedback(feedId: string): Promise<SweepFeedbackTrace[]>;
  getFeedback(feedId: string, feedbackId: string): Promise<SweepFeedbackTrace>;
  writeFeedback(trace: SweepFeedbackTrace): Promise<void>;
}

export function defaultSweepState(): SweepState {
  return {
    currentBatchId: null,
    lastFeedbackId: null,
    recollectionOffered: false,
    statusMessage: null,
  };
}

export function normalizeSweepState(state: SweepState & { currentRunId?: string | null }): SweepState {
  return {
    currentBatchId: state.currentBatchId ?? state.currentRunId ?? null,
    lastFeedbackId: state.lastFeedbackId,
    recollectionOffered: state.recollectionOffered,
    statusMessage: state.statusMessage,
  };
}

export class FileSweepRepository implements SweepRepository {
  constructor(private readonly dataDir: string) {}

  async init(_feedIds: string[]): Promise<void> {}

  async hasState(feedId: string): Promise<boolean> {
    return existsSync(this.stateFile(feedId));
  }

  async readState(feedId: string): Promise<SweepState> {
    if (!(await this.hasState(feedId))) return defaultSweepState();
    return normalizeSweepState(await readJson<SweepState & { currentRunId?: string | null }>(this.stateFile(feedId)));
  }

  async writeState(feedId: string, state: SweepState): Promise<void> {
    await writeJson(this.stateFile(feedId), state);
  }

  async listBatches(feedId: string): Promise<SweepBatch[]> {
    return this.listJson<SweepBatch>(this.batchPath(feedId));
  }

  async getBatch(feedId: string, batchId: string): Promise<SweepBatch> {
    return readJson<SweepBatch>(this.batchFile(feedId, batchId));
  }

  async writeBatch(batch: SweepBatch): Promise<void> {
    await writeJson(this.batchFile(batch.feedId, batch.id), batch);
  }

  async listFeedback(feedId: string): Promise<SweepFeedbackTrace[]> {
    return this.listJson<SweepFeedbackTrace>(this.feedbackPath(feedId));
  }

  async getFeedback(feedId: string, feedbackId: string): Promise<SweepFeedbackTrace> {
    return readJson<SweepFeedbackTrace>(this.feedbackFile(feedId, feedbackId));
  }

  async writeFeedback(trace: SweepFeedbackTrace): Promise<void> {
    await writeJson(this.feedbackFile(trace.feedId, trace.id), trace);
  }

  private async listJson<T>(directory: string): Promise<T[]> {
    if (!existsSync(directory)) return [];
    const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
    return Promise.all(files.map((file) => readJson<T>(path.join(directory, file))));
  }

  private stateFile(feedId: string): string {
    return path.join(this.dataDir, "feeds", feedId, "sweep-state.json");
  }

  private batchPath(feedId: string): string {
    return path.join(this.dataDir, "feeds", feedId, "sweeps");
  }

  private batchFile(feedId: string, batchId: string): string {
    return path.join(this.batchPath(feedId), `${batchId}.json`);
  }

  private feedbackPath(feedId: string): string {
    return path.join(this.dataDir, "feeds", feedId, "sweep-feedback");
  }

  private feedbackFile(feedId: string, feedbackId: string): string {
    return path.join(this.feedbackPath(feedId), `${feedbackId}.json`);
  }
}

export class MirroredSweepRepository implements SweepRepository {
  constructor(private readonly primary: SweepRepository, private readonly mirror: SweepRepository) {}

  async init(feedIds: string[]): Promise<void> {
    await this.mirror.init(feedIds);
    await this.primary.init(feedIds);
    for (const feedId of feedIds) await this.syncFeed(feedId);
  }

  hasState(feedId: string): Promise<boolean> {
    return this.primary.hasState(feedId);
  }

  readState(feedId: string): Promise<SweepState> {
    return this.primary.readState(feedId);
  }

  async writeState(feedId: string, state: SweepState): Promise<void> {
    await this.primary.writeState(feedId, state);
    await this.mirror.writeState(feedId, state);
  }

  listBatches(feedId: string): Promise<SweepBatch[]> {
    return this.primary.listBatches(feedId);
  }

  getBatch(feedId: string, batchId: string): Promise<SweepBatch> {
    return this.primary.getBatch(feedId, batchId);
  }

  async writeBatch(batch: SweepBatch): Promise<void> {
    await this.primary.writeBatch(batch);
    await this.mirror.writeBatch(batch);
  }

  listFeedback(feedId: string): Promise<SweepFeedbackTrace[]> {
    return this.primary.listFeedback(feedId);
  }

  getFeedback(feedId: string, feedbackId: string): Promise<SweepFeedbackTrace> {
    return this.primary.getFeedback(feedId, feedbackId);
  }

  async writeFeedback(trace: SweepFeedbackTrace): Promise<void> {
    await this.primary.writeFeedback(trace);
    await this.mirror.writeFeedback(trace);
  }

  private async syncFeed(feedId: string): Promise<void> {
    const [primaryHasState, mirrorHasState] = await Promise.all([this.primary.hasState(feedId), this.mirror.hasState(feedId)]);
    if (!primaryHasState && mirrorHasState) await this.primary.writeState(feedId, await this.mirror.readState(feedId));
    if (primaryHasState && !mirrorHasState) await this.mirror.writeState(feedId, await this.primary.readState(feedId));

    await this.syncBatches(feedId);
    await this.syncFeedback(feedId);
  }

  private async syncBatches(feedId: string): Promise<void> {
    const primary = await this.primary.listBatches(feedId);
    const mirror = await this.mirror.listBatches(feedId);
    const primaryIds = new Set(primary.map((batch) => batch.id));
    const mirrorIds = new Set(mirror.map((batch) => batch.id));
    for (const batch of mirror.filter((item) => !primaryIds.has(item.id))) await this.primary.writeBatch(batch);
    for (const batch of primary.filter((item) => !mirrorIds.has(item.id))) await this.mirror.writeBatch(batch);
  }

  private async syncFeedback(feedId: string): Promise<void> {
    const primary = await this.primary.listFeedback(feedId);
    const mirror = await this.mirror.listFeedback(feedId);
    const primaryIds = new Set(primary.map((trace) => trace.id));
    const mirrorIds = new Set(mirror.map((trace) => trace.id));
    for (const trace of mirror.filter((item) => !primaryIds.has(item.id))) await this.primary.writeFeedback(trace);
    for (const trace of primary.filter((item) => !mirrorIds.has(item.id))) await this.mirror.writeFeedback(trace);
  }
}
