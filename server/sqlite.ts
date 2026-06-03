import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { attentionDbPath } from "./paths";
import type { WorkspaceFeedRepository } from "./repositories/workspaceFeeds";

const SCHEMA_VERSION = 2;

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
      CREATE TABLE IF NOT EXISTS workspace_feeds (
        feed_id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL
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

  workspaceFeeds(): WorkspaceFeedRepository {
    return new SqliteWorkspaceFeedRepository(() => this.database());
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

class SqliteWorkspaceFeedRepository implements WorkspaceFeedRepository {
  constructor(private readonly database: () => Database) {}

  async init(defaultFeedIds: string[]): Promise<void> {
    const row = this.database().query("SELECT COUNT(*) AS count FROM workspace_feeds").get() as { count: number };
    if (row.count === 0) await this.setFeedIds(defaultFeedIds);
  }

  async listFeedIds(): Promise<string[]> {
    const rows = this.database().query("SELECT feed_id FROM workspace_feeds ORDER BY position ASC, created_at ASC").all() as Array<{ feed_id: string }>;
    return rows.map((row) => row.feed_id);
  }

  async setFeedIds(feedIds: string[]): Promise<void> {
    const db = this.database();
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.query("DELETE FROM workspace_feeds").run();
      const insert = db.query("INSERT INTO workspace_feeds (feed_id, position, created_at) VALUES (?, ?, ?)");
      unique(feedIds).forEach((feedId, index) => insert.run(feedId, index, now));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async addFeedId(feedId: string): Promise<void> {
    const row = this.database().query("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM workspace_feeds").get() as { position: number };
    this.database()
      .query("INSERT INTO workspace_feeds (feed_id, position, created_at) VALUES (?, ?, ?) ON CONFLICT(feed_id) DO NOTHING")
      .run(feedId, row.position, new Date().toISOString());
  }

  async removeFeedId(feedId: string): Promise<void> {
    const remaining = (await this.listFeedIds()).filter((id) => id !== feedId);
    await this.setFeedIds(remaining);
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
