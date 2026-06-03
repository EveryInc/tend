import { mkdir } from "node:fs/promises";
import { attentionDataDir, attentionDbPath, attentionHome } from "../paths";
import { LocalSqliteStore } from "../sqlite";

export function apiPort(): number {
  return Number(process.env.ATTENTION_API_PORT ?? 4332);
}

export function apiUrl(): string {
  return `http://127.0.0.1:${apiPort()}`;
}

export function mcpUrl(): string {
  return `${apiUrl()}/mcp`;
}

export function print(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

export async function initRuntime(): Promise<LocalSqliteStore> {
  await mkdir(attentionHome(), { recursive: true });
  await mkdir(attentionDataDir(), { recursive: true });
  const sqlite = new LocalSqliteStore();
  await sqlite.init();
  return sqlite;
}

export function localPaths() {
  return {
    home: attentionHome(),
    dataDir: attentionDataDir(),
    dbPath: attentionDbPath(),
    apiUrl: apiUrl(),
    uiUrl: apiUrl(),
    mcpUrl: mcpUrl(),
  };
}
