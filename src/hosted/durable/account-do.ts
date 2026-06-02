import { DurableObject } from "cloudflare:workers";
import type { FeedView } from "../../types";
import type { AccountWorkspaceState, HostedEnv } from "../env";
import { errorResponse, json, jsonBody, notFound } from "../util";
import { createFeedFromBrief, defaultAccountState, globalPromptWorkspace, removeFeed, updateGlobalPolicy, updateGlobalPrompt, workspaceFromFeeds } from "../services/account-service";
import { createCustomFeedState, feedView } from "../services/feed-state-service";
import { archiveFeed as archiveFeedRef, registerFeed } from "../services/control-plane-service";

export class AccountDO extends DurableObject<HostedEnv> {
  private initialized = false;

  constructor(ctx: DurableObjectState, env: HostedEnv) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      await this.ensure(request.headers.get("x-attention-account-id") || url.searchParams.get("accountId") || "demo-account");
      if (request.method === "GET" && url.pathname === "/workspace") return json(await this.workspace(url.searchParams.get("feed") ?? "inbox"));
      if (request.method === "GET" && url.pathname === "/global-prompts") return json(globalPromptWorkspace(await this.state()));
      if (request.method === "POST" && url.pathname === "/global-policy") return json(await this.save(updateGlobalPolicy(await this.state(), String((await jsonBody(request)).content ?? "")), { ok: true }));
      const promptMatch = url.pathname.match(/^\/global-prompts\/([^/]+)$/);
      if (request.method === "POST" && promptMatch) return json(await this.save(updateGlobalPrompt(await this.state(), decodeURIComponent(promptMatch[1]), String((await jsonBody(request)).content ?? "")), { ok: true }));
      if (request.method === "POST" && url.pathname === "/feeds") return json(await this.createFeed(await jsonBody(request)));
      const archiveMatch = url.pathname.match(/^\/feeds\/([^/]+)\/archive$/);
      if (request.method === "POST" && archiveMatch) return json(await this.archiveFeed(decodeURIComponent(archiveMatch[1])));
      return notFound();
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async ensure(accountId: string): Promise<void> {
    if (this.initialized) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      const existing = await this.ctx.storage.get<AccountWorkspaceState>("state");
      if (!existing) await this.ctx.storage.put("state", defaultAccountState(accountId));
      this.initialized = true;
    });
  }

  private async state(): Promise<AccountWorkspaceState> {
    await this.ensure("demo-account");
    return (await this.ctx.storage.get<AccountWorkspaceState>("state"))!;
  }

  private async save<T>(state: AccountWorkspaceState, result: T): Promise<T> {
    await this.ctx.storage.put("state", state);
    return result;
  }

  private async workspace(feedId: string) {
    const state = await this.state();
    const feedViews = await Promise.all(state.feedIds.map(async (id): Promise<FeedView> => {
      const stub = this.env.FEED_DO.get(this.env.FEED_DO.idFromName(`account:${state.accountId}:feed:${id}`));
      return stub.fetch(new Request(`https://attention.internal/state?feedId=${encodeURIComponent(id)}`, {
        headers: { "x-attention-feed-id": id },
      })).then((response) => response.json() as Promise<FeedView>);
    }));
    return workspaceFromFeeds(state, feedViews, feedId);
  }

  private async createFeed(input: Record<string, unknown>) {
    const next = createFeedFromBrief(await this.state(), String(input.brief ?? ""));
    await this.ctx.storage.put("state", next.state);
    await registerFeed(this.env, next.state.accountId, next.config);
    const stub = this.env.FEED_DO.get(this.env.FEED_DO.idFromName(`account:${next.state.accountId}:feed:${next.config.id}`));
    const hostedState = createCustomFeedState(next.config, next.normalizedBrief, String(input.currentThreadId || "") || null);
    await stub.fetch(new Request("https://attention.internal/replace-state", {
      method: "POST",
      headers: { "x-attention-feed-id": next.config.id },
      body: JSON.stringify({ state: hostedState }),
    }));
    return next.config;
  }

  private async archiveFeed(feedId: string) {
    const next = removeFeed(await this.state(), feedId);
    await this.ctx.storage.put("state", next);
    await archiveFeedRef(this.env, next.accountId, feedId);
    return { ok: true };
  }
}
