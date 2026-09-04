import { describe, expect, test } from "bun:test";
import { createFeedEventBridge } from "../server/realtime/feedEventBridge";
import type { FeedEvent } from "../shared/types";

describe("feed event bridge", () => {
  test("notifies when durable feed events are appended after the initial seed", async () => {
    const events: FeedEvent[] = [
      { id: "evt_1", feedId: "inbox", type: "feed.created", at: "2026-06-05T18:00:00.000Z" },
    ];
    const notifications: unknown[] = [];
    const bridge = createFeedEventBridge(
      {
        async listFeedIds() {
          return ["inbox"];
        },
        async readEvents(feedId: string) {
          return events.filter((event) => event.feedId === feedId);
        },
      },
      (data) => notifications.push(data),
    );

    await bridge.poll();
    expect(notifications).toHaveLength(0);

    events.push({ id: "engagement-1", feedId: "inbox", type: "reading.engagement_recorded", at: "2026-06-05T18:00:30.000Z" });
    await bridge.poll();
    expect(notifications).toHaveLength(0);

    events.push({ id: "evt_2", feedId: "inbox", type: "card.created", at: "2026-06-05T18:01:00.000Z" });
    await bridge.poll();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ source: "feed-events" });

    events.push({ id: "engagement-2", feedId: "inbox", type: "reading.engagement_recorded", at: "2026-06-05T18:01:30.000Z" });
    await bridge.poll();
    expect(notifications).toHaveLength(1);
  });

  test("notifies when Chronicle publishes a new On Your Mind update", async () => {
    let contextCursor = "1:2026-06-13T18:00:00.000Z:mind-1";
    const notifications: unknown[] = [];
    const bridge = createFeedEventBridge(
      {
        async listFeedIds() {
          return [];
        },
        async readEvents() {
          return [];
        },
        async readMindContextCursor() {
          return contextCursor;
        },
      },
      (data) => notifications.push(data),
    );

    await bridge.poll();
    expect(notifications).toHaveLength(0);

    contextCursor = "2:2026-06-13T19:00:00.000Z:mind-2";
    await bridge.poll();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ source: "feed-events" });
  });
});
