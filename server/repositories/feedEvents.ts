import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { FeedEvent } from "../../src/types";

export interface FeedEventRepository {
  init(feedIds: string[]): Promise<void>;
  append(event: FeedEvent): Promise<void>;
  list(feedId: string): Promise<FeedEvent[]>;
}

export class FileFeedEventRepository implements FeedEventRepository {
  constructor(private readonly dataDir: string) {}

  async init(_feedIds: string[]): Promise<void> {}

  async append(event: FeedEvent): Promise<void> {
    await mkdir(this.feedPath(event.feedId), { recursive: true });
    await appendFile(this.eventsPath(event.feedId), `${JSON.stringify(event)}\n`, "utf8");
  }

  async list(feedId: string): Promise<FeedEvent[]> {
    const file = this.eventsPath(feedId);
    if (!existsSync(file)) return [];
    return (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as FeedEvent);
  }

  private feedPath(feedId: string): string {
    return path.join(this.dataDir, "feeds", feedId);
  }

  private eventsPath(feedId: string): string {
    return path.join(this.feedPath(feedId), "events.jsonl");
  }
}

export class MirroredFeedEventRepository implements FeedEventRepository {
  constructor(private readonly primary: FeedEventRepository, private readonly mirror: FeedEventRepository) {}

  async init(feedIds: string[]): Promise<void> {
    await this.mirror.init(feedIds);
    await this.primary.init(feedIds);
    await Promise.all(feedIds.map((feedId) => this.syncFeed(feedId)));
  }

  async append(event: FeedEvent): Promise<void> {
    await this.primary.append(event);
    await this.mirror.append(event);
  }

  list(feedId: string): Promise<FeedEvent[]> {
    return this.primary.list(feedId);
  }

  private async syncFeed(feedId: string): Promise<void> {
    const primary = await this.primary.list(feedId);
    const mirror = await this.mirror.list(feedId);
    const primaryIds = new Set(primary.map((event) => event.id));
    const mirrorIds = new Set(mirror.map((event) => event.id));
    for (const event of mirror.filter((item) => !primaryIds.has(item.id))) {
      await this.primary.append(event);
    }
    for (const event of primary.filter((item) => !mirrorIds.has(item.id))) {
      await this.mirror.append(event);
    }
  }
}
