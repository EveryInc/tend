import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { readJson, safeIdentifier, writeJson } from "../util";
import type { MirrorWriteCoordinator } from "./mirrorWrites";

export interface RawSnapshot {
  feedId: string;
  runId: string;
  sourceId: string;
  snapshotId: string;
  value: unknown;
}

export type RawSnapshotKey = Omit<RawSnapshot, "value">;

export interface RawSnapshotRepository {
  init(feedIds: string[]): Promise<void>;
  listKeys(feedId: string): Promise<RawSnapshotKey[]>;
  list(feedId: string): Promise<RawSnapshot[]>;
  get(feedId: string, runId: string, sourceId: string, snapshotId: string): Promise<unknown>;
  has(feedId: string, runId: string, sourceId: string, snapshotId: string): Promise<boolean>;
  write(snapshot: RawSnapshot): Promise<void>;
}

export class FileRawSnapshotRepository implements RawSnapshotRepository {
  constructor(private readonly dataDir: string) {}

  async init(_feedIds: string[]): Promise<void> {}

  async listKeys(feedId: string): Promise<RawSnapshotKey[]> {
    const root = this.feedRoot(feedId);
    if (!existsSync(root)) return [];
    const snapshots: RawSnapshotKey[] = [];
    for (const runId of await readdir(root)) {
      const runRoot = path.join(root, runId);
      for (const sourceId of await readdir(runRoot)) {
        const sourceRoot = path.join(runRoot, sourceId);
        for (const filename of (await readdir(sourceRoot)).filter((item) => item.endsWith(".json"))) {
          const snapshotId = filename.slice(0, -".json".length);
          snapshots.push({
            feedId,
            runId,
            sourceId,
            snapshotId,
          });
        }
      }
    }
    return snapshots;
  }

  async list(feedId: string): Promise<RawSnapshot[]> {
    return Promise.all((await this.listKeys(feedId)).map(async (key) => ({ ...key, value: await this.get(key.feedId, key.runId, key.sourceId, key.snapshotId) })));
  }

  async get(feedId: string, runId: string, sourceId: string, snapshotId: string): Promise<unknown> {
    return readJson(this.snapshotFile(feedId, runId, sourceId, snapshotId));
  }

  async has(feedId: string, runId: string, sourceId: string, snapshotId: string): Promise<boolean> {
    return existsSync(this.snapshotFile(feedId, runId, sourceId, snapshotId));
  }

  async write(snapshot: RawSnapshot): Promise<void> {
    const file = this.snapshotFile(snapshot.feedId, snapshot.runId, snapshot.sourceId, snapshot.snapshotId);
    if (existsSync(file)) throw new Error("Raw snapshots are immutable.");
    await writeJson(file, snapshot.value);
  }

  async repairMirror(snapshot: RawSnapshot): Promise<void> {
    await writeJson(this.snapshotFile(snapshot.feedId, snapshot.runId, snapshot.sourceId, snapshot.snapshotId), snapshot.value);
  }

  private feedRoot(feedId: string): string {
    return path.join(this.dataDir, "feeds", safeIdentifier(feedId, "Feed id"), "raw");
  }

  private snapshotFile(feedId: string, runId: string, sourceId: string, snapshotId: string): string {
    return path.join(
      this.feedRoot(feedId),
      safeIdentifier(runId, "Source run id"),
      safeIdentifier(sourceId, "Source id"),
      `${safeIdentifier(snapshotId, "Snapshot id")}.json`,
    );
  }
}

export class MirroredRawSnapshotRepository implements RawSnapshotRepository {
  constructor(
    private readonly primary: RawSnapshotRepository,
    private readonly mirror: FileRawSnapshotRepository,
    private readonly mirrorWrites?: MirrorWriteCoordinator,
  ) {}

  async init(feedIds: string[]): Promise<void> {
    await this.mirror.init(feedIds);
    await this.primary.init(feedIds);
    for (const feedId of feedIds) await this.syncFeed(feedId);
  }

  list(feedId: string): Promise<RawSnapshot[]> {
    return this.primary.list(feedId);
  }

  listKeys(feedId: string): Promise<RawSnapshotKey[]> {
    return this.primary.listKeys(feedId);
  }

  async get(feedId: string, runId: string, sourceId: string, snapshotId: string): Promise<unknown> {
    const value = await this.primary.get(feedId, runId, sourceId, snapshotId);
    try {
      if (await this.mirror.has(feedId, runId, sourceId, snapshotId)) {
        const mirrorValue = await this.mirror.get(feedId, runId, sourceId, snapshotId);
        if (JSON.stringify(mirrorValue) !== JSON.stringify(value)) {
          console.error(`Raw snapshot mirror conflict repaired from SQLite authority: ${feedId}/${runId}/${sourceId}/${snapshotId}`);
          await this.mirror.repairMirror({ feedId, runId, sourceId, snapshotId, value });
        }
      }
    } catch (error) {
      console.error("SQLite raw snapshot authority is available, but its filesystem mirror could not be verified:", error);
    }
    return value;
  }

  has(feedId: string, runId: string, sourceId: string, snapshotId: string): Promise<boolean> {
    return this.primary.has(feedId, runId, sourceId, snapshotId);
  }

  async write(snapshot: RawSnapshot): Promise<void> {
    await this.primary.write(snapshot);
    await this.writeMirror(() => this.mirror.write(snapshot));
  }

  private async syncFeed(feedId: string): Promise<void> {
    const primary = await this.primary.listKeys(feedId);
    let mirror: RawSnapshotKey[];
    try {
      mirror = await this.mirror.listKeys(feedId);
    } catch (error) {
      console.error("SQLite raw snapshot authority is available, but the filesystem mirror could not be scanned:", error);
      return;
    }
    const key = (item: RawSnapshotKey) => `${item.runId}:${item.sourceId}:${item.snapshotId}`;
    const primaryKeys = new Set(primary.map(key));
    const mirrorKeys = new Set(mirror.map(key));
    for (const snapshot of mirror.filter((item) => !primaryKeys.has(key(item)))) {
      await this.primary.write({ ...snapshot, value: await this.mirror.get(snapshot.feedId, snapshot.runId, snapshot.sourceId, snapshot.snapshotId) });
    }
    for (const snapshot of primary.filter((item) => !mirrorKeys.has(key(item)))) {
      try {
        await this.mirror.write({ ...snapshot, value: await this.primary.get(snapshot.feedId, snapshot.runId, snapshot.sourceId, snapshot.snapshotId) });
      } catch (error) {
        console.error("SQLite raw snapshot authority is available, but the filesystem mirror could not be repaired:", error);
      }
    }
  }

  private async writeMirror(callback: () => Promise<void>): Promise<void> {
    if (this.mirrorWrites) await this.mirrorWrites.write(callback);
    else await callback();
  }
}
