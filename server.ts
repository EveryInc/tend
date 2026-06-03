import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AttentionDomain } from "./server/domain";
import { createMcpRequestHandler } from "./server/mcp";
import { attentionDataDir } from "./server/paths";
import { LocalSqliteStore } from "./server/sqlite";
import { AttentionStore } from "./server/store";

declare const Bun: {
  serve(options: { port: number; hostname: string; idleTimeout: number; fetch: (...args: any[]) => any }): { stop(force?: boolean): void };
};

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = attentionDataDir();
const port = Number(process.env.ATTENTION_API_PORT ?? 4332);
const clientDir = process.env.ATTENTION_CLIENT_DIR ?? path.join(root, "dist");
const store = new AttentionStore(dataDir);
const domain = new AttentionDomain(store);
const sqlite = new LocalSqliteStore();
await mkdir(dataDir, { recursive: true });
await sqlite.init();
await store.init();
const mcpHandler = await createMcpRequestHandler(domain, store);

const app = new Hono();
const listeners = new Set<(data: unknown) => void>();

function notify(data: unknown) {
  for (const send of listeners) send(data);
}

async function body(c: any) {
  return c.req.json().catch(() => ({}));
}

async function mutation(c: any, callback: () => Promise<unknown>) {
  try {
    const result = await callback();
    notify({ changedAt: new Date().toISOString() });
    return c.json(result);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

app.get("/api/status", (c) => c.json({ ok: true, dataDir, sqlite: sqlite.status(), mcpUrl: `http://127.0.0.1:${port}/mcp` }));
app.get("/api/state", async (c) => c.json(await store.readWorkspace(c.req.query("feed") ?? "inbox")));
app.get("/api/artifacts/:name", async (c) => {
  const name = c.req.param("name");
  const artifactTypes: Record<string, { directory: string; contentType: string }> = {
    ".jpeg": { directory: "artifacts", contentType: "image/jpeg" },
    ".jpg": { directory: "artifacts", contentType: "image/jpeg" },
    ".pdf": { directory: "pdf", contentType: "application/pdf" },
    ".png": { directory: "artifacts", contentType: "image/png" },
  };
  const artifactType = artifactTypes[path.extname(name).toLowerCase()];
  if (path.basename(name) !== name || !artifactType) return c.text("Artifact not found.", 404);
  try {
    const contents = await readFile(path.join(root, "output", artifactType.directory, name));
    return c.body(contents, 200, { "content-type": artifactType.contentType, "content-disposition": `inline; filename="${name}"` });
  } catch {
    return c.text("Artifact not found.", 404);
  }
});
app.get("/api/feeds/:feed/how", async (c) => c.json(await domain.inspectHowFeedWorks(c.req.param("feed"))));
app.get("/api/global-prompts", async (c) => c.json(await domain.inspectGlobalPromptWorkspace()));
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

app.post("/api/feeds", async (c) => mutation(c, async () => {
  const input = await body(c);
  return domain.createFeedFromBrief(String(input.brief ?? ""), input.currentThreadId ? String(input.currentThreadId) : null);
}));
app.post("/api/feeds/:feed/bind", async (c) => mutation(c, async () => domain.bindFeed(c.req.param("feed"), String((await body(c)).threadId ?? ""))));
app.post("/api/feeds/:feed/heartbeat", async (c) => mutation(c, async () => domain.proposeHeartbeat(c.req.param("feed"), String((await body(c)).cadence ?? ""))));
app.post("/api/feeds/:feed/sources", async (c) => mutation(c, async () => domain.addSourceFromBrief(c.req.param("feed"), String((await body(c)).brief ?? ""))));
app.post("/api/feeds/:feed/sources/:source", async (c) => mutation(c, async () => domain.updateWorkspaceDocument(c.req.param("feed"), { kind: "source_recipe", feedId: c.req.param("feed"), sourceId: c.req.param("source") }, String((await body(c)).content ?? ""))));
app.post("/api/feeds/:feed/policy", async (c) => mutation(c, async () => domain.updateWorkspaceDocument(c.req.param("feed"), { kind: "feed", feedId: c.req.param("feed") }, String((await body(c)).content ?? ""))));
app.post("/api/feeds/:feed/prompts/:prompt", async (c) => mutation(c, async () => domain.updateWorkspaceDocument(c.req.param("feed"), { kind: "prompt_layer", feedId: c.req.param("feed"), promptId: c.req.param("prompt") }, String((await body(c)).content ?? ""))));
app.post("/api/global-policy", async (c) => mutation(c, async () => {
  const input = await body(c);
  return domain.updateWorkspaceDocument(String(input.feedId ?? "inbox"), { kind: "attention" }, String(input.content ?? ""));
}));
app.post("/api/global-prompts/:prompt", async (c) => mutation(c, async () => {
  const input = await body(c);
  return domain.updateWorkspaceDocument(String(input.feedId ?? "inbox"), { kind: "global_prompt", promptId: c.req.param("prompt") }, String(input.content ?? ""));
}));
app.post("/api/voice/target-change", async (c) => mutation(c, async () => {
  const input = await body(c);
  return domain.recordVoiceTargetChange(String(input.feedId ?? "inbox"), input.target);
}));
app.post("/api/voice/instructions", async (c) => mutation(c, async () => {
  const input = await body(c);
  return domain.submitVoiceInstruction(String(input.feedId ?? "inbox"), input.target, String(input.instruction ?? ""));
}));
app.post("/api/revision-proposals/:proposal/apply", async (c) => mutation(c, async () => domain.applyRevisionProposal(c.req.param("proposal"))));
app.post("/api/revision-proposals/:proposal/reject", async (c) => mutation(c, async () => domain.rejectRevisionProposal(c.req.param("proposal"))));
app.post("/api/revision-proposals/:proposal", async (c) => mutation(c, async () => domain.updateRevisionProposal(c.req.param("proposal"), String((await body(c)).content ?? ""))));
app.post("/api/revisions/:revision/revert", async (c) => mutation(c, async () => domain.revertWorkspaceRevision(c.req.param("revision"))));
app.post("/api/feeds/:feed/recollect", async (c) => mutation(c, async () => domain.requestSweepRecollection(c.req.param("feed"))));
app.post("/api/feeds/:feed/instructions", async (c) => mutation(c, async () => domain.queueFeedInstruction(c.req.param("feed"), String((await body(c)).instruction ?? ""))));
app.post("/api/feeds/:feed/cards/:card/instructions", async (c) => mutation(c, async () => domain.queueInstruction(c.req.param("feed"), c.req.param("card"), String((await body(c)).instruction ?? ""))));
app.post("/api/feeds/:feed/work/:work/cancel", async (c) => mutation(c, async () => domain.cancelQueuedWork(c.req.param("feed"), c.req.param("work"), String((await body(c)).reason ?? "Cancelled from the browser before Codex started work."))));
app.post("/api/feeds/:feed/work/:work/retry", async (c) => mutation(c, async () => domain.retryApprovedWork(c.req.param("feed"), c.req.param("work"))));
app.post("/api/feeds/:feed/routine-actions/:group/approve", async (c) => mutation(c, async () => domain.approveRoutineActionGroup(c.req.param("feed"), c.req.param("group"))));
app.post("/api/feeds/:feed/cards/:card/actions/:action", async (c) => mutation(c, async () => domain.runCardAction(c.req.param("feed"), c.req.param("card"), c.req.param("action"))));
app.post("/api/feeds/:feed/cards/:card/approve", async (c) => mutation(c, async () => domain.approveAction(c.req.param("feed"), c.req.param("card"))));
app.post("/api/feeds/:feed/cards/:card/dismiss", async (c) => mutation(c, async () => domain.dismissCard(c.req.param("feed"), c.req.param("card"))));
app.post("/api/feeds/:feed/cards/:card/undo-dismiss", async (c) => mutation(c, async () => domain.undoDismiss(c.req.param("feed"), c.req.param("card"))));
app.post("/api/feeds/:feed/cards/:card/blocks/:block", async (c) => mutation(c, async () => domain.updateBlock(c.req.param("feed"), c.req.param("card"), c.req.param("block"), String((await body(c)).value ?? ""))));
app.post("/api/feeds/:feed/next-pass", async (c) => mutation(c, async () => domain.beginNextPass(c.req.param("feed"))));
app.post("/api/feeds/:feed/compound", async (c) => mutation(c, async () => domain.queueCompound(c.req.param("feed"))));
app.post("/api/dev/demo", async (c) => mutation(c, async () => domain.seedDemo()));
app.all("/mcp", async (c) => mcpHandler(c.req.raw));

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

app.get("*", async (c) => {
  const url = new URL(c.req.url);
  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (requested.includes("..")) return c.text("Not found", 404);
  const filePath = path.join(clientDir, requested);
  try {
    const contents = await readFile(filePath);
    return c.body(contents, 200, { "content-type": contentTypes[path.extname(filePath)] ?? "application/octet-stream" });
  } catch {
    try {
      const contents = await readFile(path.join(clientDir, "index.html"));
      return c.body(contents, 200, { "content-type": "text/html; charset=utf-8" });
    } catch {
      return c.text("UI assets not built. Run pnpm build or use pnpm start for the Vite dev server.", 404);
    }
  }
});

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
