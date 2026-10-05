import type { Database } from "bun:sqlite";

export type EventSubscription = {
  id: string; feed: string; thread: string; url: string; secret: string;
  previousSecret?: string; rotationUntil?: number; expires: number; generation: string;
};
export type EventDelivery = {
  id: string; subscription: string; generation: string; feed: string; work: string;
  revision: string; body: string; status: string; attempts: number; nextAttempt: number;
};

/** Uses the runtime's connection so work and its outbox entry commit together. */
export class McpEventRepository {
  constructor(private readonly database: () => Database) {}
  init() {
    this.database().exec(`
      CREATE TABLE IF NOT EXISTS mcp_event_subscriptions (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_event_outbox (
        id TEXT PRIMARY KEY, subscription TEXT NOT NULL, generation TEXT NOT NULL,
        feed TEXT NOT NULL, work TEXT NOT NULL, revision TEXT NOT NULL,
        body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, nextAttempt INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS mcp_event_pending ON mcp_event_outbox(status,nextAttempt);
    `);
  }
  subscriptions(): EventSubscription[] {
    return (this.database().query("SELECT payload FROM mcp_event_subscriptions").all() as { payload: string }[]).map(row => JSON.parse(row.payload));
  }
  save(subscription: EventSubscription) {
    this.database().query("INSERT INTO mcp_event_subscriptions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(subscription.id, JSON.stringify(subscription));
  }
  remove(id: string) {
    this.database().query("DELETE FROM mcp_event_subscriptions WHERE id=?").run(id);
    this.database().query("UPDATE mcp_event_outbox SET status='stopped' WHERE subscription=? AND status='pending'").run(id);
  }
  enqueue(delivery: Omit<EventDelivery, "status" | "attempts" | "nextAttempt">) {
    this.database().query("INSERT OR IGNORE INTO mcp_event_outbox(id,subscription,generation,feed,work,revision,body) VALUES (?,?,?,?,?,?,?)")
      .run(delivery.id, delivery.subscription, delivery.generation, delivery.feed, delivery.work, delivery.revision, delivery.body);
  }
  deliveries(status?: string): EventDelivery[] {
    return (status ? this.database().query("SELECT * FROM mcp_event_outbox WHERE status=? ORDER BY rowid LIMIT 100").all(status)
      : this.database().query("SELECT * FROM mcp_event_outbox ORDER BY rowid LIMIT 100").all()) as EventDelivery[];
  }
  due(now: number): EventDelivery[] {
    return this.database().query("SELECT * FROM mcp_event_outbox WHERE status='pending' AND nextAttempt<=? ORDER BY nextAttempt,rowid LIMIT 100").all(now) as EventDelivery[];
  }
  accepted(feed: string): EventDelivery[] {
    return this.database().query("SELECT * FROM mcp_event_outbox WHERE status='accepted' AND feed=? ORDER BY rowid DESC").all(feed) as EventDelivery[];
  }
  get(id: string): EventDelivery | null {
    return this.database().query("SELECT * FROM mcp_event_outbox WHERE id=?").get(id) as EventDelivery | null;
  }
  settle(id: string, status: string, attempts: number, nextAttempt = 0) {
    this.database().query("UPDATE mcp_event_outbox SET status=?,attempts=?,nextAttempt=? WHERE id=?").run(status, attempts, nextAttempt, id);
  }
}
