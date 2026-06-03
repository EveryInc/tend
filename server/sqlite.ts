import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { attentionDbPath } from "./paths";
import type { Card, FeedEvent, RoutineActionGroup, SourceRun, SweepBatch, SweepFeedbackTrace, SweepState, WorkItem } from "../src/types";
import type { CardRepository } from "./repositories/cards";
import type { FeedEventRepository } from "./repositories/feedEvents";
import type { RoutineActionGroupRepository } from "./repositories/routineActionGroups";
import type { SourceRunRepository } from "./repositories/sourceRuns";
import { defaultSweepState, type SweepRepository } from "./repositories/sweeps";
import type { WorkItemRepository } from "./repositories/workItems";
import type { WorkspaceFeedRepository } from "./repositories/workspaceFeeds";

const SCHEMA_VERSION = 8;

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
      CREATE TABLE IF NOT EXISTS feed_events (
        id TEXT PRIMARY KEY,
        feed_id TEXT NOT NULL,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        card_id TEXT,
        work_id TEXT,
        detail_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_feed_events_feed_at ON feed_events (feed_id, at);
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        feed_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        ready_for_pass INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cards_feed_status ON cards (feed_id, status);
      CREATE TABLE IF NOT EXISTS routine_action_groups (
        id TEXT PRIMARY KEY,
        feed_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_routine_action_groups_feed_status ON routine_action_groups (feed_id, status);
      CREATE TABLE IF NOT EXISTS source_runs (
        id TEXT PRIMARY KEY,
        feed_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        trigger_work_id TEXT,
        completed_at TEXT,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_source_runs_feed_source ON source_runs (feed_id, source_id);
      CREATE INDEX IF NOT EXISTS idx_source_runs_trigger_work ON source_runs (trigger_work_id);
      CREATE TABLE IF NOT EXISTS sweep_states (
        feed_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sweep_batches (
        id TEXT PRIMARY KEY,
        feed_id TEXT NOT NULL,
        trigger_work_id TEXT,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sweep_batches_feed_created ON sweep_batches (feed_id, created_at);
      CREATE TABLE IF NOT EXISTS sweep_feedback (
        id TEXT PRIMARY KEY,
        feed_id TEXT NOT NULL,
        batch_id TEXT,
        created_at TEXT NOT NULL,
        rejudged_at TEXT,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sweep_feedback_feed_created ON sweep_feedback (feed_id, created_at);
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        feed_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_work_items_feed_status ON work_items (feed_id, status);
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

  feedEvents(): FeedEventRepository {
    return new SqliteFeedEventRepository(() => this.database());
  }

  cards(): CardRepository {
    return new SqliteCardRepository(() => this.database());
  }

  routineActionGroups(): RoutineActionGroupRepository {
    return new SqliteRoutineActionGroupRepository(() => this.database());
  }

  sourceRuns(): SourceRunRepository {
    return new SqliteSourceRunRepository(() => this.database());
  }

  sweeps(): SweepRepository {
    return new SqliteSweepRepository(() => this.database());
  }

  workItems(): WorkItemRepository {
    return new SqliteWorkItemRepository(() => this.database());
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

class SqliteCardRepository implements CardRepository {
  constructor(private readonly database: () => Database) {}

  async init(_feedIds: string[]): Promise<void> {}

  async list(feedId: string): Promise<Card[]> {
    const rows = this.database()
      .query("SELECT payload_json FROM cards WHERE feed_id = ? ORDER BY created_at ASC, id ASC")
      .all(feedId) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as Card);
  }

  async get(feedId: string, cardId: string): Promise<Card> {
    const row = this.database()
      .query("SELECT payload_json FROM cards WHERE feed_id = ? AND id = ?")
      .get(feedId, cardId) as { payload_json: string } | undefined;
    if (!row) throw new Error(`Card not found: ${cardId}`);
    return JSON.parse(row.payload_json) as Card;
  }

  async has(feedId: string, cardId: string): Promise<boolean> {
    const row = this.database()
      .query("SELECT 1 AS found FROM cards WHERE feed_id = ? AND id = ?")
      .get(feedId, cardId) as { found: number } | undefined;
    return Boolean(row);
  }

  async write(card: Card): Promise<void> {
    this.database()
      .query(`
        INSERT INTO cards (id, feed_id, kind, status, ready_for_pass, created_at, updated_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          feed_id = excluded.feed_id,
          kind = excluded.kind,
          status = excluded.status,
          ready_for_pass = excluded.ready_for_pass,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json
      `)
      .run(card.id, card.feedId, card.kind, card.status, card.readyForPass, card.createdAt, card.updatedAt, JSON.stringify(card));
  }

  async remove(feedId: string, cardId: string): Promise<void> {
    this.database().query("DELETE FROM cards WHERE feed_id = ? AND id = ?").run(feedId, cardId);
  }
}

class SqliteRoutineActionGroupRepository implements RoutineActionGroupRepository {
  constructor(private readonly database: () => Database) {}

  async init(_feedIds: string[]): Promise<void> {}

  async list(feedId: string): Promise<RoutineActionGroup[]> {
    const rows = this.database()
      .query("SELECT payload_json FROM routine_action_groups WHERE feed_id = ? ORDER BY created_at ASC, id ASC")
      .all(feedId) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as RoutineActionGroup);
  }

  async get(feedId: string, groupId: string): Promise<RoutineActionGroup> {
    const row = this.database()
      .query("SELECT payload_json FROM routine_action_groups WHERE feed_id = ? AND id = ?")
      .get(feedId, groupId) as { payload_json: string } | undefined;
    if (!row) throw new Error(`Routine action group not found: ${groupId}`);
    return JSON.parse(row.payload_json) as RoutineActionGroup;
  }

  async has(feedId: string, groupId: string): Promise<boolean> {
    const row = this.database()
      .query("SELECT 1 AS found FROM routine_action_groups WHERE feed_id = ? AND id = ?")
      .get(feedId, groupId) as { found: number } | undefined;
    return Boolean(row);
  }

  async write(group: RoutineActionGroup): Promise<void> {
    this.database()
      .query(`
        INSERT INTO routine_action_groups (id, feed_id, status, created_at, updated_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          feed_id = excluded.feed_id,
          status = excluded.status,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json
      `)
      .run(group.id, group.feedId, group.status, group.createdAt, group.updatedAt, JSON.stringify(group));
  }
}

class SqliteSourceRunRepository implements SourceRunRepository {
  constructor(private readonly database: () => Database) {}

  async init(_feedIds: string[]): Promise<void> {}

  async list(feedId: string): Promise<SourceRun[]> {
    const rows = this.database()
      .query("SELECT payload_json FROM source_runs WHERE feed_id = ? ORDER BY completed_at ASC, id ASC")
      .all(feedId) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as SourceRun);
  }

  async get(feedId: string, runId: string): Promise<SourceRun> {
    const row = this.database()
      .query("SELECT payload_json FROM source_runs WHERE feed_id = ? AND id = ?")
      .get(feedId, runId) as { payload_json: string } | undefined;
    if (!row) throw new Error(`Source run not found: ${runId}`);
    return JSON.parse(row.payload_json) as SourceRun;
  }

  async write(run: SourceRun): Promise<void> {
    this.database()
      .query(`
        INSERT INTO source_runs (id, feed_id, source_id, trigger_work_id, completed_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          feed_id = excluded.feed_id,
          source_id = excluded.source_id,
          trigger_work_id = excluded.trigger_work_id,
          completed_at = excluded.completed_at,
          payload_json = excluded.payload_json
      `)
      .run(run.id, run.feedId, run.sourceId, run.triggerWorkId ?? null, run.completedAt ?? null, JSON.stringify(run));
  }
}

class SqliteSweepRepository implements SweepRepository {
  constructor(private readonly database: () => Database) {}

  async init(_feedIds: string[]): Promise<void> {}

  async hasState(feedId: string): Promise<boolean> {
    const row = this.database().query("SELECT 1 AS found FROM sweep_states WHERE feed_id = ?").get(feedId) as { found: number } | undefined;
    return Boolean(row);
  }

  async readState(feedId: string): Promise<SweepState> {
    const row = this.database().query("SELECT payload_json FROM sweep_states WHERE feed_id = ?").get(feedId) as { payload_json: string } | undefined;
    if (!row) return defaultSweepState();
    return JSON.parse(row.payload_json) as SweepState;
  }

  async writeState(feedId: string, state: SweepState): Promise<void> {
    this.database()
      .query(`
        INSERT INTO sweep_states (feed_id, payload_json)
        VALUES (?, ?)
        ON CONFLICT(feed_id) DO UPDATE SET payload_json = excluded.payload_json
      `)
      .run(feedId, JSON.stringify(state));
  }

  async listBatches(feedId: string): Promise<SweepBatch[]> {
    const rows = this.database()
      .query("SELECT payload_json FROM sweep_batches WHERE feed_id = ? ORDER BY created_at ASC, id ASC")
      .all(feedId) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as SweepBatch);
  }

  async getBatch(feedId: string, batchId: string): Promise<SweepBatch> {
    const row = this.database()
      .query("SELECT payload_json FROM sweep_batches WHERE feed_id = ? AND id = ?")
      .get(feedId, batchId) as { payload_json: string } | undefined;
    if (!row) throw new Error(`Sweep batch not found: ${batchId}`);
    return JSON.parse(row.payload_json) as SweepBatch;
  }

  async writeBatch(batch: SweepBatch): Promise<void> {
    this.database()
      .query(`
        INSERT INTO sweep_batches (id, feed_id, trigger_work_id, created_at, payload_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          feed_id = excluded.feed_id,
          trigger_work_id = excluded.trigger_work_id,
          created_at = excluded.created_at,
          payload_json = excluded.payload_json
      `)
      .run(batch.id, batch.feedId, batch.triggerWorkId ?? null, batch.createdAt, JSON.stringify(batch));
  }

  async listFeedback(feedId: string): Promise<SweepFeedbackTrace[]> {
    const rows = this.database()
      .query("SELECT payload_json FROM sweep_feedback WHERE feed_id = ? ORDER BY created_at ASC, id ASC")
      .all(feedId) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as SweepFeedbackTrace);
  }

  async getFeedback(feedId: string, feedbackId: string): Promise<SweepFeedbackTrace> {
    const row = this.database()
      .query("SELECT payload_json FROM sweep_feedback WHERE feed_id = ? AND id = ?")
      .get(feedId, feedbackId) as { payload_json: string } | undefined;
    if (!row) throw new Error(`Sweep feedback not found: ${feedbackId}`);
    return JSON.parse(row.payload_json) as SweepFeedbackTrace;
  }

  async writeFeedback(trace: SweepFeedbackTrace): Promise<void> {
    this.database()
      .query(`
        INSERT INTO sweep_feedback (id, feed_id, batch_id, created_at, rejudged_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          feed_id = excluded.feed_id,
          batch_id = excluded.batch_id,
          created_at = excluded.created_at,
          rejudged_at = excluded.rejudged_at,
          payload_json = excluded.payload_json
      `)
      .run(trace.id, trace.feedId, trace.batchId ?? null, trace.createdAt, trace.rejudgedAt ?? null, JSON.stringify(trace));
  }
}

class SqliteWorkItemRepository implements WorkItemRepository {
  constructor(private readonly database: () => Database) {}

  async init(_feedIds: string[]): Promise<void> {}

  async list(feedId: string): Promise<WorkItem[]> {
    const rows = this.database()
      .query("SELECT payload_json FROM work_items WHERE feed_id = ? ORDER BY created_at ASC, id ASC")
      .all(feedId) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as WorkItem);
  }

  async get(feedId: string, workId: string): Promise<WorkItem> {
    const row = this.database()
      .query("SELECT payload_json FROM work_items WHERE feed_id = ? AND id = ?")
      .get(feedId, workId) as { payload_json: string } | undefined;
    if (!row) throw new Error(`Work item not found: ${workId}`);
    return JSON.parse(row.payload_json) as WorkItem;
  }

  async write(work: WorkItem): Promise<void> {
    this.database()
      .query(`
        INSERT INTO work_items (id, feed_id, card_id, kind, status, created_at, updated_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          feed_id = excluded.feed_id,
          card_id = excluded.card_id,
          kind = excluded.kind,
          status = excluded.status,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json
      `)
      .run(work.id, work.feedId, work.cardId, work.kind, work.status, work.createdAt, work.updatedAt, JSON.stringify(work));
  }
}

class SqliteFeedEventRepository implements FeedEventRepository {
  constructor(private readonly database: () => Database) {}

  async init(_feedIds: string[]): Promise<void> {}

  async append(event: FeedEvent): Promise<void> {
    this.database()
      .query("INSERT INTO feed_events (id, feed_id, type, at, card_id, work_id, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
      .run(
        event.id,
        event.feedId,
        event.type,
        event.at,
        event.cardId ?? null,
        event.workId ?? null,
        event.detail === undefined ? null : JSON.stringify(event.detail),
      );
  }

  async list(feedId: string): Promise<FeedEvent[]> {
    const rows = this.database()
      .query("SELECT id, feed_id, type, at, card_id, work_id, detail_json FROM feed_events WHERE feed_id = ? ORDER BY at ASC, id ASC")
      .all(feedId) as Array<{ id: string; feed_id: string; type: string; at: string; card_id: string | null; work_id: string | null; detail_json: string | null }>;
    return rows.map((row) => ({
      id: row.id,
      feedId: row.feed_id,
      type: row.type,
      at: row.at,
      ...(row.card_id ? { cardId: row.card_id } : {}),
      ...(row.work_id ? { workId: row.work_id } : {}),
      ...(row.detail_json ? { detail: JSON.parse(row.detail_json) as unknown } : {}),
    }));
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
