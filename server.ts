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
import { loadMobileCloudEnvFile, mobileCloudConfigFromEnv, SupabaseMobileCloudClient } from "./server/mobile/client";
import { MobileSyncWorker } from "./server/mobile/sync";
import { makeToken } from "./server/util";
import { NativeApprovalBroker } from "./server/nativeApprovals";
import { ReaderRunner } from "./server/readers";

declare const Bun: {
  serve(options: { port: number; hostname: string; idleTimeout: number; fetch: (...args: any[]) => any }): { stop(force?: boolean): void };
};

const root = path.dirname(fileURLToPath(import.meta.url));
loadMobileCloudEnvFile();
const port = Number(process.env.ATTENTION_API_PORT ?? 4332);
const clientDir = process.env.ATTENTION_CLIENT_DIR ?? path.join(root, "dist");
const runtimeRoot = resolveRuntimeRoot(root);
const artifactsDir = resolveArtifactsDir(root);
const dataDir = resolveDataDir(root);
const { sqlite, store } = await createLocalRuntime(dataDir, resolveDbPath(root));
const domain = new AttentionDomain(store, artifactsDir);
const readers = new ReaderRunner(store);
const mutationToken = process.env.ATTENTION_MUTATION_TOKEN ?? makeToken();
const realtime = createRealtimeHub();
const feedEventBridge = createFeedEventBridge(store, realtime.notify);
const nativeApprovals = new NativeApprovalBroker(store, () => realtime.notify({ changedAt: new Date().toISOString() }));
const drainDispatcher = new DrainDispatcher(store, { appRoot: root, runtimeRoot, nativeApprovals });
const mobileConfig = mobileCloudConfigFromEnv();
const mobileSync = mobileConfig
  ? new MobileSyncWorker(store, domain, new SupabaseMobileCloudClient(mobileConfig))
  : null;
const app = new Hono();

app.route("/", apiRoutes({
  artifactsDir,
  dataDir,
  domain,
  mobileStatus: () => mobileSync?.currentStatus() ?? { enabled: false },
  mutationToken,
  nativeApprovals,
  readers,
  notify: realtime.notify,
  port,
  root,
  sqlite,
  store,
}));
app.route("/", realtime.routes());
app.route("/", assetRoutes(clientDir));

let initialized = false;
const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  fetch: (...args: Parameters<typeof app.fetch>) => initialized
    ? app.fetch(...args)
    : Response.json({ error: "Tend is starting." }, { status: 503 }),
});

try {
  // A bind conflict must not change another server's receipts. Reader ownership
  // also protects this data directory when a second server chooses another port.
  await readers.recoverInterrupted();
  await feedEventBridge.start();
  if (process.env.ATTENTION_AUTODRAIN === "1") drainDispatcher.start();
  mobileSync?.start();
  initialized = true;
  console.log(`Tend API listening on http://127.0.0.1:${port}`);
} catch (error) {
  await closeServer();
  throw error;
}

export async function closeServer() {
  initialized = false;
  mobileSync?.stop();
  drainDispatcher.stop();
  nativeApprovals.close();
  feedEventBridge.stop();
  server.stop(true);
  await readers.close();
}
