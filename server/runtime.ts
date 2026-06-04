import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
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
import { readJson, writeJson } from "./util";

const HANDOFF_FILENAME = "runtime-handoff.json";
const RETIRED_FILENAME = ".tend-retired.json";

export interface RuntimeDriftEntry {
  path: string;
  status: "missing_live" | "conflict";
  legacyModifiedAt: string;
  liveModifiedAt?: string;
}

export interface RuntimeDriftReport {
  liveDataDir: string;
  legacyDataDir: string;
  since?: string;
  identicalCount: number;
  entries: RuntimeDriftEntry[];
}

export interface RuntimeHandoffMarker {
  createdAt: string;
  liveRuntimeRoot?: string;
  liveDataDir: string;
  liveDbPath?: string;
  legacyRuntimeRoots?: string[];
  legacyDataDirs: string[];
}

export interface RetiredRuntimeMarker {
  retiredAt: string;
  liveRuntimeRoot?: string;
  liveDataDir: string;
  liveDbPath?: string;
}

export function resolveRuntimeRoot(_appRoot?: string): string {
  return process.env.ATTENTION_RUNTIME_DIR ?? attentionHome();
}

export function resolveDataDir(_appRoot?: string): string {
  return process.env.ATTENTION_DATA_DIR ?? attentionDataDir();
}

export function resolveDbPath(_appRoot?: string): string {
  return process.env.ATTENTION_DB_PATH ?? path.join(resolveRuntimeRoot(_appRoot), "attention.db");
}

export function resolveArtifactsDir(appRoot?: string): string {
  return process.env.ATTENTION_ARTIFACTS_DIR ?? path.join(resolveRuntimeRoot(appRoot), "output");
}

export async function createLocalRuntime(dataDir = resolveDataDir()): Promise<{ dataDir: string; sqlite: LocalSqliteStore; store: AttentionStore }> {
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

export async function writeRuntimeHandoffMarker(runtimeRoot: string, liveDataDir: string, legacyDataDir: string): Promise<RuntimeHandoffMarker> {
  const liveRoot = path.resolve(runtimeRoot);
  const live = path.resolve(liveDataDir);
  const liveDb = path.join(liveRoot, "attention.db");
  const legacy = path.resolve(legacyDataDir);
  const legacyRoot = runtimeRootForDataDir(legacy);
  if (liveRoot === legacyRoot || live === legacy) throw new Error("Live and legacy runtime directories must be different.");
  const existing = await readRuntimeHandoffMarker(runtimeRoot);
  if (existing && path.resolve(existing.liveDataDir) !== live) throw new Error("Runtime handoff marker points to a different live data directory.");
  if (existing?.liveRuntimeRoot && path.resolve(existing.liveRuntimeRoot) !== liveRoot) throw new Error("Runtime handoff marker points to a different live runtime root.");
  const marker: RuntimeHandoffMarker = existing
    ? {
      ...existing,
      liveRuntimeRoot: existing.liveRuntimeRoot ?? liveRoot,
      liveDbPath: existing.liveDbPath ?? liveDb,
      legacyRuntimeRoots: [...new Set([...(existing.legacyRuntimeRoots ?? []), legacyRoot])],
      legacyDataDirs: [...new Set([...existing.legacyDataDirs, legacy])],
    }
    : {
      createdAt: new Date().toISOString(),
      liveRuntimeRoot: liveRoot,
      liveDataDir: live,
      liveDbPath: liveDb,
      legacyRuntimeRoots: [legacyRoot],
      legacyDataDirs: [legacy],
    };
  await writeJson(path.join(runtimeRoot, HANDOFF_FILENAME), marker);
  await freezeRetiredRuntimeDataDir(legacy, live, marker.createdAt);
  return marker;
}

export async function readRuntimeHandoffMarker(runtimeRoot: string): Promise<RuntimeHandoffMarker | null> {
  const filename = path.join(runtimeRoot, HANDOFF_FILENAME);
  return existsSync(filename) ? readJson<RuntimeHandoffMarker>(filename) : null;
}

export async function readRetiredRuntimeMarker(dataDir: string): Promise<RetiredRuntimeMarker | null> {
  const filename = path.join(dataDir, RETIRED_FILENAME);
  return existsSync(filename) ? readJson<RetiredRuntimeMarker>(filename) : null;
}

export async function assertRuntimeWritable(dataDir: string): Promise<void> {
  for (const candidate of retiredMarkerCandidates(dataDir)) {
    const marker = await readRetiredRuntimeMarker(candidate);
    if (marker) {
      const live = marker.liveRuntimeRoot ?? marker.liveDataDir;
      throw new Error(`This Attention runtime was retired at ${marker.retiredAt}. Use the live runtime at ${live}.`);
    }
  }
}

export async function freezeRetiredRuntimeDataDir(legacyDataDir: string, liveDataDir: string, retiredAt = new Date().toISOString()): Promise<RetiredRuntimeMarker> {
  const legacy = path.resolve(legacyDataDir);
  const legacyRoot = runtimeRootForDataDir(legacy);
  const live = path.resolve(liveDataDir);
  const liveRoot = runtimeRootForDataDir(live);
  const liveDb = path.resolve(resolveDbPath());
  if (live === legacy) throw new Error("Live and legacy runtime directories must be different.");
  if (liveRoot === legacyRoot) throw new Error("Live and legacy runtime roots must be different.");
  if (!existsSync(legacyRoot)) throw new Error(`Runtime directory not found: ${legacyRoot}`);
  const existing = await readRetiredRuntimeMarker(legacyRoot) ?? await readRetiredRuntimeMarker(legacy);
  if (existing && path.resolve(existing.liveDataDir) !== live) throw new Error("Retired runtime marker points to a different live data directory.");
  const marker = existing ?? { retiredAt, liveRuntimeRoot: liveRoot, liveDataDir: live, liveDbPath: liveDb };
  if (!existing) {
    await writeJson(path.join(legacyRoot, RETIRED_FILENAME), marker);
    if (legacyRoot !== legacy) await writeJson(path.join(legacy, RETIRED_FILENAME), marker);
  }
  await setRuntimeTreeWritable(legacyRoot, false);
  return marker;
}

export async function unfreezeRetiredRuntimeDataDir(dataDir: string): Promise<void> {
  await setRuntimeTreeWritable(runtimeRootForDataDir(path.resolve(dataDir)), true);
}

export async function inspectRuntimeDrift(liveDataDir: string, legacyDataDir: string, since?: string): Promise<RuntimeDriftReport> {
  const live = path.resolve(liveDataDir);
  const legacy = path.resolve(legacyDataDir);
  if (live === legacy) throw new Error("Live and legacy runtime directories must be different.");
  const threshold = since ? Date.parse(since) : null;
  if (since && Number.isNaN(threshold)) throw new Error("Reconciliation --since must be an ISO timestamp.");
  const entries: RuntimeDriftEntry[] = [];
  let identicalCount = 0;
  for (const relativePath of await walkFiles(legacy)) {
    const legacyPath = path.join(legacy, relativePath);
    const legacyStats = await stat(legacyPath);
    if (threshold !== null && legacyStats.mtimeMs <= threshold) continue;
    const livePath = path.join(live, relativePath);
    if (!existsSync(livePath)) {
      entries.push({ path: relativePath, status: "missing_live", legacyModifiedAt: legacyStats.mtime.toISOString() });
      continue;
    }
    if (await fileDigest(legacyPath) === await fileDigest(livePath)) {
      identicalCount += 1;
      continue;
    }
    entries.push({
      path: relativePath,
      status: "conflict",
      legacyModifiedAt: legacyStats.mtime.toISOString(),
      liveModifiedAt: (await stat(livePath)).mtime.toISOString(),
    });
  }
  return { liveDataDir: live, legacyDataDir: legacy, ...(since ? { since } : {}), identicalCount, entries };
}

export async function reconcileMissingRuntimeFiles(liveDataDir: string, legacyDataDir: string, since?: string) {
  const report = await inspectRuntimeDrift(liveDataDir, legacyDataDir, since);
  const copied: string[] = [];
  for (const entry of report.entries) {
    if (entry.status !== "missing_live" || !isSafeAdditiveArtifact(entry.path)) continue;
    const source = path.join(report.legacyDataDir, entry.path);
    const destination = path.join(report.liveDataDir, entry.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    copied.push(entry.path);
  }
  return {
    ...report,
    copied,
    conflicts: report.entries.filter((entry) => entry.status === "conflict"),
    manualReview: report.entries.filter((entry) => entry.status === "missing_live" && !isSafeAdditiveArtifact(entry.path)),
  };
}

async function walkFiles(root: string, relative = ""): Promise<string[]> {
  if (!existsSync(root)) throw new Error(`Runtime directory not found: ${root}`);
  const files: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.name === ".mutation-lock" || entry.name === RETIRED_FILENAME || entry.name.endsWith(".tmp")) continue;
    if (entry.isDirectory()) files.push(...await walkFiles(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort();
}

async function setRuntimeTreeWritable(root: string, writable: boolean): Promise<void> {
  if (!existsSync(root)) throw new Error(`Runtime directory not found: ${root}`);
  if (writable) await chmod(root, 0o755);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) await setRuntimeTreeWritable(child, writable);
    else if (entry.isFile()) await chmod(child, writable ? 0o644 : 0o444);
  }
  if (!writable) await chmod(root, 0o555);
}

async function fileDigest(filename: string): Promise<string> {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

function isSafeAdditiveArtifact(relativePath: string): boolean {
  return /^feeds\/[^/]+\/(raw|runs|sweeps)\//.test(relativePath);
}

function runtimeRootForDataDir(dataDir: string): string {
  const resolved = path.resolve(dataDir);
  return path.basename(resolved) === "data" ? path.dirname(resolved) : resolved;
}

function retiredMarkerCandidates(dataDir: string): string[] {
  const resolved = path.resolve(dataDir);
  return [...new Set([resolved, runtimeRootForDataDir(resolved)])];
}
