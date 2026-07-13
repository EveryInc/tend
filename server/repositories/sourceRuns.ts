import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { SourceRun } from "../../shared/types";
import { readJson, writeJson } from "../util";
import type { MirrorWriteCoordinator } from "./mirrorWrites";

export interface SourceRunRepository {
  init(feedIds: string[]): Promise<void>;
  list(feedId: string): Promise<SourceRun[]>;
  get(feedId: string, runId: string): Promise<SourceRun>;
  write(run: SourceRun): Promise<void>;
}

export class FileSourceRunRepository implements SourceRunRepository {
  constructor(private readonly dataDir: string) {}

  async init(_feedIds: string[]): Promise<void> {}

  async list(feedId: string): Promise<SourceRun[]> {
    const directory = this.runPath(feedId);
    if (!existsSync(directory)) return [];
    const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
    return Promise.all(files.map((file) => readJson<SourceRun>(path.join(directory, file))));
  }

  async get(feedId: string, runId: string): Promise<SourceRun> {
    return readJson<SourceRun>(this.runFile(feedId, runId));
  }

  async write(run: SourceRun): Promise<void> {
    await writeJson(this.runFile(run.feedId, run.id), run);
  }

  private runPath(feedId: string): string {
    return path.join(this.dataDir, "feeds", feedId, "runs");
  }

  private runFile(feedId: string, runId: string): string {
    return path.join(this.runPath(feedId), `${runId}.json`);
  }
}

export class MirroredSourceRunRepository implements SourceRunRepository {
  constructor(
    private readonly primary: SourceRunRepository,
    private readonly mirror: SourceRunRepository,
    private readonly mirrorWrites?: MirrorWriteCoordinator,
  ) {}

  async init(feedIds: string[]): Promise<void> {
    await this.mirror.init(feedIds);
    await this.primary.init(feedIds);
    for (const feedId of feedIds) await this.syncFeed(feedId);
  }

  list(feedId: string): Promise<SourceRun[]> {
    return this.primary.list(feedId);
  }

  get(feedId: string, runId: string): Promise<SourceRun> {
    return this.primary.get(feedId, runId);
  }

  async write(run: SourceRun): Promise<void> {
    await this.primary.write(run);
    await this.writeMirror(() => this.mirror.write(run));
  }

  private async syncFeed(feedId: string): Promise<void> {
    const primary = await this.primary.list(feedId);
    const mirror = await this.mirror.list(feedId);
    const primaryIds = new Set(primary.map((run) => run.id));
    const mirrorIds = new Set(mirror.map((run) => run.id));
    for (const run of mirror.filter((item) => !primaryIds.has(item.id))) {
      await this.primary.write(run);
    }
    for (const run of primary.filter((item) => !mirrorIds.has(item.id))) {
      await this.mirror.write(run);
    }
  }

  private async writeMirror(callback: () => Promise<void>): Promise<void> {
    if (this.mirrorWrites) await this.mirrorWrites.write(callback);
    else await callback();
  }
}
