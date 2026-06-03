import { existsSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { attentionDataDir, attentionDbPath, attentionHome } from "../paths";
import { initRuntime, print } from "./shared";

export async function backupExportCommand(targetPath: string): Promise<void> {
  const sqlite = await initRuntime();
  sqlite.close();
  await mkdir(path.dirname(targetPath), { recursive: true });
  if (existsSync(targetPath)) await rm(targetPath, { recursive: true, force: true });
  await mkdir(targetPath, { recursive: true });
  await cp(attentionDataDir(), path.join(targetPath, "data"), { recursive: true });
  if (existsSync(attentionDbPath())) await cp(attentionDbPath(), path.join(targetPath, "attention.db"));
  await writeFile(path.join(targetPath, "manifest.json"), JSON.stringify({
    name: "attention-backup",
    format: 2,
    exportedAt: new Date().toISOString(),
    dataDir: attentionDataDir(),
    dbPath: attentionDbPath(),
  }, null, 2));
  print({ ok: true, exported: { dataDir: attentionDataDir(), dbPath: attentionDbPath() }, to: targetPath });
}

export async function backupImportCommand(sourcePath: string): Promise<void> {
  if (!existsSync(sourcePath)) throw new Error(`Backup path does not exist: ${sourcePath}`);
  const bundledData = path.join(sourcePath, "data");
  const bundledDb = path.join(sourcePath, "attention.db");
  const sourceData = existsSync(bundledData) ? bundledData : sourcePath;
  await mkdir(attentionHome(), { recursive: true });
  if (existsSync(attentionDataDir())) await rm(attentionDataDir(), { recursive: true, force: true });
  await cp(sourceData, attentionDataDir(), { recursive: true });
  await removeSqliteFiles();
  if (existsSync(bundledDb)) await cp(bundledDb, attentionDbPath());
  print({ ok: true, imported: sourcePath, to: { dataDir: attentionDataDir(), dbPath: attentionDbPath(), sqlite: existsSync(bundledDb) ? "restored" : "will_rehydrate_from_file_mirrors" } });
}

async function removeSqliteFiles(): Promise<void> {
  await Promise.all([
    rm(attentionDbPath(), { force: true }),
    rm(`${attentionDbPath()}-shm`, { force: true }),
    rm(`${attentionDbPath()}-wal`, { force: true }),
  ]);
}
