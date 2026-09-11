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
          let finish = () => {};
          const disconnected = new Promise<void>((resolve) => {
            finish = resolve;
            stream.onAbort(resolve);
          });
          const send = (data: unknown) => void stream.writeSSE({ event: "change", data: JSON.stringify(data) }).catch(finish);
          listeners.add(send);
          try {
            await stream.writeSSE({ event: "ready", data: "{}" });
            await disconnected;
          } finally {
            listeners.delete(send);
          }
        }),
      );
      return app;
    },
  };
}
