import { Database } from "bun:sqlite";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ProcessLockOptions {
  /** How long to wait for a busy lock before failing. `0` fails immediately. Defaults to 6 s. */
  timeoutMs?: number;
  /** Message for the error thrown when the lock stays busy past the timeout. */
  busyMessage?: string;
}

const OWNER_FILE = "owner.json";
const POLL_MS = 15;
const LOCK_NAMES = [".mutation-lock", ".agent-wake-lock"];
const LOCK_SUFFIXES = ["", ".sqlite", ".sqlite-journal"];

/**
 * Cross-process mutual exclusion that survives crashes.
 *
 * The lock itself is a SQLite database file beside `legacyPath`: holding a `BEGIN IMMEDIATE`
 * transaction takes an operating-system file lock that the kernel releases the moment the holding
 * process exits, so a killed or crashed Tend never leaves the lock held.
 *
 * `legacyPath` is still created as a directory while the lock is held because older Tend builds use
 * that directory as their lock; during an upgrade the two builds keep excluding each other. A
 * directory created by this build carries an owner marker. If such a directory is found while we
 * already hold the SQLite lock, its creator must have died, so it is reclaimed. A directory without
 * a marker belongs to an older build and is respected until it disappears.
 */
export async function withProcessLock<T>(legacyPath: string, callback: () => Promise<T>, options: ProcessLockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 6_000;
  const deadline = Date.now() + timeoutMs;
  await mkdir(path.dirname(legacyPath), { recursive: true });
  const db = new Database(`${legacyPath}.sqlite`, { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 0;");
    while (true) {
      try {
        db.exec("BEGIN IMMEDIATE;");
        break;
      } catch (error) {
        if (!isBusy(error)) throw error;
        if (Date.now() >= deadline) throw new Error(options.busyMessage ?? `Timed out waiting for the lock at ${legacyPath}.`);
        await sleep(POLL_MS);
      }
    }
    await claimLegacyDirectory(legacyPath, deadline, options.busyMessage);
    try {
      return await callback();
    } finally {
      await rm(legacyPath, { recursive: true, force: true });
    }
  } finally {
    db.close();
  }
}

/** Remove lock artifacts from a copied data directory (backups must not carry live lock state). */
export async function removeLockArtifacts(dataDir: string): Promise<void> {
  for (const name of LOCK_NAMES) {
    for (const suffix of LOCK_SUFFIXES) await rm(path.join(dataDir, `${name}${suffix}`), { recursive: true, force: true });
  }
}

async function claimLegacyDirectory(legacyPath: string, deadline: number, busyMessage?: string): Promise<void> {
  while (true) {
    try {
      await mkdir(legacyPath);
      await writeFile(path.join(legacyPath, OWNER_FILE), JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!(await lstat(legacyPath)).isDirectory()) {
      throw new Error(`A file exists at ${legacyPath} where Tend keeps its lock directory. Remove it and retry.`);
    }
    if (await createdByThisBuild(legacyPath)) {
      // We hold the SQLite lock, so no live process of this build can own the directory: its creator died.
      await rm(legacyPath, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${busyMessage ? `${busyMessage} ` : ""}A lock directory exists at ${legacyPath}. It belongs to an older Tend process or was left behind when one crashed; if no older Tend process is running, delete that directory and retry.`,
      );
    }
    await sleep(POLL_MS);
  }
}

async function createdByThisBuild(legacyPath: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(path.join(legacyPath, OWNER_FILE), "utf8")) as { pid?: unknown };
    return typeof owner.pid === "number";
  } catch {
    return false;
  }
}

function isBusy(error: unknown): boolean {
  const { code, errno, message } = error as { code?: unknown; errno?: unknown; message?: unknown };
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
  if (errno === 5 || errno === 6) return true;
  return typeof message === "string" && /database is locked|SQLITE_BUSY|SQLITE_LOCKED/.test(message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
