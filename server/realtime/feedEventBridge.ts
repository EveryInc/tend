import type { FeedEvent } from "../../shared/types";

type FeedEventReader = {
  listFeedIds(): Promise<string[]>;
  readEvents(feedId: string): Promise<FeedEvent[]>;
  readEventCursor?(feedId: string): Promise<string>;
  readMindContextCursor?(): Promise<string>;
};

type Notify = (data: unknown) => void;

export function createFeedEventBridge(store: FeedEventReader, notify: Notify, options: { intervalMs?: number } = {}) {
  const cursors = new Map<string, string>();
  let mindContextCursor = "";
  const intervalMs = options.intervalMs ?? 1_000;
  let seeded = false;
  let polling = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const feedIds = await store.listFeedIds();
      let changed = false;
      for (const feedId of cursors.keys()) {
        if (!feedIds.includes(feedId)) {
          cursors.delete(feedId);
          changed = true;
        }
      }

      for (const feedId of feedIds) {
        const cursor = store.readEventCursor ? await store.readEventCursor(feedId) : eventCursor(await store.readEvents(feedId));
        const previous = cursors.get(feedId);
        cursors.set(feedId, cursor);
        if (seeded && previous !== undefined && previous !== cursor) changed = true;
        if (seeded && previous === undefined) changed = true;
      }

      if (store.readMindContextCursor) {
        const nextMindContextCursor = await store.readMindContextCursor();
        if (seeded && nextMindContextCursor !== mindContextCursor) changed = true;
        mindContextCursor = nextMindContextCursor;
      }

      seeded = true;
      if (changed) notify({ changedAt: new Date().toISOString(), source: "feed-events" });
    } finally {
      polling = false;
    }
  }

  return {
    async start(): Promise<void> {
      await poll();
      timer = setInterval(() => void poll().catch(() => {}), intervalMs);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
    poll,
  };
}

function eventCursor(events: FeedEvent[]): string {
  // Descriptive interaction receipts do not change the workspace. Dwell heartbeats must
  // not force a refresh that interrupts the same reading/selection being measured.
  const changes = events.filter((event) => event.type !== "reading.engagement_recorded");
  const last = changes.at(-1);
  return `${changes.length}:${last?.at ?? ""}:${last?.id ?? ""}`;
}
