import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { isoNow, readJson, writeJson } from "../util";

type WorkspaceFile = {
  version: number;
  feedIds: string[];
  createdAt: string;
};

export interface WorkspaceFeedRepository {
  init(defaultFeedIds: string[]): Promise<void>;
  listFeedIds(): Promise<string[]>;
  setFeedIds(feedIds: string[]): Promise<void>;
  addFeedId(feedId: string): Promise<void>;
  removeFeedId(feedId: string): Promise<void>;
}

export class FileWorkspaceFeedRepository implements WorkspaceFeedRepository {
  constructor(private readonly filePath: string) {}

  async init(defaultFeedIds: string[]): Promise<void> {
    if (!existsSync(this.filePath)) {
      await this.write({ version: 1, feedIds: defaultFeedIds, createdAt: isoNow() });
    }
  }

  async listFeedIds(): Promise<string[]> {
    const workspace = await this.read();
    return workspace.feedIds;
  }

  async setFeedIds(feedIds: string[]): Promise<void> {
    const workspace = await this.read();
    await this.write({ ...workspace, feedIds: unique(feedIds) });
  }

  async addFeedId(feedId: string): Promise<void> {
    const workspace = await this.read();
    await this.write({ ...workspace, feedIds: unique([...workspace.feedIds, feedId]) });
  }

  async removeFeedId(feedId: string): Promise<void> {
    const workspace = await this.read();
    await this.write({ ...workspace, feedIds: workspace.feedIds.filter((id) => id !== feedId) });
  }

  private async read(): Promise<WorkspaceFile> {
    return readJson<WorkspaceFile>(this.filePath);
  }

  private async write(workspace: WorkspaceFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeJson(this.filePath, workspace);
  }
}

export class MirroredWorkspaceFeedRepository implements WorkspaceFeedRepository {
  constructor(private readonly primary: WorkspaceFeedRepository, private readonly mirror: WorkspaceFeedRepository) {}

  async init(defaultFeedIds: string[]): Promise<void> {
    await this.mirror.init(defaultFeedIds);
    const mirrorIds = await this.mirror.listFeedIds();
    await this.primary.init(mirrorIds.length ? mirrorIds : defaultFeedIds);
    const merged = unique([...(await this.primary.listFeedIds()), ...mirrorIds]);
    await this.primary.setFeedIds(merged);
    await this.mirror.setFeedIds(merged);
  }

  listFeedIds(): Promise<string[]> {
    return this.primary.listFeedIds();
  }

  async setFeedIds(feedIds: string[]): Promise<void> {
    const next = unique(feedIds);
    await this.primary.setFeedIds(next);
    await this.mirror.setFeedIds(next);
  }

  async addFeedId(feedId: string): Promise<void> {
    await this.primary.addFeedId(feedId);
    await this.mirror.addFeedId(feedId);
  }

  async removeFeedId(feedId: string): Promise<void> {
    await this.primary.removeFeedId(feedId);
    await this.mirror.removeFeedId(feedId);
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
