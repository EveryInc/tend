import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { WorkItem } from "../../shared/types";
import { readJson, writeJson } from "../util";

export interface WorkItemRepository {
  init(feedIds: string[]): Promise<void>;
  list(feedId: string): Promise<WorkItem[]>;
  get(feedId: string, workId: string): Promise<WorkItem>;
  write(work: WorkItem): Promise<void>;
}

export class FileWorkItemRepository implements WorkItemRepository {
  constructor(private readonly dataDir: string) {}

  async init(_feedIds: string[]): Promise<void> {}

  async list(feedId: string): Promise<WorkItem[]> {
    const directory = this.workPath(feedId);
    if (!existsSync(directory)) return [];
    const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
    return Promise.all(files.map((file) => readJson<WorkItem>(path.join(directory, file))));
  }

  async get(feedId: string, workId: string): Promise<WorkItem> {
    return readJson<WorkItem>(this.workFile(feedId, workId));
  }

  async write(work: WorkItem): Promise<void> {
    await writeJson(this.workFile(work.feedId, work.id), work);
  }

  private workPath(feedId: string): string {
    return path.join(this.dataDir, "feeds", feedId, "work");
  }

  private workFile(feedId: string, workId: string): string {
    return path.join(this.workPath(feedId), `${workId}.json`);
  }
}

export class MirroredWorkItemRepository implements WorkItemRepository {
  constructor(private readonly primary: WorkItemRepository, private readonly mirror: WorkItemRepository) {}

  async init(feedIds: string[]): Promise<void> {
    await this.mirror.init(feedIds);
    await this.primary.init(feedIds);
    for (const feedId of feedIds) await this.syncFeed(feedId);
  }

  list(feedId: string): Promise<WorkItem[]> {
    return this.primary.list(feedId);
  }

  get(feedId: string, workId: string): Promise<WorkItem> {
    return this.primary.get(feedId, workId);
  }

  async write(work: WorkItem): Promise<void> {
    await this.primary.write(work);
    await this.mirror.write(work);
  }

  private async syncFeed(feedId: string): Promise<void> {
    const primary = await this.primary.list(feedId);
    const mirror = await this.mirror.list(feedId);
    const primaryIds = new Set(primary.map((work) => work.id));
    const mirrorIds = new Set(mirror.map((work) => work.id));
    for (const work of mirror.filter((item) => !primaryIds.has(item.id))) {
      await this.primary.write(work);
    }
    for (const work of primary.filter((item) => !mirrorIds.has(item.id))) {
      await this.mirror.write(work);
    }
  }
}
