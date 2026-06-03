import { Hono } from "hono";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AttentionDomain } from "./server/domain";
import { createMcpRequestHandler } from "./server/mcp";
import { apiRoutes } from "./server/routes/api";
import { assetRoutes } from "./server/routes/assets";
import { createRealtimeHub } from "./server/routes/realtime";
import { createLocalRuntime } from "./server/runtime";

declare const Bun: {
  serve(options: { port: number; hostname: string; idleTimeout: number; fetch: (...args: any[]) => any }): { stop(force?: boolean): void };
};

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.ATTENTION_API_PORT ?? 4332);
const clientDir = process.env.ATTENTION_CLIENT_DIR ?? path.join(root, "dist");
const { dataDir, sqlite, store } = await createLocalRuntime();
const domain = new AttentionDomain(store);
const realtime = createRealtimeHub();
const mcpHandler = await createMcpRequestHandler(domain, store);
const app = new Hono();

app.route("/", apiRoutes({ dataDir, domain, notify: realtime.notify, port, root, sqlite, store }));
app.route("/", realtime.routes());
app.all("/mcp", async (c) => mcpHandler(c.req.raw));
app.route("/", assetRoutes(clientDir));

console.log(`attention api listening on http://127.0.0.1:${port}`);

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  fetch: app.fetch,
});

export function closeServer() {
  server.stop(true);
}
