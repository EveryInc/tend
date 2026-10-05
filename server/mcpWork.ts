import type { AttentionDomain } from "./domain";
import type { AttentionStore } from "./store";
import { McpFault, type TendMcpEvents } from "./mcpEvents";
import { tokensMatch, type Notify } from "./routes/shared";

const scope = { feed_id: { type: "string" }, thread_id: { type: "string" } };
const reference = { ...scope, event_id: { type: "string" }, work_id: { type: "string" }, work_revision: { type: "string" } };
const schema = (properties: object, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
export const mcpWorkTools = [
  { name: "tend_event_status", description: "Read accepted events still awaiting work in the bound feed. Delivery does not prove this conversation received or completed them.", inputSchema: schema(scope, Object.keys(scope)), annotations: { readOnlyHint: true } },
  { name: "tend_work_claim", description: "Claim exactly the work referenced by an accepted event. Repeating the same claim returns the existing claim. Read feed policy and work before acting; external actions require the existing Tend approval and verification workflow.", inputSchema: schema(reference, Object.keys(reference)), annotations: { readOnlyHint: false, idempotentHint: true } },
  { name: "tend_work_respond", description: "Record a response for ordinary instruction work in the existing Tend UI. Cannot certify external actions, recollection, or other specialized work; those retain the existing scoped CLI workflow.", inputSchema: schema({ ...reference, capability_token: { type: "string" }, response: { type: "string" } }, [...Object.keys(reference), "capability_token", "response"]), annotations: { readOnlyHint: false, idempotentHint: true } },
];

export class TendMcpWork {
  constructor(private readonly context: { domain: AttentionDomain; store: AttentionStore; events: TendMcpEvents; notify: Notify }) {}
  async call(params: any): Promise<unknown> {
    const tool = mcpWorkTools.find(item => item.name === params.name), args = params.arguments;
    if (!tool || !args || typeof args !== "object" || Array.isArray(args)
      || tool.inputSchema.required.some(key => typeof args[key] !== "string" || !args[key].trim())
      || Object.keys(args).some(key => !(key in tool.inputSchema.properties))) throw new McpFault(-32602, "Invalid tool arguments.");
    if (!await this.context.events.authorized(args.feed_id, args.thread_id)) throw new McpFault(-32012, "Feed is not bound to this thread.");
    let output: unknown;
    if (params.name === "tend_event_status") output = await this.context.events.status(args.feed_id);
    else {
      const event = await this.context.events.reference(args.event_id, args.feed_id, args.thread_id);
      if (event.work !== args.work_id || event.revision !== args.work_revision) throw new McpFault(-32012, "Work reference does not match the event.");
      const work = await this.context.store.readWork(args.feed_id, args.work_id);
      if (params.name === "tend_work_claim") {
        if (work.status === "queued" && work.updatedAt !== event.revision) throw new McpFault(-32012, "Work changed after delivery.");
        if (work.status === "completed") output = { work_id: work.id, status: work.status, response: work.response };
        else if (!["queued", "working"].includes(work.status)) throw new McpFault(-32012, "Work is no longer claimable.");
        else {
          const claimed = await this.context.domain.claimWork(args.feed_id, args.thread_id, false, undefined, args.work_id, event.revision);
          this.context.notify({ changedAt: new Date().toISOString() });
          output = { work: claimed, feed: await this.context.store.readConfig(args.feed_id), policy: await this.context.store.readTargetContent({ kind: "feed", feedId: args.feed_id }),
            card: work.cardId.startsWith("__") ? null : await this.context.store.readCard(args.feed_id, work.cardId) };
        }
      } else {
        if (!["instruction", "scoped_instruction"].includes(work.kind) || (work.intent && work.intent !== "voice_instruction") || work.approvalDigest) throw new McpFault(-32012, "Use the existing scoped workflow for this work kind.");
        if (work.claimedBy?.threadId !== args.thread_id || work.claimedBy?.agent !== "codex" || !tokensMatch(args.capability_token, work.capabilityToken ?? "")) throw new McpFault(-32012, "Invalid scoped claim.");
        if (work.status === "completed") {
          if (work.response !== args.response.trim()) throw new McpFault(-32012, "Work already has a different response.");
        } else await this.context.domain.completeWork(args.feed_id, args.work_id, args.capability_token, { response: args.response });
        this.context.notify({ changedAt: new Date().toISOString() });
        output = { work_id: work.id, status: "completed", response: args.response.trim() };
      }
    }
    return output;
  }
}
