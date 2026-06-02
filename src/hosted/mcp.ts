import { createMcpHandler } from "agents/mcp";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HostedEnv, HostedSession } from "./env";
import { callAccount, callFeed } from "./identity";

const cardBlockItemSchema = z.union([
  z.string(),
  z.object({
    label: z.string(),
    detail: z.string().optional(),
    checked: z.boolean().optional(),
  }).strict(),
]);

const cardBlockSchema = z.object({
  id: z.string(),
  type: z.enum(["rich_text", "evidence", "editable_text", "memo", "options", "checklist", "diff", "clarification", "email_thread", "profile", "receipt"]),
  label: z.string().optional(),
  title: z.string().optional(),
  text: z.string().optional(),
  value: z.string().optional(),
  items: z.array(cardBlockItemSchema).optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  editable: z.boolean().optional(),
  profile: z.object({
    name: z.string(),
    subtitle: z.string().optional(),
    href: z.string(),
    imageUrl: z.string(),
    fallbackImageUrl: z.string().optional(),
    links: z.array(z.object({ label: z.string(), href: z.string() }).strict()).optional(),
  }).strict().optional(),
}).strict();

const proposedActionSchema = z.object({
  label: z.string(),
  instruction: z.string(),
  artifactBlockId: z.string().optional(),
  externalMutation: z.boolean().optional(),
  mailboxPolicy: z.enum(["reply_from_source"]).optional(),
}).strict();

const cardActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  behavior: z.enum(["queue_instruction", "approve_action", "default_cleanup"]),
  instruction: z.string().optional(),
  artifactBlockId: z.string().optional(),
  externalMutation: z.boolean().optional(),
  mailboxPolicy: z.enum(["reply_from_source"]).optional(),
  variant: z.enum(["primary", "secondary"]).optional(),
  shortcut: z.string().optional(),
}).strict();

const cardInputSchema = z.object({
  id: z.string(),
  kind: z.enum(["attention", "feed_improvement"]).optional(),
  status: z.enum(["to_review_new", "to_review_updated", "queued", "working", "approved_blocked", "done"]).optional(),
  eyebrow: z.string().optional(),
  title: z.string(),
  why: z.string(),
  sourceMailbox: z.string().optional(),
  blocks: z.array(cardBlockSchema),
  proposedAction: proposedActionSchema.optional(),
  actions: z.array(cardActionSchema).optional(),
  routineActionGroupId: z.string().optional(),
  sweep: z.object({
    rank: z.number().int(),
    hidden: z.boolean(),
    feedbackId: z.string(),
  }).strict().optional(),
  readyForPass: z.number().int().optional(),
  completedAt: z.string().optional(),
}).strict();

const completeWorkResultSchema = z.object({
  response: z.string(),
  blocks: z.array(cardBlockSchema).optional(),
  proposedAction: proposedActionSchema.optional(),
  actions: z.array(cardActionSchema).optional(),
  done: z.boolean().optional(),
}).strict();

const voiceTargetSchema = z.union([
  z.object({ kind: z.literal("card"), feedId: z.string(), cardId: z.string() }).strict(),
  z.object({ kind: z.literal("sweep"), feedId: z.string(), batchId: z.string().optional() }).strict(),
  z.object({ kind: z.literal("feed"), feedId: z.string() }).strict(),
  z.object({ kind: z.literal("source_recipe"), feedId: z.string(), sourceId: z.string() }).strict(),
  z.object({ kind: z.literal("prompt_layer"), feedId: z.string(), promptId: z.string() }).strict(),
  z.object({ kind: z.literal("global_prompt"), promptId: z.string() }).strict(),
  z.object({ kind: z.literal("attention") }).strict(),
]);

const routineActionGroupSchema = z.object({
  id: z.string(),
  label: z.string(),
  summary: z.string(),
  proposedAction: proposedActionSchema,
  items: z.array(z.object({
    id: z.string(),
    cardId: z.string().optional(),
    title: z.string(),
    detail: z.string().optional(),
    reason: z.string(),
    sourceRefs: z.array(z.object({ label: z.string(), href: z.string() }).strict()).optional(),
  }).strict()),
}).strict();

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
        text: `Deal with the Attention feed ${feedId}. Use threadId ${threadId}. Inspect the feed and confirm this thread is bound. List queued work for this thread before using local connectors. If queued work exists, call claim_work first and only then use Gmail, Slack, GitHub, browser, file, or other local tools for that claimed instruction. Upsert cards only after the relevant claim is held, using the canonical card shape: id, title, why, and blocks with stable block ids/types. When a claimed instruction closes, ignores, dismisses, or confirms an item is already handled, update the card to status "done" and include response plus done: true in complete_work. Complete or fail each claimed item with the scoped token and evidence, verifying approved external actions immediately before mutation, and repeat until claim_work returns null or the small-batch limit is reached. Only after the queue is drained, or when the claimed item explicitly asks for source collection, refresh configured source recipes opportunistically and upsert useful cards with provenance in blocks.`,
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
        text: `Set up this Codex thread as the local runner for Attention feed ${feedId}. Use threadId ${threadId}. Bind the feed with bind_feed_thread, inspect the feed setup/state, and create or update one heartbeat automation on this same thread with cadence "${cadence || "every 30 minutes"}". The automation should confirm binding, list queued work first, claim a small batch before using any local connector for queued instructions, execute allowed claimed work, upsert cards only after the relevant claim is held, and use the canonical card shape: id, title, why, and blocks with stable block ids/types. It should verify approved external mutations immediately before acting and complete or fail each claim with a response and evidence. For close/ignore/already-handled instructions, it should update the card to status "done" and include response plus done: true in complete_work. When no queued work is being handled, it may refresh configured sources with local connectors and upsert only useful cards with provenance in blocks. Do not create a second runner thread unless the user explicitly asks.`,
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
    inputSchema: { feedId: z.string(), workId: z.string(), token: z.string(), mailbox: z.string().optional() },
  }, async ({ feedId, workId, token, mailbox }) => text(await callFeed(env, session, feedId, `/work/${encodeURIComponent(workId)}/verify`, { method: "POST", body: JSON.stringify({ token, mailbox }) })));

  server.registerTool("complete_work", {
    title: "Complete work",
    description: "Complete a claimed work item with the scoped capability token.",
    inputSchema: { feedId: z.string(), workId: z.string(), token: z.string(), result: completeWorkResultSchema },
  }, async ({ feedId, workId, token, result }) => text(await callFeed(env, session, feedId, `/work/${encodeURIComponent(workId)}/complete`, { method: "POST", body: JSON.stringify({ token, result }) })));

  server.registerTool("fail_work", {
    title: "Fail work",
    description: "Mark a claimed work item failed with the scoped capability token.",
    inputSchema: { feedId: z.string(), workId: z.string(), token: z.string(), error: z.string() },
  }, async ({ feedId, workId, token, error }) => text(await callFeed(env, session, feedId, `/work/${encodeURIComponent(workId)}/fail`, { method: "POST", body: JSON.stringify({ token, error }) })));

  server.registerTool("block_work", {
    title: "Block approved work",
    description: "Mark claimed approved action work as blocked while preserving approval for retry.",
    inputSchema: { feedId: z.string(), workId: z.string(), token: z.string(), error: z.string() },
  }, async ({ feedId, workId, token, error }) => text(await callFeed(env, session, feedId, `/work/${encodeURIComponent(workId)}/block`, { method: "POST", body: JSON.stringify({ token, error }) })));

  server.registerTool("retry_work", {
    title: "Retry approved work",
    description: "Requeue a blocked approved action work item after the user fixes the local issue.",
    inputSchema: { feedId: z.string(), workId: z.string() },
  }, async ({ feedId, workId }) => text(await callFeed(env, session, feedId, `/work/${encodeURIComponent(workId)}/retry`, { method: "POST" })));

  server.registerTool("cancel_work", {
    title: "Cancel queued work",
    description: "Cancel a queued work item before Codex claims it.",
    inputSchema: { feedId: z.string(), workId: z.string(), reason: z.string().optional() },
  }, async ({ feedId, workId, reason }) => text(await callFeed(env, session, feedId, `/work/${encodeURIComponent(workId)}/cancel`, { method: "POST", body: JSON.stringify({ reason }) })));

  server.registerTool("upsert_card", {
    title: "Upsert card",
    description: "Create or update a structured Attention card. Required card fields match the local implementation: id, title, why, and blocks.",
    inputSchema: { feedId: z.string(), card: cardInputSchema },
  }, async ({ feedId, card }) => text(await callFeed(env, session, feedId, "/card", { method: "POST", body: JSON.stringify({ card }) })));

  server.registerTool("record_source_run", {
    title: "Record source run",
    description: "Record source evidence snapshots, judgments, and checkpoint for a completed collection run.",
    inputSchema: { feedId: z.string(), sourceId: z.string(), snapshots: z.array(z.unknown()), judgments: z.array(z.unknown()), checkpoint: z.unknown(), workId: z.string().optional() },
  }, async ({ feedId, sourceId, snapshots, judgments, checkpoint, workId }) => text(await callFeed(env, session, feedId, "/record-run", { method: "POST", body: JSON.stringify({ sourceId, snapshots, judgments, checkpoint, workId }) })));

  server.registerTool("record_sweep_batch", {
    title: "Record sweep batch",
    description: "Record the current sweep batch from one or more source runs.",
    inputSchema: { feedId: z.string(), runIds: z.array(z.string()), workId: z.string().optional() },
  }, async ({ feedId, runIds, workId }) => text(await callFeed(env, session, feedId, "/record-sweep-batch", { method: "POST", body: JSON.stringify({ runIds, workId }) })));

  server.registerTool("record_sweep_rejudgment", {
    title: "Record sweep rejudgment",
    description: "Write back the ordered and removed card ids after claimed sweep feedback work.",
    inputSchema: { feedId: z.string(), feedbackId: z.string(), orderedCardIds: z.array(z.string()), removedCardIds: z.array(z.string()) },
  }, async ({ feedId, feedbackId, orderedCardIds, removedCardIds }) => text(await callFeed(env, session, feedId, "/record-sweep-rejudgment", { method: "POST", body: JSON.stringify({ feedbackId, orderedCardIds, removedCardIds }) })));

  server.registerTool("upsert_routine_action_group", {
    title: "Upsert routine action group",
    description: "Create or update a user-reviewable batch of routine actions.",
    inputSchema: { feedId: z.string(), group: routineActionGroupSchema },
  }, async ({ feedId, group }) => text(await callFeed(env, session, feedId, "/routine-actions", { method: "POST", body: JSON.stringify({ group }) })));

  server.registerTool("approve_routine_action_group", {
    title: "Approve routine action group",
    description: "Queue a proposed routine action batch after user approval.",
    inputSchema: { feedId: z.string(), groupId: z.string() },
  }, async ({ feedId, groupId }) => text(await callFeed(env, session, feedId, `/routine-actions/${encodeURIComponent(groupId)}/approve`, { method: "POST" })));

  server.registerTool("propose_revision", {
    title: "Propose revision",
    description: "Create an editable revision proposal for feed policy, source recipe, or prompt content.",
    inputSchema: { feedId: z.string(), target: voiceTargetSchema, instruction: z.string(), content: z.string(), source: z.enum(["voice", "compound"]).optional() },
  }, async ({ feedId, target, instruction, content, source }) => {
    if (target.kind === "attention" || target.kind === "global_prompt") {
      return text(await callAccount(env, session, "/revision-proposals", { method: "POST", body: JSON.stringify({ feedId, target, instruction, content, source }) }));
    }
    return text(await callFeed(env, session, feedId, "/revision-proposals", { method: "POST", body: JSON.stringify({ target, instruction, content, source }) }));
  });

  server.registerTool("update_revision", {
    title: "Update revision proposal",
    description: "Update the content of a pending revision proposal.",
    inputSchema: { feedId: z.string(), proposalId: z.string(), content: z.string() },
  }, async ({ feedId, proposalId, content }) => text(await callFeed(env, session, feedId, `/revision-proposals/${encodeURIComponent(proposalId)}`, { method: "POST", body: JSON.stringify({ content }) })));

  server.registerTool("request_learning", {
    title: "Request learning pass",
    description: "Queue a compound-learning pass for the feed.",
    inputSchema: { feedId: z.string() },
  }, async ({ feedId }) => text(await callFeed(env, session, feedId, "/compound", { method: "POST" })));

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
