import { Database } from "bun:sqlite";
import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import path from "node:path";

export interface ProcessLockOptions {
  /** How long to wait for a busy lock before failing. `0` fails immediately. Defaults to 6 s. */
  timeoutMs?: number;
  /** Message for the error thrown when the lock stays busy past the timeout. */
  busyMessage?: string;
}

const POLL_MS = 15;
const LOCK_ARTIFACT = /^\.(?:mutation-lock|agent-wake-lock)(?:\.sqlite(?:-journal)?)?$/;

/**
 * Cross-process mutual exclusion that survives crashes.
 *
 * The lock itself is a SQLite database file beside `legacyPath`: holding a `BEGIN IMMEDIATE`
 * transaction takes an operating-system file lock that the kernel releases the moment the holding
 * process exits, so a killed or crashed Tend never leaves the lock held. Nothing else in the process
 * may open that file while the lock is held (POSIX drops a process's locks when any descriptor for
 * the file closes), which is why backups skip lock artifacts instead of copying them.
 *
 * Older Tend builds lock by creating `legacyPath` as a directory. While the lock is held, this build
 * atomically creates a symlink at that path whose target records the owning pid, so the two builds
 * keep excluding each other during an upgrade (`mkdir` fails on an existing symlink too). A symlink
 * found while the SQLite lock is already held can only have been left by a process that died, so it
 * is reclaimed. A real directory belongs to an older build and is respected until it disappears.
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
    await claimLegacyPath(legacyPath, deadline, options.busyMessage);
    try {
      return await callback();
    } finally {
      await rm(legacyPath, { recursive: true, force: true });
    }
  } finally {
    db.close();
  }
}

/** True for the lock files and directories Tend keeps inside a data directory. */
export function isLockArtifact(filePath: string): boolean {
  return LOCK_ARTIFACT.test(path.basename(filePath));
}

/** Remove lock artifacts from a copied data directory (backups must not carry live lock state). */
export async function removeLockArtifacts(dataDir: string): Promise<void> {
  for (const name of [".mutation-lock", ".agent-wake-lock"]) {
    for (const suffix of ["", ".sqlite", ".sqlite-journal"]) await rm(path.join(dataDir, `${name}${suffix}`), { recursive: true, force: true });
  }
}

async function claimLegacyPath(legacyPath: string, deadline: number, busyMessage?: string): Promise<void> {
  const marker = JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() });
  while (true) {
    try {
      await symlink(marker, legacyPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let entry;
    try {
      entry = await lstat(legacyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // the holder released between our attempt and the check
      throw error;
    }
    if (entry.isSymbolicLink()) {
      if (await createdByThisBuild(legacyPath)) {
        // We hold the SQLite lock, so no live process of this build can own the path: its creator died.
        await rm(legacyPath, { force: true });
        continue;
      }
      throw new Error(`An unexpected symlink exists at ${legacyPath} where Tend keeps its lock. Remove it and retry.`);
    }
    if (!entry.isDirectory()) throw new Error(`A file exists at ${legacyPath} where Tend keeps its lock. Remove it and retry.`);
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
    const owner = JSON.parse(await readlink(legacyPath)) as { pid?: unknown };
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
