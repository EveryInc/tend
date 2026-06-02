import { DurableObject } from "cloudflare:workers";
import type { FeedEvent } from "../../types";
import type { FeedState, HostedEnv } from "../env";
import { errorResponse, isoNow, json, jsonBody, makeId, notFound } from "../util";
import { FeedService } from "../services/feed-service";
import { defaultFeedState, feedView, inspectFeed } from "../services/feed-state-service";

export class FeedDO extends DurableObject<HostedEnv> {
  private initialized = false;

  constructor(ctx: DurableObjectState, env: HostedEnv) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/events/ws") return this.websocket();
      if (request.method === "POST" && url.pathname === "/replace-state") return this.replaceState((await jsonBody(request)).state as FeedState);
      await this.ensure(request.headers.get("x-attention-feed-id") || url.searchParams.get("feedId") || "inbox");
      if (request.method === "GET" && url.pathname === "/state") return json(feedView(await this.state()));
      if (request.method === "GET" && url.pathname === "/how") return json(inspectFeed(await this.state()));
      return this.mutateOrRead(request, url);
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async mutateOrRead(request: Request, url: URL): Promise<Response> {
    const body = request.method === "POST" ? await jsonBody(request) : {};
    const state = await this.state();
    const service = new FeedService(state);

    if (request.method === "POST" && url.pathname === "/bind") return json(await this.commit(service.bind(String(body.threadId ?? ""))));
    if (request.method === "POST" && url.pathname === "/heartbeat") return json(await this.commit(service.proposeHeartbeat(String(body.cadence ?? ""))));
    if (request.method === "POST" && url.pathname === "/policy") return json(await this.commit(service.applyPolicy(String(body.content ?? ""), "Edited in the feed workspace.", "user_instruction")));
    if (request.method === "POST" && url.pathname === "/sources") return json(await this.commit(service.addSource(String(body.brief ?? ""))));
    if (request.method === "POST" && url.pathname === "/instructions") return json(await this.commit(service.queueFeedInstruction(String(body.instruction ?? ""))));
    if (request.method === "POST" && url.pathname === "/next-pass") return json(await this.commit(service.beginNextPass()));
    if (request.method === "POST" && url.pathname === "/compound") return json(await this.commit(service.queueCompound()));
    if (request.method === "POST" && url.pathname === "/record-run") return json(await this.commit(service.recordSourceRun(String(body.sourceId ?? ""), (body.snapshots ?? []) as unknown[], (body.judgments ?? []) as unknown[], body.checkpoint)));
    if (request.method === "POST" && url.pathname === "/card") return json(await this.commit(service.upsertCard(body.card as any)));
    if (request.method === "GET" && url.pathname === "/work") return json(service.listWork(url.searchParams.get("threadId") ?? "", url.searchParams.get("crossFeed") === "true"));
    if (request.method === "POST" && url.pathname === "/work/claim") return json(await this.commit(service.claimWork(String(body.threadId ?? ""), Boolean(body.crossFeed))));

    const sourceMatch = url.pathname.match(/^\/sources\/([^/]+)$/);
    if (request.method === "POST" && sourceMatch) return json(await this.commit(service.updateSource(decodeURIComponent(sourceMatch[1]), String(body.content ?? ""))));
    const cardInstructionMatch = url.pathname.match(/^\/cards\/([^/]+)\/instructions$/);
    if (request.method === "POST" && cardInstructionMatch) return json(await this.commit(service.queueInstruction(decodeURIComponent(cardInstructionMatch[1]), String(body.instruction ?? ""))));
    const approveMatch = url.pathname.match(/^\/cards\/([^/]+)\/approve$/);
    if (request.method === "POST" && approveMatch) return json(await this.commit(service.approveAction(decodeURIComponent(approveMatch[1]))));
    const dismissMatch = url.pathname.match(/^\/cards\/([^/]+)\/dismiss$/);
    if (request.method === "POST" && dismissMatch) return json(await this.commit(service.dismissCard(decodeURIComponent(dismissMatch[1]))));
    const undoMatch = url.pathname.match(/^\/cards\/([^/]+)\/undo-dismiss$/);
    if (request.method === "POST" && undoMatch) return json(await this.commit(service.undoDismiss(decodeURIComponent(undoMatch[1]))));
    const blockMatch = url.pathname.match(/^\/cards\/([^/]+)\/blocks\/([^/]+)$/);
    if (request.method === "POST" && blockMatch) return json(await this.commit(service.updateBlock(decodeURIComponent(blockMatch[1]), decodeURIComponent(blockMatch[2]), String(body.value ?? ""))));
    const cancelMatch = url.pathname.match(/^\/work\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) return json(await this.commit(service.cancelQueuedWork(decodeURIComponent(cancelMatch[1]), String(body.reason ?? "Cancelled from the browser before Codex started work."))));
    const completeMatch = url.pathname.match(/^\/work\/([^/]+)\/complete$/);
    if (request.method === "POST" && completeMatch) return json(await this.commit(service.completeWork(decodeURIComponent(completeMatch[1]), String(body.token ?? ""), body.result as any)));
    const failMatch = url.pathname.match(/^\/work\/([^/]+)\/fail$/);
    if (request.method === "POST" && failMatch) return json(await this.commit(service.failWork(decodeURIComponent(failMatch[1]), String(body.token ?? ""), String(body.error ?? ""))));
    const verifyMatch = url.pathname.match(/^\/work\/([^/]+)\/verify$/);
    if (request.method === "POST" && verifyMatch) return json(service.verifyApprovedAction(decodeURIComponent(verifyMatch[1]), String(body.token ?? "")));
    return notFound();
  }

  private async commit<T>(mutation: { state: FeedState; result: T; event?: Omit<FeedEvent, "id" | "at"> }): Promise<T> {
    mutation.state.updatedAt = isoNow();
    if (mutation.event) mutation.state.events.push({ ...mutation.event, id: makeId("evt"), at: isoNow() });
    await this.ctx.storage.put("state", mutation.state);
    this.broadcast({ changedAt: mutation.state.updatedAt, event: mutation.event });
    return mutation.result;
  }

  private async replaceState(state: FeedState): Promise<Response> {
    await this.ctx.storage.put("state", state);
    this.broadcast({ changedAt: state.updatedAt });
    return json(feedView(state));
  }

  private async ensure(feedId: string): Promise<void> {
    if (this.initialized) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      const existing = await this.ctx.storage.get<FeedState>("state");
      if (!existing) await this.ctx.storage.put("state", defaultFeedState(feedId));
      this.initialized = true;
    });
  }

  private async state(): Promise<FeedState> {
    await this.ensure("inbox");
    return (await this.ctx.storage.get<FeedState>("state"))!;
  }

  private websocket(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ event: "ready" }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcast(value: unknown): void {
    const message = JSON.stringify(value);
    for (const socket of this.ctx.getWebSockets()) socket.send(message);
  }
}
