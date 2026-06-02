import { DurableObject } from "cloudflare:workers";
import type { FeedView, RevisionProposal } from "../../types";
import type { AccountWorkspaceState, HostedEnv } from "../env";
import { errorResponse, json, jsonBody, notFound } from "../util";
import {
  applyGlobalRevisionProposal,
  createFeedFromBrief,
  defaultAccountState,
  globalPromptWorkspace,
  proposeGlobalRevision,
  rejectGlobalRevisionProposal,
  removeFeed,
  revertGlobalWorkspaceRevision,
  updateGlobalPolicy,
  updateGlobalPrompt,
  updateGlobalRevisionProposal,
  workspaceFromFeeds,
} from "../services/account-service";
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
      if (request.method === "POST" && url.pathname === "/revision-proposals") return json(await this.createRevisionProposal(await jsonBody(request)));
      const archiveMatch = url.pathname.match(/^\/feeds\/([^/]+)\/archive$/);
      if (request.method === "POST" && archiveMatch) return json(await this.archiveFeed(decodeURIComponent(archiveMatch[1])));
      const proposalApplyMatch = url.pathname.match(/^\/revision-proposals\/([^/]+)\/apply$/);
      if (request.method === "POST" && proposalApplyMatch) return json(await this.forwardProposalMutation(decodeURIComponent(proposalApplyMatch[1]), "apply"));
      const proposalRejectMatch = url.pathname.match(/^\/revision-proposals\/([^/]+)\/reject$/);
      if (request.method === "POST" && proposalRejectMatch) return json(await this.forwardProposalMutation(decodeURIComponent(proposalRejectMatch[1]), "reject"));
      const proposalUpdateMatch = url.pathname.match(/^\/revision-proposals\/([^/]+)$/);
      if (request.method === "POST" && proposalUpdateMatch) return json(await this.forwardProposalMutation(decodeURIComponent(proposalUpdateMatch[1]), "", await jsonBody(request)));
      const revisionRevertMatch = url.pathname.match(/^\/revisions\/([^/]+)\/revert$/);
      if (request.method === "POST" && revisionRevertMatch) return json(await this.forwardRevisionRevert(decodeURIComponent(revisionRevertMatch[1])));
      return notFound();
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async ensure(accountId: string): Promise<void> {
    if (this.initialized) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      const existing = await this.ctx.storage.get<AccountWorkspaceState>("state");
      if (!existing) {
        await this.ctx.storage.put("state", defaultAccountState(accountId));
      } else if (!existing.revisionProposals || !existing.workspaceRevisions) {
        await this.ctx.storage.put("state", { ...existing, revisionProposals: existing.revisionProposals ?? {}, workspaceRevisions: existing.workspaceRevisions ?? {} });
      }
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
    const proposals = (await Promise.all(state.feedIds.map(async (id): Promise<RevisionProposal[]> => {
      const stub = this.env.FEED_DO.get(this.env.FEED_DO.idFromName(`account:${state.accountId}:feed:${id}`));
      return stub.fetch(new Request("https://attention.internal/proposals", {
        headers: { "x-attention-feed-id": id },
      })).then((response) => response.ok ? response.json() as Promise<RevisionProposal[]> : []);
    }))).flat();
    return workspaceFromFeeds(state, feedViews, feedId, proposals);
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

  private async createRevisionProposal(input: Record<string, unknown>) {
    const next = proposeGlobalRevision(await this.state(), String(input.feedId ?? input.anchorFeedId ?? "inbox"), input.target as any, String(input.instruction ?? ""), String(input.content ?? input.next ?? ""), input.source === "compound" ? "compound" : "voice");
    await this.ctx.storage.put("state", next.state);
    return next.proposal;
  }

  private async forwardProposalMutation(proposalId: string, action: "apply" | "reject" | "", body: Record<string, unknown> = {}) {
    const state = await this.state();
    if (state.revisionProposals?.[proposalId]) {
      if (action === "apply") {
        const next = applyGlobalRevisionProposal(state, proposalId);
        await this.ctx.storage.put("state", next.state);
        return next.revision;
      }
      if (action === "reject") {
        const next = rejectGlobalRevisionProposal(state, proposalId);
        await this.ctx.storage.put("state", next.state);
        return next.proposal;
      }
      const next = updateGlobalRevisionProposal(state, proposalId, String(body.content ?? ""));
      await this.ctx.storage.put("state", next.state);
      return next.proposal;
    }
    for (const feedId of state.feedIds) {
      const result = await this.tryFeed(feedId, `/revision-proposals/${encodeURIComponent(proposalId)}${action ? `/${action}` : ""}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (result.found) return result.value;
    }
    throw new Error("Revision proposal not found.");
  }

  private async forwardRevisionRevert(revisionId: string) {
    const state = await this.state();
    if (state.workspaceRevisions?.[revisionId]) {
      const next = revertGlobalWorkspaceRevision(state, revisionId);
      await this.ctx.storage.put("state", next.state);
      return next.revision;
    }
    for (const feedId of state.feedIds) {
      const result = await this.tryFeed(feedId, `/revisions/${encodeURIComponent(revisionId)}/revert`, { method: "POST" });
      if (result.found) return result.value;
    }
    throw new Error("Workspace revision not found.");
  }

  private async tryFeed(feedId: string, path: string, init: RequestInit): Promise<{ found: true; value: unknown } | { found: false }> {
    const state = await this.state();
    const stub = this.env.FEED_DO.get(this.env.FEED_DO.idFromName(`account:${state.accountId}:feed:${feedId}`));
    const response = await stub.fetch(new Request(`https://attention.internal${path}`, {
      ...init,
      headers: { "x-attention-feed-id": feedId, "content-type": "application/json", ...(init.headers ?? {}) },
    }));
    const value = await response.json().catch(() => ({}));
    if (response.ok) return { found: true, value };
    const error = String((value as { error?: string }).error ?? "");
    if (error.toLowerCase().includes("not found")) return { found: false };
    throw new Error(error || `Feed mutation failed: ${response.status}`);
  }
}
