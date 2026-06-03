import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SourceRecipe } from "../../src/types";
import { readJson, writeJson, writeText } from "../util";

export interface SourceRecord {
  recipe: SourceRecipe;
  content: string;
  checkpoint: unknown;
}

export interface SourceRepository {
  init(feedIds: string[]): Promise<void>;
  list(feedId: string): Promise<SourceRecord[]>;
  get(feedId: string, sourceId: string): Promise<SourceRecord>;
  write(feedId: string, recipe: SourceRecipe, content: string, checkpoint?: unknown): Promise<void>;
  remove(feedId: string, sourceId: string): Promise<void>;
  writeContent(feedId: string, sourceId: string, content: string): Promise<void>;
  writeCheckpoint(feedId: string, sourceId: string, checkpoint: unknown): Promise<void>;
}

export function defaultCheckpoint(sourceId: string): unknown {
  return { sourceId, updatedAt: null, cursor: null };
}

export class FileSourceRepository implements SourceRepository {
  constructor(private readonly dataDir: string) {}

  async init(_feedIds: string[]): Promise<void> {}

  async list(feedId: string): Promise<SourceRecord[]> {
    if (!existsSync(this.sourcesFile(feedId))) return [];
    const recipes = await readJson<SourceRecipe[]>(this.sourcesFile(feedId));
    return Promise.all(recipes.map((recipe) => this.record(feedId, recipe)));
  }

  async get(feedId: string, sourceId: string): Promise<SourceRecord> {
    const recipes = existsSync(this.sourcesFile(feedId)) ? await readJson<SourceRecipe[]>(this.sourcesFile(feedId)) : [];
    const recipe = recipes.find((item) => item.id === sourceId);
    if (!recipe) throw new Error(`Source recipe not found: ${sourceId}`);
    return this.record(feedId, recipe);
  }

  async write(feedId: string, recipe: SourceRecipe, content: string, checkpoint?: unknown): Promise<void> {
    const recipes = existsSync(this.sourcesFile(feedId)) ? await readJson<SourceRecipe[]>(this.sourcesFile(feedId)) : [];
    const checkpointFile = this.checkpointFile(feedId, recipe);
    const nextCheckpoint = checkpoint === undefined
      ? existsSync(checkpointFile) ? await readJson<unknown>(checkpointFile) : defaultCheckpoint(recipe.id)
      : checkpoint;
    await writeJson(this.sourcesFile(feedId), [...recipes.filter((item) => item.id !== recipe.id), recipe]);
    await writeText(this.contentFile(feedId, recipe), content);
    await writeJson(checkpointFile, nextCheckpoint);
  }

  async remove(feedId: string, sourceId: string): Promise<void> {
    const recipes = existsSync(this.sourcesFile(feedId)) ? await readJson<SourceRecipe[]>(this.sourcesFile(feedId)) : [];
    if (!recipes.some((item) => item.id === sourceId)) throw new Error(`Source recipe not found: ${sourceId}`);
    await writeJson(this.sourcesFile(feedId), recipes.filter((item) => item.id !== sourceId));
  }

  async writeContent(feedId: string, sourceId: string, content: string): Promise<void> {
    const { recipe } = await this.get(feedId, sourceId);
    await writeText(this.contentFile(feedId, recipe), content);
  }

  async writeCheckpoint(feedId: string, sourceId: string, checkpoint: unknown): Promise<void> {
    const { recipe } = await this.get(feedId, sourceId);
    await writeJson(this.checkpointFile(feedId, recipe), checkpoint);
  }

  private async record(feedId: string, recipe: SourceRecipe): Promise<SourceRecord> {
    const checkpointFile = this.checkpointFile(feedId, recipe);
    return {
      recipe,
      content: await readFile(this.contentFile(feedId, recipe), "utf8"),
      checkpoint: existsSync(checkpointFile) ? await readJson<unknown>(checkpointFile) : defaultCheckpoint(recipe.id),
    };
  }

  private sourcesFile(feedId: string): string {
    return path.join(this.dataDir, "feeds", feedId, "sources.json");
  }

  private contentFile(feedId: string, recipe: SourceRecipe): string {
    return path.join(this.dataDir, "feeds", feedId, "sources", recipe.filename);
  }

  private checkpointFile(feedId: string, recipe: SourceRecipe): string {
    return path.join(this.dataDir, "feeds", feedId, "checkpoints", recipe.checkpointFilename);
  }
}

export class MirroredSourceRepository implements SourceRepository {
  constructor(private readonly primary: SourceRepository, private readonly mirror: SourceRepository) {}

  async init(feedIds: string[]): Promise<void> {
    await this.mirror.init(feedIds);
    await this.primary.init(feedIds);
    for (const feedId of feedIds) await this.syncFeed(feedId);
  }

  list(feedId: string): Promise<SourceRecord[]> {
    return this.primary.list(feedId);
  }

  get(feedId: string, sourceId: string): Promise<SourceRecord> {
    return this.primary.get(feedId, sourceId);
  }

  async write(feedId: string, recipe: SourceRecipe, content: string, checkpoint?: unknown): Promise<void> {
    await this.primary.write(feedId, recipe, content, checkpoint);
    await this.mirror.write(feedId, recipe, content, checkpoint);
  }

  async remove(feedId: string, sourceId: string): Promise<void> {
    await this.primary.remove(feedId, sourceId);
    await this.mirror.remove(feedId, sourceId);
  }

  async writeContent(feedId: string, sourceId: string, content: string): Promise<void> {
    await this.primary.writeContent(feedId, sourceId, content);
    await this.mirror.writeContent(feedId, sourceId, content);
  }

  async writeCheckpoint(feedId: string, sourceId: string, checkpoint: unknown): Promise<void> {
    await this.primary.writeCheckpoint(feedId, sourceId, checkpoint);
    await this.mirror.writeCheckpoint(feedId, sourceId, checkpoint);
  }

  private async syncFeed(feedId: string): Promise<void> {
    const primary = await this.primary.list(feedId);
    const mirror = await this.mirror.list(feedId);
    const primaryIds = new Set(primary.map((record) => record.recipe.id));
    const mirrorIds = new Set(mirror.map((record) => record.recipe.id));
    for (const record of mirror.filter((item) => !primaryIds.has(item.recipe.id))) {
      await this.primary.write(feedId, record.recipe, record.content, record.checkpoint);
    }
    for (const record of primary.filter((item) => !mirrorIds.has(item.recipe.id))) {
      await this.mirror.write(feedId, record.recipe, record.content, record.checkpoint);
    }
  }
}
