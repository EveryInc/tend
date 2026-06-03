import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { RoutineActionGroup } from "../../src/types";
import { readJson, writeJson } from "../util";

export interface RoutineActionGroupRepository {
  init(feedIds: string[]): Promise<void>;
  list(feedId: string): Promise<RoutineActionGroup[]>;
  get(feedId: string, groupId: string): Promise<RoutineActionGroup>;
  has(feedId: string, groupId: string): Promise<boolean>;
  write(group: RoutineActionGroup): Promise<void>;
}

export class FileRoutineActionGroupRepository implements RoutineActionGroupRepository {
  constructor(private readonly dataDir: string) {}

  async init(_feedIds: string[]): Promise<void> {}

  async list(feedId: string): Promise<RoutineActionGroup[]> {
    const directory = this.groupPath(feedId);
    if (!existsSync(directory)) return [];
    const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
    return Promise.all(files.map((file) => readJson<RoutineActionGroup>(path.join(directory, file))));
  }

  async get(feedId: string, groupId: string): Promise<RoutineActionGroup> {
    return readJson<RoutineActionGroup>(this.groupFile(feedId, groupId));
  }

  async has(feedId: string, groupId: string): Promise<boolean> {
    return existsSync(this.groupFile(feedId, groupId));
  }

  async write(group: RoutineActionGroup): Promise<void> {
    await writeJson(this.groupFile(group.feedId, group.id), group);
  }

  private groupPath(feedId: string): string {
    return path.join(this.dataDir, "feeds", feedId, "routine-actions");
  }

  private groupFile(feedId: string, groupId: string): string {
    return path.join(this.groupPath(feedId), `${groupId}.json`);
  }
}

export class MirroredRoutineActionGroupRepository implements RoutineActionGroupRepository {
  constructor(private readonly primary: RoutineActionGroupRepository, private readonly mirror: RoutineActionGroupRepository) {}

  async init(feedIds: string[]): Promise<void> {
    await this.mirror.init(feedIds);
    await this.primary.init(feedIds);
    for (const feedId of feedIds) await this.syncFeed(feedId);
  }

  list(feedId: string): Promise<RoutineActionGroup[]> {
    return this.primary.list(feedId);
  }

  get(feedId: string, groupId: string): Promise<RoutineActionGroup> {
    return this.primary.get(feedId, groupId);
  }

  has(feedId: string, groupId: string): Promise<boolean> {
    return this.primary.has(feedId, groupId);
  }

  async write(group: RoutineActionGroup): Promise<void> {
    await this.primary.write(group);
    await this.mirror.write(group);
  }

  private async syncFeed(feedId: string): Promise<void> {
    const primary = await this.primary.list(feedId);
    const mirror = await this.mirror.list(feedId);
    const primaryIds = new Set(primary.map((group) => group.id));
    const mirrorIds = new Set(mirror.map((group) => group.id));
    for (const group of mirror.filter((item) => !primaryIds.has(item.id))) {
      await this.primary.write(group);
    }
    for (const group of primary.filter((item) => !mirrorIds.has(item.id))) {
      await this.mirror.write(group);
    }
  }
}
