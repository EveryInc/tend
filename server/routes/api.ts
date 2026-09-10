import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseOptionalWorkAgent } from "../../shared/lanes";
import type { PostActionCompletion, VoiceTarget } from "../../shared/types";
import type { NativeApprovalSubmission } from "../../shared/nativeApproval";
import type { ReaderConfig } from "../../shared/readers";
import { ReadingCardRequestError, mindContextPublicationReceipt } from "../domain";
import { versionInfo } from "../version";
import { IMAGE_NAME, MAX_CARD_IMAGE_BYTES, readCardImage } from "../imageAttachments";
import { body, hasCurrentMutationSession, mutation, mutationAccessError, type LocalRouteContext } from "./shared";

async function readingMutation(c: any, context: LocalRouteContext, callback: () => Promise<unknown>, announce = true) {
  const accessError = mutationAccessError(c, context.mutationToken);
  if (accessError) return accessError;
  // Provider launches, ratings, and reading state require a current session even without Origin.
  if (!context.mutationToken || c.req.header("x-attention-mutation-token") !== context.mutationToken) {
    return c.json({ error: "A current local Tend session is required." }, 403);
  }
  try {
    const result = await callback();
    if (announce) context.notify({ changedAt: new Date().toISOString() });
    return c.json(result);
  } catch (error) {
    if (error instanceof ReadingCardRequestError) {
      return c.json({ error: error.message, code: error.code }, error.status);
    }
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

export function apiRoutes(context: LocalRouteContext): Hono {
  const { artifactsDir, dataDir, domain, mobileStatus, mutationToken, notify, sqlite, store } = context;
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    const error = mutationAccessError(c, mutationToken);
    if (error) return error;
    await next();
  });

  app.get("/api/session", (c) => {
    c.header("cache-control", "no-store");
    return c.json({ mutationToken });
  });
  app.get("/api/status", (c) => c.json({ ok: true, version: versionInfo(), dataDir, sqlite: sqlite.status() }));
  app.get("/api/state", async (c) => c.json(await store.readWorkspace(c.req.query("feed") ?? "inbox")));
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/mobile/status", (c) => c.json(mobileStatus?.() ?? { enabled: false }));
  app.get("/api/mind-context/current", async (c) => {
    c.header("cache-control", "no-store");
    return c.json(await domain.readMindContextWorkspace());
  });
  app.get("/api/mind-context/:update", async (c) => {
    c.header("cache-control", "no-store");
    try {
      return c.json(await domain.readMindContextUpdate(c.req.param("update")));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });
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
      const contents = IMAGE_NAME.test(name)
        ? await readCardImage(artifactsDir, name)
        : await readFile(path.join(artifactsDir, artifactType.directory, name));
      return c.body(new Uint8Array(contents), 200, { "content-type": artifactType.contentType, "content-disposition": `inline; filename="${name}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    } catch {
      return c.text("Artifact not found.", 404);
    }
  });
  app.post("/api/feeds/:feed/images", async (c) => readingMutation(c, context, async () => {
    const input = await body(c);
    if (typeof input.pngBase64 !== "string" || input.pngBase64.length > Math.ceil(MAX_CARD_IMAGE_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.pngBase64)) throw new Error("A PNG encoded as base64 is required (up to 20 MB).");
    if (typeof input.cardId !== "string" || typeof input.contentRevision !== "string" || typeof input.filename !== "string") throw new Error("Source card, revision and filename are required.");
    return domain.importImage(c.req.param("feed"), input.cardId, input.contentRevision, Buffer.from(input.pngBase64, "base64"), input.filename);
  }, false));
  app.get("/api/feeds/:feed/how", async (c) => c.json(await domain.inspectHowFeedWorks(c.req.param("feed"))));
  app.get("/api/feeds/:feed/runs/:run", async (c) => {
    c.header("cache-control", "no-store");
    try {
      const feedId = c.req.param("feed");
      const runId = c.req.param("run");
      const plainId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,150}$/;
      if (!plainId.test(feedId) || !plainId.test(runId)) throw new Error("Invalid source run identifier.");
      const run = await store.readRun(feedId, runId);
      if (run.feedId !== feedId || run.id !== runId) throw new Error("Source run identity does not match.");
      return c.json(run);
    } catch {
      return c.json({ error: "Source run not found." }, 404);
    }
  });
  app.post("/api/feeds/:feed/runs/:run/readers", async (c) => readingMutation(c, context, async () => {
    if (!context.readers) throw new Error("The local reader runner is unavailable. Restart Tend with the current build.");
    const input = await body(c);
    if (typeof input.packet !== "string") throw new Error("A frozen text packet is required.");
    if (!Array.isArray(input.readers) || input.readers.length === 0) throw new Error("An explicit reader configuration is required.");
    if (input.promptSha256 !== undefined && typeof input.promptSha256 !== "string") throw new Error("promptSha256 must be a string.");
    return context.readers.start({
      feedId: c.req.param("feed"),
      sourceRunId: c.req.param("run"),
      packet: input.packet,
      readers: input.readers as ReaderConfig[],
      promptSha256: input.promptSha256 as string | undefined,
    });
  }));
  app.get("/api/feeds/:feed/runs/:run/readers/:reader/output", async (c) => {
    c.header("cache-control", "no-store");
    if (!context.readers) return c.json({ error: "The local reader runner is unavailable." }, 503);
    try {
      return c.json(await context.readers.readOutput(c.req.param("feed"), c.req.param("run"), c.req.param("reader")));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });
  app.post("/api/feeds/:feed/cards/:card/reaction", async (c) => readingMutation(c, context, async () => {
    return domain.recordCardReaction(c.req.param("feed"), c.req.param("card"), await body(c) as any);
  }));
  app.post("/api/feeds/:feed/cards/:card/engagement", async (c) => readingMutation(c, context, async () => {
    return domain.recordReadingEngagement(c.req.param("feed"), c.req.param("card"), await body(c));
  }, false));
  app.get("/api/feeds/:feed/reading-engagement", async (c) => {
    c.header("cache-control", "no-store");
    return c.json(await domain.readingEngagement(c.req.param("feed"), c.req.query("card")));
  });
  app.post("/api/feeds/:feed/reading-preferences", async (c) => readingMutation(c, context, async () => {
    return domain.recordReadingPreference(c.req.param("feed"), await body(c));
  }));
  app.post("/api/feeds/:feed/reading-comparisons", async (c) => readingMutation(c, context, async () => {
    return domain.linkReadingComparison(c.req.param("feed"), await body(c));
  }));
  app.post("/api/feeds/:feed/reading-mode", async (c) => readingMutation(c, context, async () => {
    return domain.setReadingMode(c.req.param("feed"), await body(c));
  }));
  app.post("/api/feeds/:feed/reading-progress", async (c) => readingMutation(c, context, async () => {
    return domain.recordReadingProgress(c.req.param("feed"), await body(c));
  }));
  app.get("/api/feeds/:feed/native-approvals", async (c) => {
    c.header("cache-control", "no-store");
    return c.json(await context.nativeApprovals?.list(c.req.param("feed")) ?? []);
  });
  app.post("/api/feeds/:feed/native-approvals/:id/respond", async (c) => mutation(c, notify, async () => {
    if (!context.nativeApprovals) throw new Error("Native confirmations are unavailable.");
    return context.nativeApprovals.respond(c.req.param("feed"), c.req.param("id"), await body(c) as unknown as NativeApprovalSubmission);
  }));
  app.get("/api/global-prompts", async (c) => c.json(await domain.inspectGlobalPromptWorkspace()));

  app.post("/api/feeds", async (c) => mutation(c, notify, async () => {
    const input = await body(c);
    return domain.createFeedFromBrief(String(input.brief ?? ""), input.currentThreadId ? String(input.currentThreadId) : null);
  }));
  app.post("/api/mind-context", async (c) => mutation(c, notify, async () => {
    const input = await body(c);
    return mindContextPublicationReceipt(
      await domain.publishMindContext(String(input.threadId ?? ""), input.context as any),
    );
  }));
  app.post("/api/feeds/:feed/bind", async (c) => mutation(c, notify, async () => domain.bindFeed(c.req.param("feed"), String((await body(c)).threadId ?? ""))));
  app.post("/api/agents/:agent/presence", async (c) => {
    if (c.req.param("agent") !== "claude") return c.json({ error: "Unsupported agent presence endpoint." }, 404);
    return mutation(c, notify, async () => {
      const input = await body(c);
      return domain.registerAgentPresence("claude", {
        sessionId: String(input.sessionId ?? ""),
        ...(typeof input.label === "string" ? { label: input.label } : {}),
      });
    }, (result) => Boolean((result as { changed?: boolean }).changed));
  });
  app.post("/api/feeds/:feed/drain-agent", async (c) => mutation(c, notify, async () => {
    const input = await body(c);
    return domain.setFeedDrainAgent(c.req.param("feed"), parseOptionalWorkAgent(input.agent) ?? "codex");
  }));
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
    return domain.submitVoiceInstruction(String(input.feedId ?? "inbox"), input.target as VoiceTarget, String(input.instruction ?? ""), {
      assignee: parseOptionalWorkAgent(input.assignee),
      ...(hasCurrentMutationSession(c, mutationToken) && typeof input.expectedCardUpdatedAt === "string"
        ? { trustedCardSnapshot: { updatedAt: input.expectedCardUpdatedAt } }
        : {}),
    });
  }));
  app.post("/api/revision-proposals/:proposal/apply", async (c) => mutation(c, notify, async () => domain.applyRevisionProposal(c.req.param("proposal"))));
  app.post("/api/revision-proposals/:proposal/reject", async (c) => mutation(c, notify, async () => domain.rejectRevisionProposal(c.req.param("proposal"))));
  app.post("/api/revision-proposals/:proposal", async (c) => mutation(c, notify, async () => domain.updateRevisionProposal(c.req.param("proposal"), String((await body(c)).content ?? ""))));
  app.post("/api/revisions/:revision/revert", async (c) => mutation(c, notify, async () => domain.revertWorkspaceRevision(c.req.param("revision"))));
  app.post("/api/feeds/:feed/recollect", async (c) => mutation(c, notify, async () => domain.requestSweepRecollection(c.req.param("feed"))));
  app.post("/api/feeds/:feed/instructions", async (c) => mutation(c, notify, async () => {
    const input = await body(c);
    return domain.queueFeedInstruction(c.req.param("feed"), String(input.instruction ?? ""), { assignee: parseOptionalWorkAgent(input.assignee) });
  }));
  app.post("/api/feeds/:feed/cards/:card/instructions", async (c) => mutation(c, notify, async () => {
    const input = await body(c);
    return domain.queueInstruction(c.req.param("feed"), c.req.param("card"), String(input.instruction ?? ""), { assignee: parseOptionalWorkAgent(input.assignee) });
  }));
  app.post("/api/feeds/:feed/work/:work/cancel", async (c) => mutation(c, notify, async () => domain.cancelQueuedWork(c.req.param("feed"), c.req.param("work"), String((await body(c)).reason ?? "Cancelled from the browser before Codex started work."))));
  app.post("/api/feeds/:feed/work/:work/instruction", async (c) => mutation(c, notify, async () => domain.updateQueuedWorkInstruction(c.req.param("feed"), c.req.param("work"), String((await body(c)).instruction ?? ""))));
  app.post("/api/feeds/:feed/work/:work/assignee", async (c) => mutation(c, notify, async () => {
    const input = await body(c);
    return domain.reassignQueuedWork(c.req.param("feed"), c.req.param("work"), parseOptionalWorkAgent(input.agent) ?? "codex");
  }));
  app.post("/api/feeds/:feed/work/:work/reconcile-approved", async (c) => mutation(c, notify, async () => {
    const input = await body(c);
    const result = input.result && typeof input.result === "object" ? input.result as { response: string; done?: boolean; postAction?: PostActionCompletion } : { response: "" };
    return domain.reconcileApprovedWork(c.req.param("feed"), c.req.param("work"), String(input.token ?? ""), result);
  }));
  app.post("/api/feeds/:feed/work/:work/retry", async (c) => mutation(c, notify, async () => domain.retryApprovedWork(c.req.param("feed"), c.req.param("work"))));
  app.post("/api/feeds/:feed/routine-actions/:group/approve", async (c) => mutation(c, notify, async () => domain.approveRoutineActionGroup(c.req.param("feed"), c.req.param("group"))));
  app.post("/api/feeds/:feed/cards/:card/actions/:action", async (c) => mutation(c, notify, async () => domain.runCardAction(c.req.param("feed"), c.req.param("card"), c.req.param("action"))));
  app.post("/api/feeds/:feed/cards/:card/approve", async (c) => mutation(c, notify, async () => domain.approveAction(c.req.param("feed"), c.req.param("card"))));
  app.post("/api/feeds/:feed/cards/:card/dismiss", async (c) => mutation(c, notify, async () => domain.dismissCard(c.req.param("feed"), c.req.param("card"))));
  app.post("/api/feeds/:feed/cards/:card/cleanup-source", async (c) => mutation(c, notify, async () => domain.queueSourceCleanup(c.req.param("feed"), c.req.param("card"))));
  app.post("/api/feeds/:feed/cards/:card/undo-cleanup-source", async (c) => mutation(c, notify, async () => domain.undoSourceCleanup(c.req.param("feed"), c.req.param("card"))));
  app.post("/api/feeds/:feed/cards/:card/return-to-review", async (c) => mutation(c, notify, async () => domain.returnCardToReview(c.req.param("feed"), c.req.param("card"))));
  app.post("/api/feeds/:feed/cards/:card/blocks/:block", async (c) => mutation(c, notify, async () => domain.updateBlock(c.req.param("feed"), c.req.param("card"), c.req.param("block"), String((await body(c)).value ?? ""))));
  app.post("/api/feeds/:feed/next-pass", async (c) => mutation(c, notify, async () => domain.beginNextPass(c.req.param("feed"))));
  app.post("/api/feeds/:feed/compound", async (c) => mutation(c, notify, async () => domain.queueCompound(c.req.param("feed"))));
  app.post("/api/dev/demo", async (c) => mutation(c, notify, async () => domain.seedDemo()));

  return app;
}
