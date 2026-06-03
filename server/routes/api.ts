import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { VoiceTarget } from "../../src/types";
import { versionInfo } from "../version";
import { body, mutation, type LocalRouteContext } from "./shared";

export function apiRoutes(context: LocalRouteContext): Hono {
  const { dataDir, domain, notify, port, root, sqlite, store } = context;
  const app = new Hono();

  app.get("/api/status", (c) => c.json({ ok: true, version: versionInfo(), dataDir, sqlite: sqlite.status(), mcpUrl: `http://127.0.0.1:${port}/mcp` }));
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

  app.post("/api/feeds", async (c) => mutation(c, notify, async () => {
    const input = await body(c);
    return domain.createFeedFromBrief(String(input.brief ?? ""), input.currentThreadId ? String(input.currentThreadId) : null);
  }));
  app.post("/api/feeds/:feed/bind", async (c) => mutation(c, notify, async () => domain.bindFeed(c.req.param("feed"), String((await body(c)).threadId ?? ""))));
  app.post("/api/feeds/:feed/heartbeat", async (c) => mutation(c, notify, async () => domain.proposeHeartbeat(c.req.param("feed"), String((await body(c)).cadence ?? ""))));
  app.post("/api/feeds/:feed/sources", async (c) => mutation(c, notify, async () => domain.addSourceFromBrief(c.req.param("feed"), String((await body(c)).brief ?? ""))));
  app.post("/api/feeds/:feed/sources/:source", async (c) => mutation(c, notify, async () => domain.updateWorkspaceDocument(c.req.param("feed"), { kind: "source_recipe", feedId: c.req.param("feed"), sourceId: c.req.param("source") }, String((await body(c)).content ?? ""))));
  app.post("/api/feeds/:feed/policy", async (c) => mutation(c, notify, async () => domain.updateWorkspaceDocument(c.req.param("feed"), { kind: "feed", feedId: c.req.param("feed") }, String((await body(c)).content ?? ""))));
  app.post("/api/feeds/:feed/prompts/:prompt", async (c) => mutation(c, notify, async () => domain.updateWorkspaceDocument(c.req.param("feed"), { kind: "prompt_layer", feedId: c.req.param("feed"), promptId: c.req.param("prompt") }, String((await body(c)).content ?? ""))));
  app.post("/api/global-policy", async (c) => mutation(c, notify, async () => {
    const input = await body(c);
    return domain.updateWorkspaceDocument(String(input.feedId ?? "inbox"), { kind: "attention" }, String(input.content ?? ""));
  }));
  app.post("/api/global-prompts/:prompt", async (c) => mutation(c, notify, async () => {
    const input = await body(c);
    return domain.updateWorkspaceDocument(String(input.feedId ?? "inbox"), { kind: "global_prompt", promptId: c.req.param("prompt") }, String(input.content ?? ""));
  }));
  app.post("/api/voice/target-change", async (c) => mutation(c, notify, async () => {
    const input = await body(c);
    return domain.recordVoiceTargetChange(String(input.feedId ?? "inbox"), input.target as VoiceTarget);
  }));
  app.post("/api/voice/instructions", async (c) => mutation(c, notify, async () => {
    const input = await body(c);
    return domain.submitVoiceInstruction(String(input.feedId ?? "inbox"), input.target as VoiceTarget, String(input.instruction ?? ""));
  }));
  app.post("/api/revision-proposals/:proposal/apply", async (c) => mutation(c, notify, async () => domain.applyRevisionProposal(c.req.param("proposal"))));
  app.post("/api/revision-proposals/:proposal/reject", async (c) => mutation(c, notify, async () => domain.rejectRevisionProposal(c.req.param("proposal"))));
  app.post("/api/revision-proposals/:proposal", async (c) => mutation(c, notify, async () => domain.updateRevisionProposal(c.req.param("proposal"), String((await body(c)).content ?? ""))));
  app.post("/api/revisions/:revision/revert", async (c) => mutation(c, notify, async () => domain.revertWorkspaceRevision(c.req.param("revision"))));
  app.post("/api/feeds/:feed/recollect", async (c) => mutation(c, notify, async () => domain.requestSweepRecollection(c.req.param("feed"))));
  app.post("/api/feeds/:feed/instructions", async (c) => mutation(c, notify, async () => domain.queueFeedInstruction(c.req.param("feed"), String((await body(c)).instruction ?? ""))));
  app.post("/api/feeds/:feed/cards/:card/instructions", async (c) => mutation(c, notify, async () => domain.queueInstruction(c.req.param("feed"), c.req.param("card"), String((await body(c)).instruction ?? ""))));
  app.post("/api/feeds/:feed/work/:work/cancel", async (c) => mutation(c, notify, async () => domain.cancelQueuedWork(c.req.param("feed"), c.req.param("work"), String((await body(c)).reason ?? "Cancelled from the browser before Codex started work."))));
  app.post("/api/feeds/:feed/work/:work/retry", async (c) => mutation(c, notify, async () => domain.retryApprovedWork(c.req.param("feed"), c.req.param("work"))));
  app.post("/api/feeds/:feed/routine-actions/:group/approve", async (c) => mutation(c, notify, async () => domain.approveRoutineActionGroup(c.req.param("feed"), c.req.param("group"))));
  app.post("/api/feeds/:feed/cards/:card/actions/:action", async (c) => mutation(c, notify, async () => domain.runCardAction(c.req.param("feed"), c.req.param("card"), c.req.param("action"))));
  app.post("/api/feeds/:feed/cards/:card/approve", async (c) => mutation(c, notify, async () => domain.approveAction(c.req.param("feed"), c.req.param("card"))));
  app.post("/api/feeds/:feed/cards/:card/dismiss", async (c) => mutation(c, notify, async () => domain.dismissCard(c.req.param("feed"), c.req.param("card"))));
  app.post("/api/feeds/:feed/cards/:card/undo-dismiss", async (c) => mutation(c, notify, async () => domain.undoDismiss(c.req.param("feed"), c.req.param("card"))));
  app.post("/api/feeds/:feed/cards/:card/blocks/:block", async (c) => mutation(c, notify, async () => domain.updateBlock(c.req.param("feed"), c.req.param("card"), c.req.param("block"), String((await body(c)).value ?? ""))));
  app.post("/api/feeds/:feed/next-pass", async (c) => mutation(c, notify, async () => domain.beginNextPass(c.req.param("feed"))));
  app.post("/api/feeds/:feed/compound", async (c) => mutation(c, notify, async () => domain.queueCompound(c.req.param("feed"))));
  app.post("/api/dev/demo", async (c) => mutation(c, notify, async () => domain.seedDemo()));

  return app;
}
