import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalSqliteStore } from "../server/sqlite";
import type { FeedEvent } from "../shared/types";

test("migrated event ordering preserves approvals across API and CLI writes and retries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "attention-event-order-"));
  const dbPath = path.join(root, "attention.db");
  const approval: FeedEvent = {
    id: "event-approved",
    feedId: "inbox",
    type: "card.action_approved",
    at: "2026-08-31T20:00:00.000Z",
    cardId: "reply-card",
    workId: "reply-work",
    detail: { actionId: "send-reply", digest: "approved-artifact" },
  };
  const priorSweep: FeedEvent = {
    id: "event-prior-sweep",
    feedId: "company",
    type: "sweep.batch_recorded",
    at: approval.at,
  };
  const api = new LocalSqliteStore(dbPath);
  const cli = new LocalSqliteStore(dbPath);
  try {
    const seed = new Database(dbPath, { create: true });
    try {
      // Existing migrated rows may include zero and gaps in the global order.
      seed.exec(`
        CREATE TABLE feed_events (
          event_order INTEGER NOT NULL DEFAULT 0,
          id TEXT PRIMARY KEY,
          feed_id TEXT NOT NULL,
          type TEXT NOT NULL,
          at TEXT NOT NULL,
          card_id TEXT,
          work_id TEXT,
          detail_json TEXT
        );
        CREATE UNIQUE INDEX idx_feed_events_order ON feed_events (event_order);
      `);
      const insert = seed.query(`
        INSERT INTO feed_events (event_order, id, feed_id, type, at, card_id, work_id, detail_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [order, event] of [[0, approval], [41, priorSweep]] as const) {
        insert.run(order, event.id, event.feedId, event.type, event.at,
          event.cardId ?? null, event.workId ?? null,
          event.detail === undefined ? null : JSON.stringify(event.detail));
      }
    } finally {
      seed.close();
    }

    await api.init();
    await cli.init();
    const apiEvents = api.feedEvents();
    const cliEvents = cli.feedEvents();
    const verified: FeedEvent = {
      ...approval,
      id: "event-verified",
      type: "action.verified",
      at: "2026-08-31T19:00:00.000Z",
    };
    const sweep: FeedEvent = { ...priorSweep, id: "event-new-sweep" };
    const completed: FeedEvent = {
      ...approval,
      id: "event-completed",
      type: "work.completed",
      at: "2026-08-31T18:00:00.000Z",
      detail: { receipt: "fixture-receipt" },
    };
    await cliEvents.append(verified);
    await apiEvents.append(sweep);
    await cliEvents.append(completed);
    await apiEvents.append({ ...approval, detail: { digest: "must-not-replace-approval" } });

    cli.close();
    await cli.init();
    await cliEvents.append({ ...completed, detail: { receipt: "must-not-replace-receipt" } });

    expect(await apiEvents.list("inbox")).toEqual([approval, verified, completed]);
    expect(await cliEvents.list("inbox")).toEqual([approval, verified, completed]);
    expect(await apiEvents.list("company")).toEqual([priorSweep, sweep]);
    const inspection = new Database(dbPath, { readonly: true });
    try {
      expect(inspection.query("SELECT event_order, id FROM feed_events ORDER BY event_order").all()).toEqual([
        { event_order: 0, id: approval.id },
        { event_order: 41, id: priorSweep.id },
        { event_order: 42, id: verified.id },
        { event_order: 43, id: sweep.id },
        { event_order: 44, id: completed.id },
      ]);
    } finally {
      inspection.close();
    }
  } finally {
    cli.close();
    api.close();
    await rm(root, { recursive: true, force: true });
  }
});
