import { mkdir } from "node:fs/promises";
import path from "node:path";
import { attentionDataDir, attentionDbPath, attentionHome } from "./paths";
import { FileCardRepository, MirroredCardRepository } from "./repositories/cards";
import { FileFeedEventRepository, MirroredFeedEventRepository } from "./repositories/feedEvents";
import { FileMindContextRepository, MirroredMindContextRepository } from "./repositories/mindContext";
import { FileMobileCommandReceiptRepository, MirroredMobileCommandReceiptRepository } from "./repositories/mobileCommandReceipts";
import { MirrorWriteCoordinator } from "./repositories/mirrorWrites";
import { FileRevisionRepository, MirroredRevisionRepository } from "./repositories/revisions";
import { FileRoutineActionGroupRepository, MirroredRoutineActionGroupRepository } from "./repositories/routineActionGroups";
import { FileRawSnapshotRepository, MirroredRawSnapshotRepository } from "./repositories/rawSnapshots";
import { FileSourceRunRepository, MirroredSourceRunRepository } from "./repositories/sourceRuns";
import { FileSourceRepository, MirroredSourceRepository } from "./repositories/sources";
import { FileSweepRepository, MirroredSweepRepository } from "./repositories/sweeps";
import { FileTextDocumentRepository, MirroredTextDocumentRepository } from "./repositories/textDocuments";
import { FileWorkItemRepository, MirroredWorkItemRepository } from "./repositories/workItems";
import { FileWorkspaceFeedRepository, MirroredWorkspaceFeedRepository } from "./repositories/workspaceFeeds";
import { LocalSqliteStore } from "./sqlite";
import { AttentionStore } from "./store";

export function resolveRuntimeRoot(_appRoot?: string): string {
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
  const mirrorWrites = new MirrorWriteCoordinator();
  const workspaceFeeds = new MirroredWorkspaceFeedRepository(
    sqlite.workspaceFeeds(),
    new FileWorkspaceFeedRepository(path.join(dataDir, "workspace.json")),
  );
  const events = new MirroredFeedEventRepository(
    sqlite.feedEvents(),
    new FileFeedEventRepository(dataDir),
    mirrorWrites,
  );
  const mindContext = new MirroredMindContextRepository(
    sqlite.mindContext(),
    new FileMindContextRepository(dataDir),
  );
  const mobileCommandReceipts = new MirroredMobileCommandReceiptRepository(
    sqlite.mobileCommandReceipts(),
    new FileMobileCommandReceiptRepository(dataDir),
    mirrorWrites,
  );
  const revisions = new MirroredRevisionRepository(
    sqlite.revisions(),
    new FileRevisionRepository(dataDir),
  );
  const workItems = new MirroredWorkItemRepository(
    sqlite.workItems(),
    new FileWorkItemRepository(dataDir),
    mirrorWrites,
  );
  const cards = new MirroredCardRepository(
    sqlite.cards(),
    new FileCardRepository(dataDir),
    mirrorWrites,
  );
  const routineActionGroups = new MirroredRoutineActionGroupRepository(
    sqlite.routineActionGroups(),
    new FileRoutineActionGroupRepository(dataDir),
    mirrorWrites,
  );
  const sourceRuns = new MirroredSourceRunRepository(
    sqlite.sourceRuns(),
    new FileSourceRunRepository(dataDir),
    mirrorWrites,
  );
  const rawSnapshots = new MirroredRawSnapshotRepository(
    sqlite.rawSnapshots(),
    new FileRawSnapshotRepository(dataDir),
    mirrorWrites,
  );
  const sources = new MirroredSourceRepository(
    sqlite.sources(),
    new FileSourceRepository(dataDir),
    mirrorWrites,
  );
  const sweeps = new MirroredSweepRepository(
    sqlite.sweeps(),
    new FileSweepRepository(dataDir),
    mirrorWrites,
  );
  const textDocuments = new MirroredTextDocumentRepository(
    sqlite.textDocuments(),
    new FileTextDocumentRepository(dataDir),
  );
  const store = new AttentionStore(dataDir, {
    cards,
    events,
    mindContext,
    mobileCommandReceipts,
    revisions,
    routineActionGroups,
    rawSnapshots,
    runAtomic: (callback) => mirrorWrites.transaction(() => sqlite.transaction(callback)),
    sourceRuns,
    sources,
    sweeps,
    textDocuments,
    workItems,
    workspaceFeeds,
  });
  await store.init();
  return { dataDir, sqlite, store };
}
