import { Database } from "bun:sqlite";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function withProcessLock<T>(legacyPath: string, callback: () => Promise<T>, timeoutMs = 6_000): Promise<T> {
  await mkdir(path.dirname(legacyPath), { recursive: true });
  const db = new Database(`${legacyPath}.sqlite`, { create: true });
  const deadline = Date.now() + timeoutMs;
  try {
    db.exec("PRAGMA busy_timeout = 0;");
    while (true) {
      try {
        db.exec("BEGIN IMMEDIATE;");
        break;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") throw error;
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for the process lock at ${legacyPath}.`);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    }
    try {
      await writeFile(legacyPath, "", { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const entry = await lstat(legacyPath);
      if (!entry.isFile() || entry.size !== 0) {
        throw new Error(`Legacy lock exists at ${legacyPath}. Stop all older Tend processes and remove the abandoned lock before retrying.`);
      }
    }
    return await callback();
  } finally {
    db.close();
  }
}
