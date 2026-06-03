import { mkdir } from "node:fs/promises";
import path from "node:path";
import { attentionDataDir } from "./paths";
import { FileFeedEventRepository, MirroredFeedEventRepository } from "./repositories/feedEvents";
import { FileWorkItemRepository, MirroredWorkItemRepository } from "./repositories/workItems";
import { FileWorkspaceFeedRepository, MirroredWorkspaceFeedRepository } from "./repositories/workspaceFeeds";
import { LocalSqliteStore } from "./sqlite";
import { AttentionStore } from "./store";

export async function createLocalRuntime(dataDir = attentionDataDir()): Promise<{ dataDir: string; sqlite: LocalSqliteStore; store: AttentionStore }> {
  await mkdir(dataDir, { recursive: true });
  const sqlite = new LocalSqliteStore();
  await sqlite.init();
  const workspaceFeeds = new MirroredWorkspaceFeedRepository(
    sqlite.workspaceFeeds(),
    new FileWorkspaceFeedRepository(path.join(dataDir, "workspace.json")),
  );
  const events = new MirroredFeedEventRepository(
    sqlite.feedEvents(),
    new FileFeedEventRepository(dataDir),
  );
  const workItems = new MirroredWorkItemRepository(
    sqlite.workItems(),
    new FileWorkItemRepository(dataDir),
  );
  const store = new AttentionStore(dataDir, { events, workItems, workspaceFeeds });
  await store.init();
  return { dataDir, sqlite, store };
}
