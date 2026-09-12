import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FileWorkspaceFeedRepository,
  MirroredWorkspaceFeedRepository,
  type WorkspaceFeedRepository,
} from "../server/repositories/workspaceFeeds";
import { LocalSqliteStore, SqliteWorkspaceFeedRepository } from "../server/sqlite";
import { AttentionStore } from "../server/store";

const roots: string[] = [];
const stores: LocalSqliteStore[] = [];
const connections: Database[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "attention-workspace-feeds-"));
  roots.push(root);
  return root;
}

async function sqliteStore(root: string): Promise<LocalSqliteStore> {
  const sqlite = new LocalSqliteStore(path.join(root, "attention.db"));
  await sqlite.init();
  stores.push(sqlite);
  return sqlite;
}

/** A raw connection with SQLite's default busy_timeout of 0, so lock conflicts fail immediately. */
function connect(dbPath: string): Database {
  const db = new Database(dbPath);
  connections.push(db);
  return db;
}

afterEach(async () => {
  for (const db of connections.splice(0)) {
    if (db.inTransaction) db.exec("ROLLBACK");
    db.close();
  }
  for (const sqlite of stores.splice(0)) sqlite.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function busyError(): Error {
  return Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY", errno: 5 });
}

/**
 * Wraps a connection so the DELETE inside setFeedIds behaves like a statement that hit
 * SQLITE_BUSY mid-transaction: SQLite has already rolled the transaction back by the time
 * the error reaches application code.
 */
function failingDeleteConnection(db: Database): Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "query") {
        return (sql: string) => {
          if (!sql.startsWith("DELETE FROM workspace_feeds")) return target.query(sql);
          return {
            run() {
              target.exec("ROLLBACK");
              throw busyError();
            },
          };
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Delegates to a repository while recording every write, so a test can assert a boot stayed read-only. */
class RecordingWorkspaceFeedRepository implements WorkspaceFeedRepository {
  readonly writes: string[] = [];

  constructor(private readonly inner: WorkspaceFeedRepository) {}

  init(defaultFeedIds: string[]): Promise<void> {
    return this.inner.init(defaultFeedIds);
  }

  listFeedIds(): Promise<string[]> {
    return this.inner.listFeedIds();
  }

  setFeedIds(feedIds: string[]): Promise<void> {
    this.writes.push(`set:${feedIds.join(",")}`);
    return this.inner.setFeedIds(feedIds);
  }

  addFeedId(feedId: string): Promise<void> {
    this.writes.push(`add:${feedId}`);
    return this.inner.addFeedId(feedId);
  }

  removeFeedId(feedId: string): Promise<void> {
    this.writes.push(`remove:${feedId}`);
    return this.inner.removeFeedId(feedId);
  }
}

class CountingWorkspaceFeedRepository implements WorkspaceFeedRepository {
  initCalls = 0;

  constructor(private readonly inner: WorkspaceFeedRepository) {}

  async init(defaultFeedIds: string[]): Promise<void> {
    this.initCalls += 1;
    await this.inner.init(defaultFeedIds);
  }

  listFeedIds(): Promise<string[]> { return this.inner.listFeedIds(); }
  setFeedIds(feedIds: string[]): Promise<void> { return this.inner.setFeedIds(feedIds); }
  addFeedId(feedId: string): Promise<void> { return this.inner.addFeedId(feedId); }
  removeFeedId(feedId: string): Promise<void> { return this.inner.removeFeedId(feedId); }
}

function feedRows(db: Database): Array<{ feed_id: string; position: number; created_at: string }> {
  return db
    .query("SELECT feed_id, position, created_at FROM workspace_feeds ORDER BY position ASC")
    .all() as Array<{ feed_id: string; position: number; created_at: string }>;
}

async function rejection(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  const failure = await promise.then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  return failure as Error & { code?: string };
}

describe("SqliteWorkspaceFeedRepository.setFeedIds", () => {
  test("surfaces the statement's own error when SQLite already rolled the transaction back", async () => {
    const root = tempRoot();
    const sqlite = await sqliteStore(root);
    const db = connect(sqlite.dbPath);
    await new SqliteWorkspaceFeedRepository(() => db).setFeedIds(["inbox"]);

    const repository = new SqliteWorkspaceFeedRepository(() => failingDeleteConnection(db));
    const failure = await rejection(repository.setFeedIds(["inbox", "ffo"]));

    expect(failure.code).toBe("SQLITE_BUSY");
    expect(failure.message).toBe("database is locked");
    expect(db.inTransaction).toBe(false);
    expect(feedRows(db).map((row) => row.feed_id)).toEqual(["inbox"]);
  });

  test("surfaces SQLITE_BUSY when another connection holds the write lock", async () => {
    const root = tempRoot();
    const sqlite = await sqliteStore(root);
    const db = connect(sqlite.dbPath);
    const repository = new SqliteWorkspaceFeedRepository(() => db);
    await repository.setFeedIds(["inbox"]);

    const holder = connect(sqlite.dbPath);
    holder.exec("BEGIN IMMEDIATE");
    const failure = await rejection(repository.setFeedIds(["inbox", "ffo"]));
    expect(failure.code).toBe("SQLITE_BUSY");
    expect(failure.message).not.toContain("cannot rollback");
    expect(db.inTransaction).toBe(false);

    holder.exec("ROLLBACK");
    expect(feedRows(db).map((row) => row.feed_id)).toEqual(["inbox"]);
    await repository.setFeedIds(["inbox", "ffo"]);
    expect(feedRows(db).map((row) => row.feed_id)).toEqual(["inbox", "ffo"]);
  });
});

describe("MirroredWorkspaceFeedRepository.init", () => {
  test("does not write when sqlite and the mirror already agree", async () => {
    const root = tempRoot();
    const sqlite = await sqliteStore(root);
    const mirrorPath = path.join(root, "workspace.json");
    const firstBoot = new MirroredWorkspaceFeedRepository(sqlite.workspaceFeeds(), new FileWorkspaceFeedRepository(mirrorPath));
    await firstBoot.init(["inbox", "ffo"]);

    const db = connect(sqlite.dbPath);
    db.query("UPDATE workspace_feeds SET created_at = ?").run("2000-01-01T00:00:00.000Z");
    const before = feedRows(db);
    expect(before.map((row) => row.feed_id)).toEqual(["inbox", "ffo"]);

    const primary = new RecordingWorkspaceFeedRepository(sqlite.workspaceFeeds());
    const mirror = new RecordingWorkspaceFeedRepository(new FileWorkspaceFeedRepository(mirrorPath));
    await new MirroredWorkspaceFeedRepository(primary, mirror).init(["inbox", "ffo"]);

    expect(primary.writes).toEqual([]);
    expect(mirror.writes).toEqual([]);
    expect(feedRows(db)).toEqual(before);
    expect(await mirror.listFeedIds()).toEqual(["inbox", "ffo"]);
  });

  test("still merges both copies when sqlite and the mirror disagree", async () => {
    const root = tempRoot();
    const sqlite = await sqliteStore(root);
    const primary = sqlite.workspaceFeeds();
    const mirror = new FileWorkspaceFeedRepository(path.join(root, "workspace.json"));
    await primary.setFeedIds(["inbox", "sqlite-only"]);
    await mirror.init(["inbox", "mirror-only"]);

    await new MirroredWorkspaceFeedRepository(primary, mirror).init(["inbox"]);

    expect(await primary.listFeedIds()).toEqual(["inbox", "sqlite-only", "mirror-only"]);
    expect(await mirror.listFeedIds()).toEqual(["inbox", "sqlite-only", "mirror-only"]);
  });
});

describe("AttentionStore.init", () => {
  test("runs startup reconciliation once across concurrent initialization and workspace reads", async () => {
    const root = tempRoot();
    const dataDir = path.join(root, "data");
    const workspaceFeeds = new CountingWorkspaceFeedRepository(
      new FileWorkspaceFeedRepository(path.join(dataDir, "workspace.json")),
    );
    const store = new AttentionStore(dataDir, { workspaceFeeds });

    await Promise.all([store.init(), store.init(), store.init()]);
    expect(workspaceFeeds.initCalls).toBe(1);

    const workspaces = await Promise.all([
      store.readWorkspace("inbox"),
      store.readWorkspace("company-attention"),
      store.readWorkspace("inbox"),
    ]);
    expect(workspaces.map((workspace) => workspace.active.config.id)).toEqual([
      "inbox",
      "company-attention",
      "inbox",
    ]);
    expect(workspaceFeeds.initCalls).toBe(1);
  });

  test("allows a later initialization attempt after a startup failure", async () => {
    const root = tempRoot();
    const dataDir = path.join(root, "data");
    const inner = new FileWorkspaceFeedRepository(path.join(dataDir, "workspace.json"));
    let attempts = 0;
    const workspaceFeeds: WorkspaceFeedRepository = {
      async init(defaultFeedIds) {
        attempts += 1;
        if (attempts === 1) throw new Error("fixture startup failure");
        await inner.init(defaultFeedIds);
      },
      listFeedIds: () => inner.listFeedIds(),
      setFeedIds: (feedIds) => inner.setFeedIds(feedIds),
      addFeedId: (feedId) => inner.addFeedId(feedId),
      removeFeedId: (feedId) => inner.removeFeedId(feedId),
    };
    const store = new AttentionStore(dataDir, { workspaceFeeds });

    await expect(store.init()).rejects.toThrow("fixture startup failure");
    await store.init();
    expect(attempts).toBe(2);
    expect((await store.readWorkspace("inbox")).active.config.id).toBe("inbox");
  });
});
