import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { readerLoginGuidance, type ReaderConfig, type ReaderReceipt } from "../shared/readers";
import type { SourceRun } from "../shared/types";
import { createReaderAdapters, parseReaderContent, ReaderExecutionError, type ReaderAdapter, type ReaderResult } from "./readerAdapters";
import type { AttentionStore } from "./store";
import { isoNow, writeJson } from "./util";

const MAX_PACKET_BYTES = 2 * 1024 * 1024;
const INPUT_SNAPSHOT_ID = "reader-input";
const OWNER_FILE = ".reader-owner.json";

interface ReaderOwner { pid: number; instanceId: string }

export interface StartReadersInput {
  feedId: string;
  sourceRunId: string;
  packet: string;
  readers: ReaderConfig[];
  promptSha256?: string;
}

export interface ReaderOutputSnapshot {
  type: "reader-output";
  readerId: string;
  inputSha256: string;
  outputSha256: string;
  output?: unknown;
  rawOutput: string;
  error?: string;
}

export interface ReaderRunnerOptions {
  adapters?: Partial<Record<ReaderConfig["adapter"], ReaderAdapter>>;
  timeoutMs?: number;
  onError?: (message: string) => void;
  /** Process-existence probe; injectable so ownership tests never depend on a real provider. */
  probePid?: (pid: number) => void;
}

export function readerHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,150}$/.test(value)) {
    throw new Error(`${label} must be a plain identifier.`);
  }
}

export function validateReaderConfigs(value: unknown): ReaderConfig[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) throw new Error("Choose between one and eight readers.");
  const ids = new Set<string>();
  return value.map((config) => {
    if (!config || typeof config !== "object") throw new Error("Reader configuration is required.");
    safeId(config.id, "Reader ID");
    if (ids.has(config.id)) throw new Error("Reader IDs must be unique.");
    ids.add(config.id);
    if (typeof config.label !== "string" || !config.label.trim() || config.label.length > 100) throw new Error("Reader label is required (100 characters maximum).");
    if (config.adapter !== "codex" && config.adapter !== "claude") throw new Error("Unsupported reader adapter.");
    if (typeof config.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:[\]-]{0,149}$/.test(config.model)) throw new Error("A plain model identifier is required.");
    const efforts = config.adapter === "claude" ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high", "xhigh", "max", "ultra"];
    if (!efforts.includes(config.effort)) throw new Error(`Unsupported ${config.adapter} reasoning effort.`);
    return { id: config.id, label: config.label.trim(), adapter: config.adapter, model: config.model, effort: config.effort };
  });
}

function configFromReceipt(receipt: ReaderReceipt): ReaderConfig {
  return { id: receipt.readerId, label: receipt.label, adapter: receipt.adapter, model: receipt.requestedModel, effort: receipt.requestedEffort };
}

function sameConfigs(receipts: ReaderReceipt[], configs: ReaderConfig[]): boolean {
  const sorted = (items: ReaderConfig[]) => items.sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(sorted(receipts.map(configFromReceipt))) === JSON.stringify(sorted([...configs]));
}

/** Compare the actual frozen input, not just hash claims in a card or request. */
export async function readReaderInputFingerprint(store: AttentionStore, feedId: string, sourceRunId: string, readerId: string): Promise<{ inputSha256: string; promptSha256: string }> {
  safeId(feedId, "Feed ID");
  safeId(sourceRunId, "Source run ID");
  safeId(readerId, "Reader ID");
  const run = await store.readRun(feedId, sourceRunId);
  if (run.feedId !== feedId || run.id !== sourceRunId) throw new Error("Reader input does not belong to this feed.");
  safeId(run.sourceId, "Source ID");
  const receipt = run.readers?.find((reader) => reader.readerId === readerId);
  if (!receipt || receipt.inputSnapshotId !== INPUT_SNAPSHOT_ID) throw new Error("Reader input reference is missing or invalid.");
  const input = JSON.parse(await readFile(store.feedPath(feedId, "raw", sourceRunId, run.sourceId, `${INPUT_SNAPSHOT_ID}.json`), "utf8"));
  if (input?.type !== "reader-input" || typeof input.packet !== "string" || readerHash(input.packet) !== receipt.inputSha256
    || input.inputSha256 !== receipt.inputSha256) throw new Error("Reader input does not match its frozen packet.");
  if (typeof input.promptSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.promptSha256)
    || input.promptSha256 !== receipt.promptSha256) throw new Error("A matching recorded prompt hash is required to link reader attempts.");
  return { inputSha256: receipt.inputSha256, promptSha256: input.promptSha256 };
}

/** Read only the hash-bound output; never trust a separately editable parsed mirror. */
export async function readReaderOutput(store: AttentionStore, feedId: string, sourceRunId: string, readerId: string): Promise<ReaderOutputSnapshot> {
  safeId(feedId, "Feed ID");
  safeId(sourceRunId, "Source run ID");
  safeId(readerId, "Reader ID");
  const run = await store.readRun(feedId, sourceRunId);
  if (run.feedId !== feedId || run.id !== sourceRunId) throw new Error("Source run does not belong to this feed.");
  safeId(run.sourceId, "Source ID");
  const receipt = run.readers?.find((item) => item.readerId === readerId);
  if (!receipt?.outputSnapshotId || !receipt.outputSha256) throw new Error("This reader has no recorded output yet.");
  const expectedId = `reader-output-${readerId}`;
  if (receipt.outputSnapshotId !== expectedId) throw new Error("Reader output reference is invalid.");
  const output = JSON.parse(await readFile(store.feedPath(feedId, "raw", sourceRunId, run.sourceId, `${expectedId}.json`), "utf8")) as ReaderOutputSnapshot;
  if (output.type !== "reader-output" || output.readerId !== readerId || output.inputSha256 !== receipt.inputSha256
    || output.outputSha256 !== receipt.outputSha256 || typeof output.rawOutput !== "string" || readerHash(output.rawOutput) !== receipt.outputSha256) {
    throw new Error("Reader output does not match its immutable receipt.");
  }
  return receipt.status === "complete" ? { ...output, output: parseReaderContent(output.rawOutput) } : output;
}

/** Owned by the existing local Tend server. Readers never receive a store or publication capability. */
export class ReaderRunner {
  private readonly adapters: Partial<Record<ReaderConfig["adapter"], ReaderAdapter>>;
  private readonly timeoutMs: number;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly owner: ReaderOwner = { pid: process.pid, instanceId: randomUUID() };
  private ownsRuntime = false;
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly store: AttentionStore, private readonly options: ReaderRunnerOptions = {}) {
    this.adapters = options.adapters ?? createReaderAdapters();
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("Reader timeout must be positive.");
  }

  start(input: StartReadersInput): Promise<SourceRun> {
    return this.track(() => this.startOwned(input));
  }

  private async startOwned(input: StartReadersInput): Promise<SourceRun> {
    safeId(input.feedId, "Feed ID");
    safeId(input.sourceRunId, "Source run ID");
    const configs = validateReaderConfigs(input.readers);
    if (configs.some((config) => !this.adapters[config.adapter])) throw new Error("A requested reader adapter is unavailable.");
    if (typeof input.packet !== "string" || !input.packet.trim() || Buffer.byteLength(input.packet) > MAX_PACKET_BYTES) {
      throw new Error("A nonempty reading packet of at most 2 MB is required; packets are never silently truncated.");
    }
    if (input.promptSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.promptSha256)) throw new Error("Prompt hash must be SHA-256.");
    const inputSha256 = readerHash(input.packet);
    return this.store.serialize(async () => {
      this.assertOpen();
      await this.claimOwnership();
      const current = await this.store.readRun(input.feedId, input.sourceRunId);
      this.assertRun(current, input.feedId, input.sourceRunId);
      if (!current.completedAt) throw new Error("Record the completed source collection before starting readers.");
      if (current.readers?.length) {
        if (!sameConfigs(current.readers, configs) || current.readers.some((receipt) => receipt.inputSha256 !== inputSha256 || receipt.promptSha256 !== input.promptSha256)) {
          throw new Error("This source run already has a different reader packet or configuration. Record a new source run; existing results are immutable.");
        }
        return current;
      }
      const snapshot = { type: "reader-input", inputSha256, ...(input.promptSha256 ? { promptSha256: input.promptSha256 } : {}), packet: input.packet };
      await this.ensureInputSnapshot(current, snapshot);
      current.readers = configs.map((config) => ({
        readerId: config.id, label: config.label, adapter: config.adapter,
        requestedModel: config.model, requestedEffort: config.effort, status: "queued",
        inputSha256, ...(input.promptSha256 ? { promptSha256: input.promptSha256 } : {}), inputSnapshotId: INPUT_SNAPSHOT_ID,
      }));
      await this.store.writeRun(current);
      try {
        await this.store.appendEvent({ feedId: current.feedId, type: "readers.queued", detail: { runId: current.id, readerIds: configs.map((config) => config.id), inputSha256 } });
      } catch (error) {
        // The receipts are already durable, but no adapter has been launched. Do not leave
        // an apparently running job that an identical retry can never actually resume.
        for (const receipt of current.readers) {
          receipt.status = "failed";
          receipt.finishedAt = isoNow();
          receipt.error = "Reader startup failed before any provider was launched. No automatic retry was attempted.";
        }
        await this.store.writeRun(current);
        throw error;
      }
      // Register before releasing the mutation lock so recovery cannot mistake this
      // run for abandoned work. runOne queues its first mutation behind this one.
      const key = this.key(input.feedId, input.sourceRunId);
      const controller = new AbortController();
      const signal = controller.signal;
      if (this.closed) controller.abort(new Error("The Tend reader runner is stopping."));
      const done = Promise.allSettled(configs.map((config) => this.runOne(current, config, input.packet, signal)))
        .then((results) => {
          for (const result of results) if (result.status === "rejected") {
            const message = `A reader result for ${current.id} could not be durably recorded; check the source run before retrying.`;
            if (this.options.onError) this.options.onError(message);
            else console.error(`[readers] ${message}`);
          }
        }).finally(() => this.active.delete(key));
      this.active.set(key, { controller, done });
      return current;
    });
  }

  async readOutput(feedId: string, sourceRunId: string, readerId: string): Promise<ReaderOutputSnapshot> {
    return readReaderOutput(this.store, feedId, sourceRunId, readerId);
  }

  /** Call once during server startup, before accepting new reader requests. Never reruns providers. */
  recoverInterrupted(): Promise<number> {
    return this.track(() => this.recoverOwned());
  }

  private async recoverOwned(): Promise<number> {
    await this.store.serialize(async () => {
      this.assertOpen();
      await this.claimOwnership();
    });
    let interrupted = 0;
    for (const feedId of await this.store.listFeedIds()) {
      for (const listed of (await this.store.readFeed(feedId)).runs) {
        if (this.active.has(this.key(feedId, listed.id)) || !listed.readers?.some((item) => item.status === "queued" || item.status === "running")) continue;
        await this.store.serialize(async () => {
          this.assertOpen();
          if (this.active.has(this.key(feedId, listed.id))) return;
          const run = await this.store.readRun(feedId, listed.id);
          for (const receipt of run.readers ?? []) {
            if (receipt.status !== "queued" && receipt.status !== "running") continue;
            receipt.status = "interrupted";
            receipt.finishedAt = isoNow();
            receipt.error = "The Tend server stopped before this reader completed. No automatic retry was attempted.";
            interrupted += 1;
          }
          await this.store.writeRun(run);
          await this.store.appendEvent({ feedId, type: "readers.interrupted", detail: { runId: run.id } });
        });
      }
    }
    return interrupted;
  }

  async waitForRun(feedId: string, sourceRunId: string): Promise<void> {
    await this.active.get(this.key(feedId, sourceRunId))?.done;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const task of this.active.values()) task.controller.abort(new Error("The Tend reader runner is stopping."));
    this.closing = (async () => {
      // A start already committing receipts will register an aborted task before it
      // settles. Keep ownership until those final interrupted receipts are durable.
      await Promise.allSettled(this.pending);
      await Promise.allSettled([...this.active.values()].map((task) => task.done));
      if (!this.ownsRuntime) return;
      await this.store.serialize(async () => {
        const owner = await this.readOwner();
        if (owner?.pid === this.owner.pid && owner.instanceId === this.owner.instanceId) {
          await rm(this.store.path(OWNER_FILE), { force: true });
        }
        this.ownsRuntime = false;
      });
    })();
    return this.closing;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Reader runner is closed.");
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Reader runner is closed."));
    const pending = operation();
    this.pending.add(pending);
    return pending.finally(() => this.pending.delete(pending));
  }

  /** Caller holds store.serialize; the ownership record is not a held mutation lock. */
  private async claimOwnership(): Promise<void> {
    const owner = await this.readOwner();
    if (owner?.pid === this.owner.pid && owner.instanceId === this.owner.instanceId) {
      this.ownsRuntime = true;
      return;
    }
    if (owner) {
      let dead = false;
      if (owner.pid !== this.owner.pid) {
        try {
          (this.options.probePid ?? ((pid) => { process.kill(pid, 0); }))(owner.pid);
        } catch (error) {
          // EPERM and other uncertainty must never authorize takeover of a live worker.
          dead = (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      }
      if (!dead) throw new Error(`Another Tend reader worker owns this runtime (pid ${owner.pid}).`);
    }
    await writeJson(this.store.path(OWNER_FILE), this.owner);
    this.ownsRuntime = true;
  }

  private async readOwner(): Promise<ReaderOwner | null> {
    let owner: ReaderOwner;
    try {
      owner = JSON.parse(await readFile(this.store.path(OWNER_FILE), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2_147_483_647
      || typeof owner.instanceId !== "string" || !owner.instanceId || owner.instanceId.length > 100) {
      throw new Error("The reader runtime owner record is invalid; refusing to take ownership.");
    }
    return owner;
  }

  private async runOne(run: SourceRun, config: ReaderConfig, packet: string, parentSignal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    // Keep the signal (and an early abort reason) alive while the receipt waits for the lock.
    const signal = controller.signal;
    const abort = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener("abort", abort, { once: true });
    if (parentSignal.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error("Reader timed out; no automatic retry was attempted.")), this.timeoutMs);
    try {
      const started = await this.updateReceipt(run, config.id, (receipt) => {
        if (receipt.status !== "queued") return false;
        receipt.status = "running";
        receipt.startedAt = isoNow();
        return true;
      });
      if (!started) return;
      if (signal.aborted) throw signal.reason;
      const adapter = this.adapters[config.adapter]!;
      const result = await this.abortable(adapter(config, packet, signal), signal);
      if (signal.aborted) throw signal.reason;
      if (typeof result.rawOutput !== "string" || !result.rawOutput.trim()) throw new Error("Reader returned no output.");
      const outputSha256 = readerHash(result.rawOutput);
      const outputSnapshotId = `reader-output-${config.id}`;
      await this.store.serialize(async () => {
        const current = await this.store.readRun(run.feedId, run.id);
        const receipt = this.receipt(current, config.id);
        if (receipt.status !== "running") return;
        if (signal.aborted) throw signal.reason;
        const snapshot: ReaderOutputSnapshot = { type: "reader-output", readerId: config.id, inputSha256: receipt.inputSha256, outputSha256, output: result.output, rawOutput: result.rawOutput };
        await this.store.writeRawSnapshot(run.feedId, run.id, run.sourceId, outputSnapshotId, snapshot);
        Object.assign(receipt, this.resultMetadata(result), { status: "complete", finishedAt: isoNow(), outputSha256, outputSnapshotId });
        await this.store.writeRun(current);
        await this.store.appendEvent({ feedId: run.feedId, type: "reader.completed", detail: { runId: run.id, readerId: config.id, outputSha256 } });
      });
    } catch (error) {
      const failureCode = error instanceof ReaderExecutionError ? error.failureCode : undefined;
      const message = failureCode === "subscription_login_required" ? readerLoginGuidance(config.adapter).message
        : error instanceof Error ? error.message : "Reader failed.";
      await this.store.serialize(async () => {
        const current = await this.store.readRun(run.feedId, run.id);
        const receipt = this.receipt(current, config.id);
        if (receipt.status === "complete" || receipt.status === "interrupted") return;
        if (error instanceof ReaderExecutionError && error.rawOutput) {
          const outputSha256 = readerHash(error.rawOutput);
          const outputSnapshotId = `reader-output-${config.id}`;
          const snapshot: ReaderOutputSnapshot = { type: "reader-output", readerId: config.id, inputSha256: receipt.inputSha256, outputSha256, rawOutput: error.rawOutput, error: message };
          await this.store.writeRawSnapshot(run.feedId, run.id, run.sourceId, outputSnapshotId, snapshot);
          receipt.outputSha256 = outputSha256;
          receipt.outputSnapshotId = outputSnapshotId;
        }
        receipt.status = parentSignal.aborted ? "interrupted" : "failed";
        receipt.finishedAt = isoNow();
        receipt.error = message.slice(0, 1200);
        if (failureCode) receipt.failureCode = failureCode;
        await this.store.writeRun(current);
        await this.store.appendEvent({ feedId: run.feedId, type: `reader.${receipt.status}`, detail: { runId: run.id, readerId: config.id, error: receipt.error, ...(failureCode ? { failureCode } : {}) } });
      });
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", abort);
    }
  }

  private resultMetadata(result: ReaderResult): Partial<ReaderReceipt> {
    return { ...(result.actualModel ? { actualModel: result.actualModel } : {}), ...(result.actualEffort ? { actualEffort: result.actualEffort } : {}),
      ...(result.authentication ? { authentication: result.authentication } : {}), ...(result.usage ? { usage: result.usage } : {}) };
  }

  private async updateReceipt(run: SourceRun, readerId: string, update: (receipt: ReaderReceipt) => boolean): Promise<boolean> {
    return this.store.serialize(async () => {
      const current = await this.store.readRun(run.feedId, run.id);
      if (!update(this.receipt(current, readerId))) return false;
      await this.store.writeRun(current);
      await this.store.appendEvent({ feedId: run.feedId, type: "reader.started", detail: { runId: run.id, readerId } });
      return true;
    });
  }

  private receipt(run: SourceRun, readerId: string): ReaderReceipt {
    const receipt = run.readers?.find((item) => item.readerId === readerId);
    if (!receipt) throw new Error("Reader receipt is missing from the source run.");
    return receipt;
  }

  private assertRun(run: SourceRun, feedId: string, runId: string): void {
    if (run.feedId !== feedId || run.id !== runId) throw new Error("Source run does not belong to this feed.");
    safeId(run.sourceId, "Source ID");
  }

  private async ensureInputSnapshot(run: SourceRun, snapshot: object): Promise<void> {
    try {
      const existing = await this.readSnapshot(run, INPUT_SNAPSHOT_ID);
      if (JSON.stringify(existing) !== JSON.stringify(snapshot)) throw new Error("An incompatible reader input snapshot already exists. Record a new source run.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.store.writeRawSnapshot(run.feedId, run.id, run.sourceId, INPUT_SNAPSHOT_ID, snapshot);
    }
  }

  private async readSnapshot(run: SourceRun, snapshotId: string): Promise<unknown> {
    return JSON.parse(await readFile(this.store.feedPath(run.feedId, "raw", run.id, run.sourceId, `${snapshotId}.json`), "utf8"));
  }

  private key(feedId: string, runId: string): string { return `${feedId}/${runId}`; }

  private async abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw signal.reason;
    let abort: (() => void) | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = promise.then(
        (value) => {
          if (signal.aborted) throw signal.reason ?? new Error("Reader interrupted.");
          return value;
        },
        (error) => {
          if (signal.aborted && !(error instanceof ReaderExecutionError)) {
            throw signal.reason ?? new Error("Reader interrupted.");
          }
          throw error;
        },
      );
      return await Promise.race([settled, new Promise<never>((_, reject) => {
        abort = () => {
          graceTimer = setTimeout(
            () => reject(signal.reason ?? new Error("Reader interrupted.")),
            Math.min(this.timeoutMs, 2_500),
          );
        };
        signal.addEventListener("abort", abort, { once: true });
      })]);
    } finally {
      if (graceTimer) clearTimeout(graceTimer);
      if (abort) signal.removeEventListener("abort", abort);
    }
  }
}
