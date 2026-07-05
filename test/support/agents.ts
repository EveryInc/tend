import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentWakeLine } from "../../shared/types";

export async function readClaudeWakeLines(root: string): Promise<AgentWakeLine[]> {
  try {
    const text = await readFile(path.join(root, "agents", "claude", "wake.jsonl"), "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as AgentWakeLine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
