import { Hono } from "hono";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AttentionDomain } from "./server/domain";
import { apiRoutes } from "./server/routes/api";
import { assetRoutes } from "./server/routes/assets";
import { createRealtimeHub } from "./server/routes/realtime";
import { createFeedEventBridge } from "./server/realtime/feedEventBridge";
import { createLocalRuntime, resolveArtifactsDir } from "./server/runtime";

declare const Bun: {
  serve(options: { port: number; hostname: string; idleTimeout: number; fetch: (...args: any[]) => any }): { stop(force?: boolean): void };
};

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.ATTENTION_API_PORT ?? 4332);
const clientDir = process.env.ATTENTION_CLIENT_DIR ?? path.join(root, "dist");
const artifactsDir = resolveArtifactsDir(root);
const { dataDir, sqlite, store } = await createLocalRuntime();
const domain = new AttentionDomain(store);
const realtime = createRealtimeHub();
const feedEventBridge = createFeedEventBridge(store, realtime.notify);
await feedEventBridge.start();
const app = new Hono();

app.route("/", apiRoutes({ artifactsDir, dataDir, domain, notify: realtime.notify, port, root, sqlite, store }));
app.route("/", realtime.routes());
app.route("/", assetRoutes(clientDir));

console.log(`attention api listening on http://127.0.0.1:${port}`);

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  fetch: app.fetch,
});

export function closeServer() {
  feedEventBridge.stop();
  server.stop(true);
}
