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

    events.push({ id: "evt_2", feedId: "inbox", type: "card.created", at: "2026-06-05T18:01:00.000Z" });
    await bridge.poll();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ source: "feed-events" });
  });
});
