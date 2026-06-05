import type { FeedEvent } from "../../shared/types";

type FeedEventReader = {
  listFeedIds(): Promise<string[]>;
  readEvents(feedId: string): Promise<FeedEvent[]>;
};

type Notify = (data: unknown) => void;

export function createFeedEventBridge(store: FeedEventReader, notify: Notify, options: { intervalMs?: number } = {}) {
  const cursors = new Map<string, string>();
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

      for (const feedId of feedIds) {
        const cursor = eventCursor(await store.readEvents(feedId));
        const previous = cursors.get(feedId);
        cursors.set(feedId, cursor);
        if (seeded && previous !== undefined && previous !== cursor) changed = true;
        if (seeded && previous === undefined) changed = true;
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
  const last = events.at(-1);
  return `${events.length}:${last?.at ?? ""}:${last?.id ?? ""}`;
}
