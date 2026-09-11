import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { attentionDataDir, attentionDbPath, attentionHome } from "../paths";
import { SQLITE_SCHEMA_VERSION } from "../sqlite";
import { withMutationLock } from "../util";
import { apiUrl, initRuntime, print } from "./shared";

export async function backupExportCommand(targetPath: string): Promise<void> {
  const target = path.resolve(targetPath);
  if (existsSync(target)) {
    throw new Error(`Backup target already exists: ${target}. Choose a new empty path.`);
  }
  if (isWithin(attentionDataDir(), target)) {
    throw new Error("Backup target cannot be inside Tend's data directory.");
  }

  await mkdir(path.dirname(target), { recursive: true });
  const stage = await mkdtemp(path.join(path.dirname(target), `.${path.basename(target)}-`));
  try {
    await withMutationLock(attentionDataDir(), async () => {
      const sqlite = await initRuntime();
      try {
        await sqlite.backupTo(path.join(stage, "attention.db"));
        await cp(attentionDataDir(), path.join(stage, "data"), { recursive: true });
        await rm(path.join(stage, "data", ".mutation-lock"), { recursive: true, force: true });
        await writeFile(path.join(stage, "manifest.json"), JSON.stringify({
          name: "tend-backup",
          format: 2,
          exportedAt: new Date().toISOString(),
          dataDir: attentionDataDir(),
          dbPath: attentionDbPath(),
        }, null, 2));
        await rename(stage, target);
      } finally {
        sqlite.close();
      }
    });
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  print({ ok: true, exported: { dataDir: attentionDataDir(), dbPath: attentionDbPath() }, to: target });
}

export async function backupImportCommand(sourcePath: string): Promise<void> {
  const source = path.resolve(sourcePath);
  if (!existsSync(source)) throw new Error(`Backup path does not exist: ${source}`);
  await assertRuntimeStopped();

  const bundledData = path.join(source, "data");
  const bundledDb = path.join(source, "attention.db");
  const sourceData = existsSync(bundledData) ? bundledData : source;
  if (!(await stat(sourceData)).isDirectory()) throw new Error(`Backup data is not a directory: ${sourceData}`);

  const home = path.resolve(attentionHome());
  await mkdir(path.dirname(home), { recursive: true });
  const stage = await mkdtemp(path.join(os.tmpdir(), "attention-import-"));
  const rollback = path.join(stage, "rollback");
  const stagedData = path.join(stage, "data");
  const stagedDb = path.join(stage, "attention.db");
  try {
    await cp(sourceData, stagedData, { recursive: true });
    await rm(path.join(stagedData, ".mutation-lock"), { recursive: true, force: true });
    if (existsSync(bundledDb)) {
      await cp(bundledDb, stagedDb);
      validateSqliteBackup(stagedDb);
    }
    await mkdir(home, { recursive: true });
    await mkdir(rollback, { recursive: true });

    const currentFiles = [
      attentionDataDir(),
      attentionDbPath(),
      `${attentionDbPath()}-shm`,
      `${attentionDbPath()}-wal`,
    ];
    const moved: Array<{ from: string; to: string }> = [];
    try {
      for (const current of currentFiles) {
        if (!existsSync(current)) continue;
        const backup = path.join(rollback, path.basename(current));
        await rename(current, backup);
        moved.push({ from: backup, to: current });
      }
      await rename(stagedData, attentionDataDir());
      if (existsSync(stagedDb)) await rename(stagedDb, attentionDbPath());
    } catch (error) {
      await rm(attentionDataDir(), { recursive: true, force: true });
      await removeSqliteFiles();
      for (const item of moved.reverse()) {
        if (existsSync(item.from)) await rename(item.from, item.to);
      }
      throw error;
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }

  print({
    ok: true,
    imported: source,
    to: {
      dataDir: attentionDataDir(),
      dbPath: attentionDbPath(),
      sqlite: existsSync(bundledDb) ? "restored" : "will_rehydrate_from_file_mirrors",
    },
  });
}

function validateSqliteBackup(dbPath: string): void {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query("PRAGMA integrity_check;").all() as Array<{ integrity_check: string }>;
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
      throw new Error(`Backup SQLite integrity check failed: ${rows.map((row) => row.integrity_check).join("; ") || "no result"}`);
    }
    let schemaRow: { value: string } | null;
    try {
      schemaRow = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null;
    } catch {
      throw new Error("Backup SQLite database is not a Tend runtime.");
    }
    const schemaVersion = Number(schemaRow?.value);
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
      throw new Error("Backup SQLite database is missing a valid Tend schema version.");
    }
    if (schemaVersion > SQLITE_SCHEMA_VERSION) {
      throw new Error(`Backup schema ${schemaVersion} is newer than this Tend build supports (${SQLITE_SCHEMA_VERSION}).`);
    }
  } finally {
    db.close();
  }
}

async function assertRuntimeStopped(): Promise<void> {
  try {
    const response = await fetch(`${apiUrl()}/api/status`, { signal: AbortSignal.timeout(750) });
    if (!response.ok) return;
    const status = await response.json() as { dataDir?: string };
    if (status.dataDir && path.resolve(status.dataDir, "..") === path.resolve(attentionHome())) {
      throw new Error("Stop Tend before importing a backup into its active runtime.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Stop Tend")) throw error;
  }
}

async function removeSqliteFiles(): Promise<void> {
  await Promise.all([
    rm(attentionDbPath(), { force: true }),
    rm(`${attentionDbPath()}-shm`, { force: true }),
    rm(`${attentionDbPath()}-wal`, { force: true }),
  ]);
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
