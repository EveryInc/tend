import { homedir } from "node:os";
import path from "node:path";

export function attentionHome(): string {
  return process.env.ATTENTION_HOME ?? path.join(homedir(), ".attention");
}

export function attentionDataDir(): string {
  return path.join(attentionHome(), "data");
}

export function attentionDbPath(): string {
  return path.join(attentionHome(), "attention.db");
}

export function attentionLogDir(): string {
  return path.join(attentionHome(), "logs");
}
