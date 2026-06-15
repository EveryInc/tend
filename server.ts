import { Hono } from "hono";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AttentionDomain } from "./server/domain";
import { apiRoutes } from "./server/routes/api";
import { assetRoutes } from "./server/routes/assets";
import { createRealtimeHub } from "./server/routes/realtime";
import { createFeedEventBridge } from "./server/realtime/feedEventBridge";
import { createLocalRuntime, resolveArtifactsDir, resolveDataDir, resolveDbPath, resolveRuntimeRoot } from "./server/runtime";
import { DrainDispatcher } from "./server/dispatcher";
import { mobileCloudConfigFromEnv, SupabaseMobileCloudClient } from "./server/mobile/client";
import { MobileSyncWorker } from "./server/mobile/sync";
import { makeToken } from "./server/util";

declare const Bun: {
  serve(options: { port: number; hostname: string; idleTimeout: number; fetch: (...args: any[]) => any }): { stop(force?: boolean): void };
};

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.ATTENTION_API_PORT ?? 4332);
const clientDir = process.env.ATTENTION_CLIENT_DIR ?? path.join(root, "dist");
const runtimeRoot = resolveRuntimeRoot(root);
const artifactsDir = resolveArtifactsDir(root);
const dataDir = resolveDataDir(root);
const { sqlite, store } = await createLocalRuntime(dataDir, resolveDbPath(root));
const domain = new AttentionDomain(store);
const mutationToken = process.env.ATTENTION_MUTATION_TOKEN ?? makeToken();
const realtime = createRealtimeHub();
const feedEventBridge = createFeedEventBridge(store, realtime.notify);
await feedEventBridge.start();
const drainDispatcher = new DrainDispatcher(store, { appRoot: root, runtimeRoot });
if (process.env.ATTENTION_AUTODRAIN === "1") drainDispatcher.start();
const mobileConfig = mobileCloudConfigFromEnv();
const mobileSync = mobileConfig
  ? new MobileSyncWorker(store, domain, new SupabaseMobileCloudClient(mobileConfig))
  : null;
mobileSync?.start();
const app = new Hono();

app.route("/", apiRoutes({
  artifactsDir,
  dataDir,
  domain,
  mobileStatus: () => mobileSync?.currentStatus() ?? { enabled: false },
  mutationToken,
  notify: realtime.notify,
  port,
  root,
  sqlite,
  store,
}));
app.route("/", realtime.routes());
app.route("/", assetRoutes(clientDir));

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  fetch: app.fetch,
});

console.log(`attention api listening on http://127.0.0.1:${port}`);

export function closeServer() {
  mobileSync?.stop();
  drainDispatcher.stop();
  feedEventBridge.stop();
  server.stop(true);
}
