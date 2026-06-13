import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { attentionDataDir, attentionDbPath, attentionHome } from "./paths";
import { FileCardRepository, MirroredCardRepository } from "./repositories/cards";
import { FileFeedEventRepository, MirroredFeedEventRepository } from "./repositories/feedEvents";
import { FileRevisionRepository, MirroredRevisionRepository } from "./repositories/revisions";
import { FileRoutineActionGroupRepository, MirroredRoutineActionGroupRepository } from "./repositories/routineActionGroups";
import { FileSourceRunRepository, MirroredSourceRunRepository } from "./repositories/sourceRuns";
import { FileSourceRepository, MirroredSourceRepository } from "./repositories/sources";
import { FileSweepRepository, MirroredSweepRepository } from "./repositories/sweeps";
import { FileTextDocumentRepository, MirroredTextDocumentRepository } from "./repositories/textDocuments";
import { FileWorkItemRepository, MirroredWorkItemRepository } from "./repositories/workItems";
import { FileWorkspaceFeedRepository, MirroredWorkspaceFeedRepository } from "./repositories/workspaceFeeds";
import { LocalSqliteStore } from "./sqlite";
import { AttentionStore } from "./store";

export function resolveRuntimeRoot(appRoot?: string): string {
  if (process.env.ATTENTION_HOME) return attentionHome();
  if (appRoot && isCanonicalSourceCheckout(appRoot)) return path.resolve(appRoot, "..", ".attention-workbench");
  return attentionHome();
}

export function resolveDataDir(appRoot?: string): string {
  return appRoot ? path.join(resolveRuntimeRoot(appRoot), "data") : attentionDataDir();
}

export function resolveDbPath(appRoot?: string): string {
  return appRoot ? path.join(resolveRuntimeRoot(appRoot), "attention.db") : attentionDbPath();
}

export function resolveArtifactsDir(appRoot?: string): string {
  return path.join(resolveRuntimeRoot(appRoot), "output");
}

export async function createLocalRuntime(
  dataDir = resolveDataDir(),
  dbPath = path.join(path.dirname(dataDir), "attention.db"),
): Promise<{ dataDir: string; sqlite: LocalSqliteStore; store: AttentionStore }> {
  await mkdir(dataDir, { recursive: true });
  const sqlite = new LocalSqliteStore(dbPath);
  await sqlite.init();
  const workspaceFeeds = new MirroredWorkspaceFeedRepository(
    sqlite.workspaceFeeds(),
    new FileWorkspaceFeedRepository(path.join(dataDir, "workspace.json")),
  );
  const events = new MirroredFeedEventRepository(
    sqlite.feedEvents(),
    new FileFeedEventRepository(dataDir),
  );
  const revisions = new MirroredRevisionRepository(
    sqlite.revisions(),
    new FileRevisionRepository(dataDir),
  );
  const workItems = new MirroredWorkItemRepository(
    sqlite.workItems(),
    new FileWorkItemRepository(dataDir),
  );
  const cards = new MirroredCardRepository(
    sqlite.cards(),
    new FileCardRepository(dataDir),
  );
  const routineActionGroups = new MirroredRoutineActionGroupRepository(
    sqlite.routineActionGroups(),
    new FileRoutineActionGroupRepository(dataDir),
  );
  const sourceRuns = new MirroredSourceRunRepository(
    sqlite.sourceRuns(),
    new FileSourceRunRepository(dataDir),
  );
  const sources = new MirroredSourceRepository(
    sqlite.sources(),
    new FileSourceRepository(dataDir),
  );
  const sweeps = new MirroredSweepRepository(
    sqlite.sweeps(),
    new FileSweepRepository(dataDir),
  );
  const textDocuments = new MirroredTextDocumentRepository(
    sqlite.textDocuments(),
    new FileTextDocumentRepository(dataDir),
  );
  const store = new AttentionStore(dataDir, { cards, events, revisions, routineActionGroups, sourceRuns, sources, sweeps, textDocuments, workItems, workspaceFeeds });
  await store.init();
  return { dataDir, sqlite, store };
}

function isCanonicalSourceCheckout(appRoot: string): boolean {
  try {
    const gitDir = path.join(appRoot, ".git");
    return path.basename(appRoot) === "attention"
      && existsSync(path.join(appRoot, "bin", "tend-live"))
      && statSync(gitDir).isDirectory()
      && readFileSync(path.join(gitDir, "HEAD"), "utf8").trim() === "ref: refs/heads/main";
  } catch {
    return false;
  }
}
