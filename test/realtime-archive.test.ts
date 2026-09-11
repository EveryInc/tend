import { expect, test } from "bun:test";
import { createFeedEventBridge } from "../server/realtime/feedEventBridge";

test("archiving a feed emits a realtime invalidation", async () => {
  let feedIds = ["inbox", "archived-feed"];
  const notifications: unknown[] = [];
  const bridge = createFeedEventBridge(
    {
      async listFeedIds() {
        return feedIds;
      },
      async readEvents(feedId: string) {
        return [{ id: `event-${feedId}`, feedId, type: "feed.created", at: "2026-09-08T12:00:00.000Z" }];
      },
    },
    (data) => notifications.push(data),
  );

  await bridge.poll();
  feedIds = ["inbox"];
  await bridge.poll();

  expect(notifications).toHaveLength(1);
});
