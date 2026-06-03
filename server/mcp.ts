import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AttentionDomain } from "./domain";
import type { AttentionStore } from "./store";

async function text(value: unknown) {
  const resolved = await value;
  return {
    content: [{ type: "text" as const, text: typeof resolved === "string" ? resolved : JSON.stringify(resolved, null, 2) }],
  };
}

const jsonValue = z.unknown();

export async function createMcpRequestHandler(domain: AttentionDomain, store: AttentionStore): Promise<(request: Request) => Promise<Response>> {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

  return async (request: Request) => {
    const sessionId = request.headers.get("mcp-session-id");
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (sessionId && !transport) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!transport) {
      let createdTransport: WebStandardStreamableHTTPServerTransport | null = null;
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (initializedSessionId) => {
          if (createdTransport) transports.set(initializedSessionId, createdTransport);
        },
      });
      createdTransport = transport;
      transport.onclose = () => {
        if (createdTransport?.sessionId) transports.delete(createdTransport.sessionId);
      };
      await createAttentionMcpServer(domain, store).connect(transport);
    }

    return transport.handleRequest(request);
  };
}

function createAttentionMcpServer(domain: AttentionDomain, store: AttentionStore): McpServer {
  const server = new McpServer({ name: "attention-local", version: "0.1.0" });

  server.registerResource("feed_state", new ResourceTemplate("attention://feeds/{feedId}/state", { list: undefined }), { title: "Feed State" }, async (uri, variables) => {
    const feedId = String(variables.feedId);
    return { contents: [{ uri: uri.href, text: JSON.stringify(await store.readWorkspace(feedId), null, 2), mimeType: "application/json" }] };
  });

  server.registerResource("feed_setup", new ResourceTemplate("attention://feeds/{feedId}/setup", { list: undefined }), { title: "Feed Setup" }, async (uri, variables) => {
    const feedId = String(variables.feedId);
    return { contents: [{ uri: uri.href, text: JSON.stringify(await domain.inspectHowFeedWorks(feedId), null, 2), mimeType: "application/json" }] };
  });

  server.registerPrompt("run_feed", {
    title: "Run a feed queue",
    description: "Inspect, claim, and drain queued work before opportunistic source refresh.",
    argsSchema: { feedId: z.string(), threadId: z.string() },
  }, ({ feedId, threadId }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Deal with the local Attention feed ${feedId}. Use threadId ${threadId}. Inspect the feed and confirm this thread is bound. List queued work before using local connectors. If queued work exists, call claim_work first and only then use Gmail, Slack, GitHub, browser, file, or other local tools for that claimed instruction. Upsert cards only after the relevant claim is held, using the canonical card shape: id, title, why, and blocks with stable block ids/types. Verify approved external actions immediately before mutation, then complete, fail, block, retry, or cancel work through Attention MCP as appropriate. Refresh configured sources only after the queue is drained or when the claimed item explicitly asks for collection.`,
      },
    }],
  }));

  server.registerPrompt("setup_feed_runner", {
    title: "Set up feed runner",
    description: "Bind this thread and create a same-thread heartbeat that refreshes sources and drains queued work.",
    argsSchema: { feedId: z.string(), threadId: z.string(), cadence: z.string().optional() },
  }, ({ feedId, threadId, cadence }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Set up this Codex thread as the local runner for Attention feed ${feedId}. Use threadId ${threadId}. This thread should own exactly this feed; when connecting another feed, use a separate Codex thread and a separate same-thread heartbeat. Bind the feed with bind_feed_thread, inspect feed setup/state, and create or update one heartbeat automation on this same thread with cadence "${cadence || "every 30 minutes"}". The automation should confirm binding, list queued work first, claim a small batch before using any local connector for queued instructions, execute allowed claimed work, upsert cards only after the relevant claim is held, verify approved external mutations immediately before acting, and complete, fail, block, retry, or cancel work through Attention MCP as appropriate.`,
      },
    }],
  }));

  server.registerTool("inspect_feed", {
    title: "Inspect feed",
    description: "Read a feed's policy, source recipes, checkpoints, and thread binding.",
    inputSchema: { feedId: z.string() },
  }, ({ feedId }) => text(domain.inspectHowFeedWorks(feedId)));

  server.registerTool("bind_feed_thread", {
    title: "Bind feed thread",
    description: "Bind a feed to the local Codex thread that owns routine work.",
    inputSchema: { feedId: z.string(), threadId: z.string() },
  }, ({ feedId, threadId }) => text(domain.bindFeed(feedId, threadId)));

  server.registerTool("list_work", {
    title: "List work",
    description: "List queued and working items for a feed. Requires the owning thread id.",
    inputSchema: { feedId: z.string(), threadId: z.string(), crossFeed: z.boolean().optional() },
  }, ({ feedId, threadId, crossFeed }) => text(domain.listPendingWork(feedId, threadId, Boolean(crossFeed))));

  server.registerTool("claim_work", {
    title: "Claim work",
    description: "Claim the next queued work item for the owning Codex thread.",
    inputSchema: { feedId: z.string(), threadId: z.string(), crossFeed: z.boolean().optional() },
  }, ({ feedId, threadId, crossFeed }) => text(domain.claimWork(feedId, threadId, Boolean(crossFeed))));

  server.registerTool("verify_action", {
    title: "Verify approved action",
    description: "Reread and verify an approved action digest immediately before external mutation.",
    inputSchema: { feedId: z.string(), workId: z.string(), token: z.string(), mailbox: z.string().optional() },
  }, ({ feedId, workId, token, mailbox }) => text(domain.verifyApprovedAction(feedId, workId, token, mailbox)));

  server.registerTool("complete_work", {
    title: "Complete work",
    description: "Complete a claimed work item with the scoped capability token.",
    inputSchema: { feedId: z.string(), workId: z.string(), token: z.string(), result: jsonValue },
  }, ({ feedId, workId, token, result }) => text(domain.completeWork(feedId, workId, token, result as any)));

  server.registerTool("fail_work", {
    title: "Fail work",
    description: "Mark a claimed work item failed with the scoped capability token.",
    inputSchema: { feedId: z.string(), workId: z.string(), token: z.string(), error: z.string() },
  }, ({ feedId, workId, token, error }) => text(domain.failWork(feedId, workId, token, error)));

  server.registerTool("block_work", {
    title: "Block approved work",
    description: "Mark claimed approved action work as blocked while preserving approval for retry.",
    inputSchema: { feedId: z.string(), workId: z.string(), token: z.string(), error: z.string() },
  }, ({ feedId, workId, token, error }) => text(domain.blockApprovedWork(feedId, workId, token, error)));

  server.registerTool("retry_work", {
    title: "Retry approved work",
    description: "Requeue a blocked approved action work item after the user fixes the local issue.",
    inputSchema: { feedId: z.string(), workId: z.string() },
  }, ({ feedId, workId }) => text(domain.retryApprovedWork(feedId, workId)));

  server.registerTool("cancel_work", {
    title: "Cancel queued work",
    description: "Cancel a queued work item before Codex claims it.",
    inputSchema: { feedId: z.string(), workId: z.string(), reason: z.string().optional() },
  }, ({ feedId, workId, reason }) => text(domain.cancelQueuedWork(feedId, workId, reason)));

  server.registerTool("upsert_card", {
    title: "Upsert card",
    description: "Create or update a structured Attention card.",
    inputSchema: { feedId: z.string(), card: jsonValue },
  }, ({ feedId, card }) => text(domain.upsertCard(feedId, card as any)));

  server.registerTool("record_source_run", {
    title: "Record source run",
    description: "Record source evidence snapshots, judgments, and checkpoint for a completed collection run.",
    inputSchema: { feedId: z.string(), sourceId: z.string(), snapshots: z.array(jsonValue), judgments: z.array(jsonValue), checkpoint: jsonValue, workId: z.string().optional() },
  }, ({ feedId, sourceId, snapshots, judgments, checkpoint, workId }) => text(domain.recordSourceRun(feedId, sourceId, snapshots, judgments, checkpoint, workId)));

  server.registerTool("record_sweep_batch", {
    title: "Record sweep batch",
    description: "Record the current sweep batch from one or more source runs.",
    inputSchema: { feedId: z.string(), runIds: z.array(z.string()), workId: z.string().optional() },
  }, ({ feedId, runIds, workId }) => text(domain.recordSweepBatch(feedId, runIds, workId)));

  server.registerTool("record_sweep_rejudgment", {
    title: "Record sweep rejudgment",
    description: "Write back the result of claimed sweep feedback after Codex rejudges the sweep.",
    inputSchema: { feedId: z.string(), feedbackId: z.string(), orderedCardIds: z.array(z.string()), removedCardIds: z.array(z.string()) },
  }, ({ feedId, feedbackId, orderedCardIds, removedCardIds }) => text(domain.recordSweepRejudgment(feedId, feedbackId, orderedCardIds, removedCardIds)));

  server.registerTool("request_learning", {
    title: "Request learning pass",
    description: "Queue one compound learning pass for a feed.",
    inputSchema: { feedId: z.string() },
  }, ({ feedId }) => text(domain.queueCompound(feedId)));

  return server;
}
