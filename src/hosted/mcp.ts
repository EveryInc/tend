import { createMcpHandler } from "agents/mcp";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HostedEnv, HostedSession } from "./env";
import { callAccount, callFeed } from "./identity";

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

export function createAttentionMcpServer(env: HostedEnv, session: HostedSession): McpServer {
  const server = new McpServer({ name: "attention", version: "0.1.0-hosted" });

  server.registerResource("global_policy", "attention://global/policy", { title: "Global Attention Policy" }, async (uri) => {
    const workspace = await callAccount<{ globalPolicy: string }>(env, session, "/global-prompts");
    return { contents: [{ uri: uri.href, text: workspace.globalPolicy, mimeType: "text/markdown" }] };
  });

  server.registerResource("feed_state", new ResourceTemplate("attention://feeds/{feedId}/state", { list: undefined }), { title: "Feed State" }, async (uri, variables) => {
    const feedId = String(variables.feedId);
    const state = await callFeed(env, session, feedId, "/state");
    return { contents: [{ uri: uri.href, text: JSON.stringify(state, null, 2), mimeType: "application/json" }] };
  });

  server.registerResource("feed_setup", new ResourceTemplate("attention://feeds/{feedId}/setup", { list: undefined }), { title: "Feed Setup" }, async (uri, variables) => {
    const feedId = String(variables.feedId);
    const setup = await callFeed(env, session, feedId, "/how");
    return { contents: [{ uri: uri.href, text: JSON.stringify(setup, null, 2), mimeType: "application/json" }] };
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
        text: `Deal with the Attention feed ${feedId}. Use threadId ${threadId}. Inspect the feed and confirm this thread is bound. List queued work for this thread before using local connectors. If queued work exists, call claim_work first and only then use Gmail, Slack, GitHub, browser, file, or other local tools for that claimed instruction. Upsert result cards or update cards only after the relevant claim is held, preserving provenance. When a claimed instruction closes, ignores, dismisses, or confirms an item is already handled, update the card to done and include done: true in complete_work. Complete or fail each claimed item with the scoped token and evidence, verifying approved external actions immediately before mutation, and repeat until claim_work returns null or the small-batch limit is reached. Only after the queue is drained, or when the claimed item explicitly asks for source collection, refresh configured source recipes opportunistically and upsert useful cards with provenance.`,
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
        text: `Set up this Codex thread as the local runner for Attention feed ${feedId}. Use threadId ${threadId}. Bind the feed with bind_feed_thread, inspect the feed setup/state, and create or update one heartbeat automation on this same thread with cadence "${cadence || "every 30 minutes"}". The automation should confirm binding, list queued work first, claim a small batch before using any local connector for queued instructions, execute allowed claimed work, upsert result cards only after the relevant claim is held, verify approved external mutations immediately before acting, and complete or fail each claim with evidence. For close/ignore/already-handled instructions, it should update the card to done and include done: true in complete_work. When no queued work is being handled, it may refresh configured sources with local connectors and upsert only useful cards with provenance. Do not create a second runner thread unless the user explicitly asks.`,
      },
    }],
  }));

  server.registerTool("inspect_feed", {
    title: "Inspect feed",
    description: "Read a feed's policy, source recipes, checkpoints, and thread binding.",
    inputSchema: { feedId: z.string(), threadId: z.string().optional() },
  }, async ({ feedId }) => text(await callFeed(env, session, feedId, "/how")));

  server.registerTool("bind_feed_thread", {
    title: "Bind feed thread",
    description: "Bind a feed to the local Codex thread that owns routine work.",
    inputSchema: { feedId: z.string(), threadId: z.string() },
  }, async ({ feedId, threadId }) => text(await callFeed(env, session, feedId, "/bind", { method: "POST", body: JSON.stringify({ threadId }) })));

  server.registerTool("list_work", {
    title: "List work",
    description: "List queued and working items for a feed. Requires the owning thread id.",
    inputSchema: { feedId: z.string(), threadId: z.string(), crossFeed: z.boolean().optional() },
  }, async ({ feedId, threadId, crossFeed }) => text(await callFeed(env, session, feedId, `/work?threadId=${encodeURIComponent(threadId)}&crossFeed=${crossFeed ? "true" : "false"}`)));

  server.registerTool("claim_work", {
    title: "Claim work",
    description: "Claim the next queued work item for the owning Codex thread.",
    inputSchema: { feedId: z.string(), threadId: z.string(), crossFeed: z.boolean().optional() },
  }, async ({ feedId, threadId, crossFeed }) => text(await callFeed(env, session, feedId, "/work/claim", { method: "POST", body: JSON.stringify({ threadId, crossFeed }) })));

  server.registerTool("verify_action", {
    title: "Verify approved action",
    description: "Reread and verify an approved action digest immediately before external mutation.",
    inputSchema: { feedId: z.string(), workId: z.string(), token: z.string() },
  }, async ({ feedId, workId, token }) => text(await callFeed(env, session, feedId, `/work/${encodeURIComponent(workId)}/verify`, { method: "POST", body: JSON.stringify({ token }) })));

  server.registerTool("complete_work", {
    title: "Complete work",
    description: "Complete a claimed work item with the scoped capability token.",
    inputSchema: { feedId: z.string(), workId: z.string(), token: z.string(), result: z.record(z.string(), z.unknown()) },
  }, async ({ feedId, workId, token, result }) => text(await callFeed(env, session, feedId, `/work/${encodeURIComponent(workId)}/complete`, { method: "POST", body: JSON.stringify({ token, result }) })));

  server.registerTool("fail_work", {
    title: "Fail work",
    description: "Mark a claimed work item failed with the scoped capability token.",
    inputSchema: { feedId: z.string(), workId: z.string(), token: z.string(), error: z.string() },
  }, async ({ feedId, workId, token, error }) => text(await callFeed(env, session, feedId, `/work/${encodeURIComponent(workId)}/fail`, { method: "POST", body: JSON.stringify({ token, error }) })));

  server.registerTool("upsert_card", {
    title: "Upsert card",
    description: "Create or update a structured Attention card for a feed.",
    inputSchema: { feedId: z.string(), card: z.record(z.string(), z.unknown()) },
  }, async ({ feedId, card }) => text(await callFeed(env, session, feedId, "/card", { method: "POST", body: JSON.stringify({ card }) })));

  server.registerTool("record_source_run", {
    title: "Record source run",
    description: "Record source evidence snapshots, judgments, and checkpoint for a completed collection run.",
    inputSchema: { feedId: z.string(), sourceId: z.string(), snapshots: z.array(z.unknown()), judgments: z.array(z.unknown()), checkpoint: z.unknown() },
  }, async ({ feedId, sourceId, snapshots, judgments, checkpoint }) => text(await callFeed(env, session, feedId, "/record-run", { method: "POST", body: JSON.stringify({ sourceId, snapshots, judgments, checkpoint }) })));

  server.registerTool("update_feed_policy", {
    title: "Update feed policy",
    description: "Apply a feed-specific policy revision.",
    inputSchema: { feedId: z.string(), content: z.string() },
  }, async ({ feedId, content }) => text(await callFeed(env, session, feedId, "/policy", { method: "POST", body: JSON.stringify({ content }) })));

  server.registerTool("add_source_recipe", {
    title: "Add source recipe",
    description: "Add a source recipe from a plain-English brief.",
    inputSchema: { feedId: z.string(), brief: z.string() },
  }, async ({ feedId, brief }) => text(await callFeed(env, session, feedId, "/sources", { method: "POST", body: JSON.stringify({ brief }) })));

  server.registerTool("update_source_recipe", {
    title: "Update source recipe",
    description: "Update an existing feed source recipe.",
    inputSchema: { feedId: z.string(), sourceId: z.string(), content: z.string() },
  }, async ({ feedId, sourceId, content }) => text(await callFeed(env, session, feedId, `/sources/${encodeURIComponent(sourceId)}`, { method: "POST", body: JSON.stringify({ content }) })));

  server.registerTool("update_global_policy", {
    title: "Update global policy",
    description: "Update the account-level global attention policy.",
    inputSchema: { content: z.string() },
  }, async ({ content }) => text(await callAccount(env, session, "/global-policy", { method: "POST", body: JSON.stringify({ content }) })));

  server.registerTool("update_prompt_layer", {
    title: "Update prompt layer",
    description: "Update an allowlisted global prompt layer.",
    inputSchema: { name: z.string(), content: z.string() },
  }, async ({ name, content }) => text(await callAccount(env, session, `/global-prompts/${encodeURIComponent(name)}`, { method: "POST", body: JSON.stringify({ content }) })));

  return server;
}

export function mcpResponse(request: Request, env: HostedEnv, ctx: ExecutionContext, session: HostedSession): Promise<Response> {
  const server = createAttentionMcpServer(env, session);
  return createMcpHandler(server, { route: "/mcp", authContext: { props: { userId: session.userId, accountId: session.accountId } } })(request, env, ctx);
}
