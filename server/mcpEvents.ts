import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { effectiveWorkLane } from "../shared/lanes";
import type { WorkItem } from "../shared/types";
import type { AttentionStore } from "./store";
import { McpEventRepository, type EventSubscription } from "./repositories/mcpEvents";
import { callbackUrl, sendWebhook, signingKey, webhookHeaders, type WebhookSender } from "./mcpWebhook";

export const WORK_READY = "tend.work.ready";
const input = new AsyncLocalStorage<boolean>();
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(value);
export class McpFault extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}
export const workEventDefinition = {
  name: WORK_READY,
  description: "A deliberate user input queued work in an existing Tend feed. Read and claim the referenced work; delivery is not completion or permission to act externally.",
  delivery: ["webhook"],
  inputSchema: { type: "object", properties: { feed_id: { type: "string" }, thread_id: { type: "string" } }, required: ["feed_id", "thread_id"], additionalProperties: false },
  payloadSchema: { type: "object", properties: { feed_id: { type: "string" }, thread_id: { type: "string" }, work_id: { type: "string" }, work_revision: { type: "string" } },
    required: ["feed_id", "thread_id", "work_id", "work_revision"], additionalProperties: false },
};

export class TendMcpEvents {
  private polling = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  // Fence subscribe/refresh against unsubscribe while verification is in flight.
  private generations = new Map<string, number>();
  private verified = new Map<string, number>();
  constructor(readonly repository: McpEventRepository, readonly store: AttentionStore,
    private readonly sender: WebhookSender = sendWebhook, private readonly now = Date.now,
    private readonly enabled: () => boolean = () => true) {}

  userInput<T>(callback: () => Promise<T>): Promise<T> { return input.run(true, callback); }
  async authorized(feed: string, thread: string): Promise<boolean> {
    if (!this.enabled()) return false;
    try { return (await this.store.readThread(feed)).homeThreadId === thread; } catch { return false; }
  }
  private parse(params: any, secretRequired: boolean) {
    if (!params || params.name !== WORK_READY || !params.arguments || !identifier(params.arguments.feed_id) || !identifier(params.arguments.thread_id)
      || Object.keys(params.arguments).some(key => !["feed_id", "thread_id"].includes(key))
      || params.delivery?.mode !== "webhook" || typeof params.delivery.url !== "string" || params.cursor != null) throw new McpFault(-32602, "Invalid event subscription.");
    try { callbackUrl(params.delivery.url); if (secretRequired) signingKey(params.delivery.secret); }
    catch { throw new McpFault(-32602, "Invalid callback or signing secret."); }
    const feed = params.arguments.feed_id, thread = params.arguments.thread_id, url = params.delivery.url;
    const id = `sub_${createHash("sha256").update(JSON.stringify(["local-owner", WORK_READY, feed, thread, url])).digest("hex")}`;
    return { id, feed, thread, url };
  }
  async subscribe(params: any) {
    const identity = this.parse(params, true);
    if (!await this.authorized(identity.feed, identity.thread)) throw new McpFault(-32012, "Feed is not bound to this thread.");
    if (params.ttlMs !== undefined && params.ttlMs !== null && (!Number.isSafeInteger(params.ttlMs) || params.ttlMs <= 0)) throw new McpFault(-32602, "Invalid subscription lifetime.");
    // A feed has one conversation owner. Never deliver the same work to two callbacks.
    const conflict = this.repository.subscriptions().find(sub => sub.feed === identity.feed && sub.id !== identity.id && sub.expires > this.now());
    if (conflict) throw new McpFault(-32012, "Stop the existing feed subscription before changing its callback.");
    const generation = (this.generations.get(identity.id) ?? 0) + 1;
    this.generations.set(identity.id, generation);
    const challenge = randomUUID(), verificationId = `verify_${randomUUID()}`;
    const body = JSON.stringify({ type: "verification", challenge });
    const verificationKey = createHash("sha256").update(JSON.stringify([identity.url, params.delivery.secret])).digest("hex");
    for (const [key, until] of this.verified) if (until <= this.now()) this.verified.delete(key);
    let verified = (this.verified.get(verificationKey) ?? 0) > this.now();
    try { if (!verified) {
      const response = await this.sender(identity.url, webhookHeaders(verificationId, identity.id, body, [params.delivery.secret], this.now()), body);
      const echoed = JSON.parse(response.body).challenge;
      verified = response.status >= 200 && response.status < 300 && typeof echoed === "string"
        && Buffer.byteLength(echoed) === Buffer.byteLength(challenge) && timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge));
    } } catch { /* Do not disclose destination or secrets in protocol errors. */ }
    if (!verified) throw new McpFault(-32015, "Callback verification failed.", { reason: "challenge_failed" });
    if (this.generations.get(identity.id) !== generation || !await this.authorized(identity.feed, identity.thread)) throw new McpFault(-32012, "Subscription changed during verification.");
    if (this.repository.subscriptions().some(sub => sub.feed === identity.feed && sub.id !== identity.id && sub.expires > this.now())) throw new McpFault(-32012, "Feed callback changed during verification.");
    if (this.verified.size >= 100) this.verified.clear();
    this.verified.set(verificationKey, this.now() + 300_000);
    const old = this.repository.subscriptions().find(sub => sub.id === identity.id);
    const expires = this.now() + Math.min(params.ttlMs ?? 86_400_000, 86_400_000);
    this.repository.save({ ...identity, secret: params.delivery.secret, expires, generation: old?.generation ?? randomUUID(),
      ...(old && old.secret !== params.delivery.secret ? { previousSecret: old.secret, rotationUntil: this.now() + 300_000 } : {}),
    });
    return { id: identity.id, refreshBefore: new Date(expires).toISOString(), cursor: null, truncated: false };
  }
  async unsubscribe(params: any) {
    const identity = this.parse(params, false);
    // Owner-authenticated endpoint can revoke an obsolete binding, too.
    this.generations.set(identity.id, (this.generations.get(identity.id) ?? 0) + 1);
    this.repository.remove(identity.id);
    return {};
  }
  async enqueue(work: WorkItem) {
    if (!input.getStore() || !this.enabled()) return;
    const thread = await this.store.readThread(work.feedId);
    if (effectiveWorkLane(work, thread) !== "codex") return;
    for (const sub of this.repository.subscriptions()) {
      if (sub.feed !== work.feedId || sub.thread !== thread.homeThreadId || sub.expires <= this.now()) continue;
      const id = `evt_${createHash("sha256").update(JSON.stringify([sub.id,sub.generation,work.id,work.updatedAt])).digest("hex")}`;
      const body = JSON.stringify({ eventId: id, name: WORK_READY, timestamp: work.updatedAt,
        data: { feed_id: work.feedId, thread_id: sub.thread, work_id: work.id, work_revision: work.updatedAt }, cursor: null });
      this.repository.enqueue({ id, subscription: sub.id, generation: sub.generation, feed: work.feedId, work: work.id, revision: work.updatedAt, body });
    }
  }
  private async current(sub: EventSubscription) { return sub.expires > this.now() && await this.authorized(sub.feed, sub.thread); }
  async active(feed: string): Promise<boolean> {
    for (const sub of this.repository.subscriptions()) if (sub.feed === feed && await this.current(sub)) return true;
    return false;
  }
  async status(feed: string) {
    const pendingAccepted = [];
    for (const row of this.repository.accepted(feed)) {
      if (row.feed !== feed) continue;
      const sub = this.repository.subscriptions().find(sub => sub.id === row.subscription && sub.generation === row.generation);
      if (!sub || !await this.current(sub)) continue;
      const work = await this.store.readWork(row.feed,row.work).catch(() => null);
      if (work?.status !== "queued" || work.updatedAt !== row.revision) continue;
      pendingAccepted.push({ eventId: row.id, ...JSON.parse(row.body).data });
      if (pendingAccepted.length === 5) break;
    }
    return { subscribed: await this.active(feed), pendingAccepted };
  }
  async reference(eventId: string, feed: string, thread: string) {
    const row = this.repository.get(eventId);
    const sub = row && this.repository.subscriptions().find(sub => sub.id === row.subscription && sub.generation === row.generation);
    if (!row || !sub || row.status !== "accepted" || row.feed !== feed || sub.thread !== thread || !await this.current(sub)) throw new McpFault(-32012, "No current accepted event reference.");
    return row;
  }
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const row of this.repository.due(this.now())) {
        const sub = this.repository.subscriptions().find(sub => sub.id === row.subscription && sub.generation === row.generation);
        const work = await this.store.readWork(row.feed,row.work).catch(() => null);
        if (!sub || !await this.current(sub) || work?.status !== "queued" || work.updatedAt !== row.revision) {
          this.repository.settle(row.id,"stopped",row.attempts); continue;
        }
        const attempts = row.attempts + 1;
        // Persist the attempt before networking: interruption retries the same event ID.
        this.repository.settle(row.id,"pending",attempts,this.now()+30_000);
        let status = 0;
        try {
          const secrets = [sub.secret];
          if (sub.previousSecret && (sub.rotationUntil ?? 0) > this.now()) secrets.push(sub.previousSecret);
          status = (await this.sender(sub.url,webhookHeaders(row.id,sub.id,row.body,secrets,this.now()),row.body)).status;
        } catch { /* Network failure uses bounded retry. */ }
        const current = this.repository.subscriptions().find(item => item.id === sub.id && item.generation === sub.generation);
        if (!current || !await this.current(current)) { this.repository.settle(row.id,"stopped",attempts); continue; }
        if (status >= 200 && status < 300) this.repository.settle(row.id,"accepted",attempts);
        else if (status === 410) { this.repository.remove(sub.id); this.repository.settle(row.id,"stopped",attempts); }
        else if (status === 413 || (status >= 400 && status < 500 && status !== 408 && status !== 429) || attempts >= 8) this.repository.settle(row.id,"blocked",attempts);
        else this.repository.settle(row.id,"pending",attempts,this.now()+Math.min(1_000*2**attempts,300_000));
      }
    } finally { this.polling = false; }
  }
  start() { if (!this.timer) { this.timer = setInterval(() => void this.poll().catch(() => {}),1_000); void this.poll().catch(() => {}); } }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
