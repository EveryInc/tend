import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { attentionDbPath } from "./paths";

const SCHEMA_VERSION = 1;

export type LocalRuntimeStatus = {
  dbPath: string;
  schemaVersion: number;
  createdAt: string | null;
  updatedAt: string | null;
};

export class LocalSqliteStore {
  readonly dbPath: string;
  private db: Database | null = null;

  constructor(dbPath = attentionDbPath()) {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.dbPath), { recursive: true });
    const db = this.database();
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    this.setMeta("schema_version", String(SCHEMA_VERSION));
    if (!this.getMeta("created_at")) this.setMeta("created_at", now);
    this.setMeta("updated_at", now);
  }

  status(): LocalRuntimeStatus {
    const db = this.database();
    const schemaVersion = Number(this.getMeta("schema_version") ?? "0");
    return {
      dbPath: this.dbPath,
      schemaVersion,
      createdAt: this.getMeta("created_at"),
      updatedAt: this.getMeta("updated_at"),
    };
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private database(): Database {
    if (!this.db) {
      this.db = new Database(this.dbPath, { create: true });
      this.db.exec("PRAGMA busy_timeout = 5000;");
    }
    return this.db;
  }

  private getMeta(key: string): string | null {
    const row = this.database().query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.database().query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}
