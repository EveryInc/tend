import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";

const rename = fs.rename;
const [source, failure] = process.argv.slice(2);
const home = process.env.ATTENTION_HOME!;
mock.module("node:fs/promises", () => ({
  ...fs,
  async rename(from: string, to: string) {
    if (failure === "first" && from === path.join(home, "data")) throw new Error("Injected first rename failure");
    if ((failure === "install" || failure === "rollback") && from.includes(".attention-import-") && !from.includes("rollback") && to === path.join(home, "data")) throw new Error("Injected install failure");
    if (failure === "database" && from.includes(".attention-import-") && !from.includes("rollback") && to === path.join(home, "attention.db")) throw new Error("Injected database install failure");
    if (failure === "rollback" && from.includes("rollback")) throw new Error("Injected rollback failure");
    return rename(from, to);
  },
}));
globalThis.fetch = async () => new Response(null, { status: 503 });
const { backupImportCommand } = await import("../../server/cli/backup");
try {
  await backupImportCommand(source ?? "");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
