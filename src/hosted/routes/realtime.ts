import { Hono } from "hono";
import type { HostedEnv } from "../env";
import { feedObject, requireSession } from "../identity";

export const realtimeRoutes = new Hono<{ Bindings: HostedEnv }>();

realtimeRoutes.get("/api/events", () => {
  return new Response("Hosted Attention uses /api/events/ws?feed=<id> WebSockets for realtime updates.", { status: 426 });
});

realtimeRoutes.get("/api/events/ws", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade request.", { status: 426 });
  }
  let session;
  try {
    session = await requireSession(c);
  } catch {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.close(1008, "Sign in to use hosted Attention.");
    return new Response(null, { status: 101, webSocket: client });
  }
  const feedId = c.req.query("feed") ?? "inbox";
  return feedObject(c.env, session.accountId, feedId).fetch(new Request("https://attention.internal/events/ws", {
    method: c.req.raw.method,
    headers: {
      ...Object.fromEntries(c.req.raw.headers),
      "x-attention-feed-id": feedId,
    },
  }));
});
