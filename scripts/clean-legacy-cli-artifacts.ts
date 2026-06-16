import { readdir, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outputDir = path.join(root, "dist-bin");
const releaseDir = path.join(outputDir, "releases");

await rm(path.join(outputDir, "attention"), { force: true });

for (const entry of await listDirectory(releaseDir)) {
  if (entry.startsWith("attention-")) {
    await rm(path.join(releaseDir, entry), { force: true });
  }
}

async function listDirectory(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
}
