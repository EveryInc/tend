import { homedir } from "node:os";
import path from "node:path";

export function attentionHome(): string {
  return process.env.ATTENTION_HOME ?? path.join(homedir(), ".attention");
}

export function attentionDataDir(): string {
  return process.env.ATTENTION_DATA_DIR ?? path.join(attentionHome(), "data");
}

export function attentionDbPath(): string {
  return process.env.ATTENTION_DB_PATH ?? path.join(attentionHome(), "attention.db");
}

export function attentionLogDir(): string {
  return process.env.ATTENTION_LOG_DIR ?? path.join(attentionHome(), "logs");
}
