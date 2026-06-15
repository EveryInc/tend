import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Card } from "../../shared/types";
import { readJson, safeIdentifier, writeJson } from "../util";
import type { MirrorWriteCoordinator } from "./mirrorWrites";

export interface CardRepository {
  init(feedIds: string[]): Promise<void>;
  list(feedId: string): Promise<Card[]>;
  get(feedId: string, cardId: string): Promise<Card>;
  has(feedId: string, cardId: string): Promise<boolean>;
  write(card: Card): Promise<void>;
  remove(feedId: string, cardId: string): Promise<void>;
}

export class FileCardRepository implements CardRepository {
  constructor(private readonly dataDir: string) {}

  async init(_feedIds: string[]): Promise<void> {}

  async list(feedId: string): Promise<Card[]> {
    const directory = this.cardPath(feedId);
    if (!existsSync(directory)) return [];
    const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
    return Promise.all(files.map((file) => readJson<Card>(path.join(directory, file))));
  }

  async get(feedId: string, cardId: string): Promise<Card> {
    return readJson<Card>(this.cardFile(feedId, cardId));
  }

  async has(feedId: string, cardId: string): Promise<boolean> {
    return existsSync(this.cardFile(feedId, cardId));
  }

  async write(card: Card): Promise<void> {
    await writeJson(this.cardFile(card.feedId, card.id), card);
  }

  async remove(feedId: string, cardId: string): Promise<void> {
    await mkdir(this.cardPath(feedId), { recursive: true });
    await rm(this.cardFile(feedId, cardId), { force: true });
  }

  private cardPath(feedId: string): string {
    return path.join(this.dataDir, "feeds", safeIdentifier(feedId, "Feed id"), "cards");
  }

  private cardFile(feedId: string, cardId: string): string {
    return path.join(this.cardPath(feedId), `${safeIdentifier(cardId, "Card id")}.json`);
  }
}

export class MirroredCardRepository implements CardRepository {
  constructor(
    private readonly primary: CardRepository,
    private readonly mirror: CardRepository,
    private readonly mirrorWrites?: MirrorWriteCoordinator,
  ) {}

  async init(feedIds: string[]): Promise<void> {
    await this.mirror.init(feedIds);
    await this.primary.init(feedIds);
    for (const feedId of feedIds) await this.syncFeed(feedId);
  }

  list(feedId: string): Promise<Card[]> {
    return this.primary.list(feedId);
  }

  get(feedId: string, cardId: string): Promise<Card> {
    return this.primary.get(feedId, cardId);
  }

  has(feedId: string, cardId: string): Promise<boolean> {
    return this.primary.has(feedId, cardId);
  }

  async write(card: Card): Promise<void> {
    await this.primary.write(card);
    await this.writeMirror(() => this.mirror.write(card));
  }

  async remove(feedId: string, cardId: string): Promise<void> {
    await this.primary.remove(feedId, cardId);
    await this.writeMirror(() => this.mirror.remove(feedId, cardId));
  }

  private async syncFeed(feedId: string): Promise<void> {
    const primary = await this.primary.list(feedId);
    const mirror = await this.mirror.list(feedId);
    const primaryIds = new Set(primary.map((card) => card.id));
    for (const card of mirror.filter((item) => !primaryIds.has(item.id))) {
      await this.primary.write(card);
    }
    for (const card of primary) {
      await this.mirror.write(card);
    }
  }

  private async writeMirror(callback: () => Promise<void>): Promise<void> {
    if (this.mirrorWrites) await this.mirrorWrites.write(callback);
    else await callback();
  }
}
