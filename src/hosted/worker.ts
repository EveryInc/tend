import { Hono } from "hono";
import type { HostedEnv } from "./env";
import { AccountDO } from "./durable/account-do";
import { FeedDO } from "./durable/feed-do";
import { apiRoutes } from "./routes/api";
import { authRoutes } from "./routes/auth";
import { mcpRoutes } from "./routes/mcp";
import { realtimeRoutes } from "./routes/realtime";

export { AccountDO, FeedDO };

const app = new Hono<{ Bindings: HostedEnv }>();

app.route("/", authRoutes);
app.route("/", mcpRoutes);
app.route("/api", apiRoutes);
app.route("/", realtimeRoutes);
app.get("*", (c) => {
  const pathname = new URL(c.req.url).pathname;
  if (pathname.startsWith("/api/") || pathname === "/api" || pathname.startsWith("/mcp") || pathname.startsWith("/.well-known/")) {
    return c.notFound();
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
