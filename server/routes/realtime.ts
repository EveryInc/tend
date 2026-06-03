import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export function createRealtimeHub() {
  const listeners = new Set<(data: unknown) => void>();

  return {
    notify(data: unknown): void {
      for (const send of listeners) send(data);
    },
    routes(): Hono {
      const app = new Hono();
      app.get("/api/events", (c) =>
        streamSSE(c, async (stream) => {
          let active = true;
          const send = (data: unknown) => void stream.writeSSE({ event: "change", data: JSON.stringify(data) });
          listeners.add(send);
          await stream.writeSSE({ event: "ready", data: "{}" });
          while (active && !stream.closed) await stream.sleep(15_000);
          active = false;
          listeners.delete(send);
        }),
      );
      return app;
    },
  };
}
