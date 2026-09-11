import assert from "node:assert/strict";
import { createRealtimeHub } from "../../server/routes/realtime";

const originalSetTimeout = globalThis.setTimeout;
const sleepers: Array<() => void> = [];
globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
  if (delay === 15_000) sleepers.push(() => (callback as () => void)());
  return 1 as unknown as ReturnType<typeof setTimeout>;
}) as typeof setTimeout;
const flush = () => new Promise<void>((resolve) => originalSetTimeout(resolve, 0));
try {
  const response = await createRealtimeHub().routes().request("/api/events");
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert(new TextDecoder().decode(first.value).includes("event: ready"));
  await flush();
  await reader.cancel();
  sleepers.shift()?.();
  await flush();
  console.log(JSON.stringify({ scheduledSleepsAfterCancel: sleepers.length }));
  assert.equal(sleepers.length, 0, "cancelled route must leave its idle loop");
} finally {
  globalThis.setTimeout = originalSetTimeout;
}
