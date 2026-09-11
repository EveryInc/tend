import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalRuntime } from "../server/runtime";
import { createFeedEventBridge } from "../server/realtime/feedEventBridge";

test("SQLite realtime cursors detect appends without reading event payloads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-event-cursor-"));
  const runtime = await createLocalRuntime(path.join(root, "data"));
  try {
    runtime.store.readEvents = async () => { throw new Error("Full event history was read"); };
    const notifications: unknown[] = [];
    const bridge = createFeedEventBridge(runtime.store, (value) => notifications.push(value));
    await bridge.poll();
    await bridge.poll();
    expect(notifications).toHaveLength(0);
    await runtime.store.appendEvent({ feedId: "inbox", type: "fixture.changed", detail: { payload: "updated" } });
    await bridge.poll();
    expect(notifications).toHaveLength(1);
    await bridge.poll();
    expect(notifications).toHaveLength(1);
  } finally {
    runtime.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});
