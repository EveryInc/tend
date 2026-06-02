import type { Card, CardBlock, FeedConfig, FeedEvent, PolicyRevision, ProposedAction, SourceRecipe, ThreadBinding, WorkItem } from "../../types";
import type { FeedState, HostedCardInput } from "../env";
import { digest, isoNow, makeId, makeToken } from "../util";
import { normalizeCardBlocks, sourceRecipeFromBrief } from "./feed-state-service";

export interface FeedMutation<T> {
  state: FeedState;
  result: T;
  event?: Omit<FeedEvent, "id" | "at">;
}

function appendHistory(card: Card, type: string, detail?: string): void {
  card.history.push({ at: isoNow(), type, detail });
}

function actionDigest(card: Card): string {
  const action = card.proposedAction;
  const artifact = action?.artifactBlockId ? card.blocks.find((block) => block.id === action.artifactBlockId) : undefined;
  return digest({ action, artifact });
}

function event(state: FeedState, partial: Omit<FeedEvent, "id" | "at" | "feedId">): Omit<FeedEvent, "id" | "at"> {
  return { feedId: state.config.id, ...partial };
}

function assertThread(state: FeedState, threadId: string, crossFeed = false): void {
  if (!threadId.trim()) throw new Error("A Codex thread ID is required.");
  if (!state.thread.homeThreadId) throw new Error("Feed has no bound home thread.");
  if (state.thread.homeThreadId !== threadId.trim() && !crossFeed) throw new Error("This Codex thread does not own the feed. Use explicit cross-feed mode to proceed.");
}

export class FeedService {
  constructor(private state: FeedState) {}

  bind(threadId: string): FeedMutation<ThreadBinding> {
    if (!threadId.trim()) throw new Error("A home Codex thread ID is required.");
    this.state.thread.homeThreadId = threadId.trim();
    this.state.thread.boundAt = isoNow();
    return { state: this.state, result: this.state.thread, event: event(this.state, { type: "thread.bound", detail: { homeThreadId: threadId.trim() } }) };
  }

  proposeHeartbeat(cadence: string): FeedMutation<ThreadBinding> {
    this.state.thread.heartbeat = { status: "proposed", cadence: cadence.trim(), automationId: null };
    return { state: this.state, result: this.state.thread, event: event(this.state, { type: "heartbeat.proposed", detail: { cadence: cadence.trim() } }) };
  }

  applyPolicy(content: string, reason: string, source: PolicyRevision["source"]): FeedMutation<PolicyRevision> {
    if (!content.trim()) throw new Error("Policy content is required.");
    const revision: PolicyRevision = { id: makeId("policy"), feedId: this.state.config.id, previous: this.state.policy, next: content.replace(/\\n/g, "\n").trim(), reason, source, status: "applied", createdAt: isoNow() };
    this.state.policy = revision.next;
    this.state.policyRevisions[revision.id] = revision;
    return { state: this.state, result: revision, event: event(this.state, { type: "policy.applied", detail: { revisionId: revision.id, source, reason } }) };
  }

  addSource(brief: string): FeedMutation<SourceRecipe> {
    if (!brief.trim()) throw new Error("Describe the source you want to add.");
    const { recipe, markdown } = sourceRecipeFromBrief(brief);
    this.state.sources = [...this.state.sources.filter((source) => source.id !== recipe.id), { ...recipe, content: markdown } as SourceRecipe];
    this.state.checkpoints[recipe.id] ??= { sourceId: recipe.id, updatedAt: null, cursor: null };
    return { state: this.state, result: recipe, event: event(this.state, { type: "source.recipe_added", detail: { sourceId: recipe.id } }) };
  }

  updateSource(sourceId: string, content: string): FeedMutation<{ ok: true }> {
    if (!content.trim()) throw new Error("Source recipe content is required.");
    const source = this.state.sources.find((item) => item.id === sourceId) as SourceRecipe & { content?: string } | undefined;
    if (!source) throw new Error(`Source recipe not found: ${sourceId}`);
    source.content = content.trim();
    return { state: this.state, result: { ok: true }, event: event(this.state, { type: "source.recipe_edited", detail: { sourceId } }) };
  }

  queueFeedInstruction(instruction: string): FeedMutation<WorkItem> {
    if (!instruction.trim()) throw new Error("Instruction is required.");
    const now = isoNow();
    const work: WorkItem = { id: makeId("work"), feedId: this.state.config.id, cardId: "__feed__", kind: "instruction", instruction: instruction.trim(), status: "queued", capabilityToken: makeToken(), createdAt: now, updatedAt: now };
    this.state.work[work.id] = work;
    return { state: this.state, result: work, event: event(this.state, { workId: work.id, type: "feed.instruction_queued", detail: { instruction: work.instruction } }) };
  }

  queueInstruction(cardId: string, instruction: string): FeedMutation<WorkItem> {
    if (!instruction.trim()) throw new Error("Instruction is required.");
    const card = this.state.cards[cardId];
    if (!card) throw new Error("Card not found.");
    if (card.status === "done") throw new Error("Done cards cannot be queued.");
    const now = isoNow();
    const work: WorkItem = { id: makeId("work"), feedId: this.state.config.id, cardId, kind: "instruction", instruction: instruction.trim(), status: "queued", capabilityToken: makeToken(), createdAt: now, updatedAt: now };
    card.status = "queued";
    appendHistory(card, "user.instruction", instruction.trim());
    this.state.work[work.id] = work;
    return { state: this.state, result: work, event: event(this.state, { cardId, workId: work.id, type: "work.queued", detail: { instruction: work.instruction } }) };
  }

  approveAction(cardId: string): FeedMutation<WorkItem> {
    const card = this.state.cards[cardId];
    if (!card?.proposedAction) throw new Error("Card has no proposed action.");
    const now = isoNow();
    const approvalDigest = actionDigest(card);
    const work: WorkItem = { id: makeId("work"), feedId: this.state.config.id, cardId, kind: "execute_approved_action", instruction: card.proposedAction.instruction, status: "queued", capabilityToken: makeToken(), approvalDigest, createdAt: now, updatedAt: now };
    card.status = "queued";
    appendHistory(card, "user.approved_action", approvalDigest);
    this.state.work[work.id] = work;
    return { state: this.state, result: work, event: event(this.state, { cardId, workId: work.id, type: "action.approved", detail: { approvalDigest } }) };
  }

  dismissCard(cardId: string): FeedMutation<WorkItem> {
    const card = this.state.cards[cardId];
    if (!card) throw new Error("Card not found.");
    const now = isoNow();
    const work: WorkItem = { id: makeId("work"), feedId: this.state.config.id, cardId, kind: "default_cleanup", instruction: this.state.config.defaultCleanup, status: "queued", capabilityToken: makeToken(), createdAt: now, updatedAt: now };
    card.status = "queued";
    appendHistory(card, "user.default_cleanup_approved", this.state.config.defaultCleanup);
    this.state.work[work.id] = work;
    return { state: this.state, result: work, event: event(this.state, { cardId, workId: work.id, type: "cleanup.queued", detail: { cleanup: this.state.config.defaultCleanup } }) };
  }

  undoDismiss(cardId: string): FeedMutation<Card> {
    const work = Object.values(this.state.work).reverse().find((item) => item.cardId === cardId && item.kind === "default_cleanup" && item.status === "queued");
    if (!work) throw new Error("Queued cleanup is no longer available to undo.");
    work.status = "cancelled";
    const card = this.state.cards[cardId];
    card.status = "to_review_updated";
    card.readyForPass = this.state.config.currentPass;
    appendHistory(card, "user.default_cleanup_undone", work.id);
    return { state: this.state, result: card, event: event(this.state, { cardId, workId: work.id, type: "cleanup.cancelled" }) };
  }

  updateBlock(cardId: string, blockId: string, value: string): FeedMutation<Card> {
    const card = this.state.cards[cardId];
    const block = card?.blocks.find((item) => item.id === blockId);
    if (!block || !block.editable) throw new Error("Editable card block not found.");
    block.value = value;
    appendHistory(card, "user.edited_artifact", blockId);
    return { state: this.state, result: card, event: event(this.state, { cardId, type: "card.block_edited", detail: { blockId } }) };
  }

  beginNextPass(): FeedMutation<FeedConfig> {
    this.state.config.currentPass += 1;
    this.state.config.updatedAt = isoNow();
    return { state: this.state, result: this.state.config, event: event(this.state, { type: "sweep.next_pass", detail: { currentPass: this.state.config.currentPass } }) };
  }

  queueCompound(): FeedMutation<WorkItem> {
    const now = isoNow();
    const work: WorkItem = {
      id: makeId("work"),
      feedId: this.state.config.id,
      cardId: "__feed__",
      kind: "compound_learnings",
      instruction: "Compound the feed learnings. Review raw snapshots, runs, events, outcomes, and policy history. Apply narrow reversible feed-specific improvements and surface structural proposals as review cards.",
      status: "queued",
      capabilityToken: makeToken(),
      createdAt: now,
      updatedAt: now,
    };
    this.state.work[work.id] = work;
    return { state: this.state, result: work, event: event(this.state, { workId: work.id, type: "learning.compound_queued" }) };
  }

  listWork(threadId: string, crossFeed = false): WorkItem[] {
    assertThread(this.state, threadId, crossFeed);
    return Object.values(this.state.work).filter((work) => work.status === "queued" || work.status === "working");
  }

  claimWork(threadId: string, crossFeed = false): FeedMutation<WorkItem | null> {
    assertThread(this.state, threadId, crossFeed);
    const existing = Object.values(this.state.work).find((work) => work.status === "working");
    if (existing) return { state: this.state, result: existing };
    const work = Object.values(this.state.work).find((item) => item.status === "queued");
    if (!work) return { state: this.state, result: null };
    work.status = "working";
    work.claimedAt = isoNow();
    work.updatedAt = isoNow();
    if (work.cardId !== "__feed__") {
      const card = this.state.cards[work.cardId];
      card.status = "working";
      appendHistory(card, "codex.claimed", work.id);
    }
    return { state: this.state, result: work, event: event(this.state, { cardId: work.cardId, workId: work.id, type: "work.claimed", detail: { threadId } }) };
  }

  cancelQueuedWork(workId: string, reason: string): FeedMutation<WorkItem> {
    const work = this.state.work[workId];
    if (!work || work.status !== "queued") throw new Error("Only queued work can be cancelled before Codex starts.");
    work.status = "cancelled";
    work.error = reason.trim() || "Cancelled before Codex started work.";
    if (work.cardId !== "__feed__") {
      const card = this.state.cards[work.cardId];
      const hasActiveWork = Object.values(this.state.work).some((item) => item.id !== work.id && item.cardId === work.cardId && (item.status === "queued" || item.status === "working"));
      if (!hasActiveWork) {
        card.status = "to_review_updated";
        card.readyForPass = this.state.config.currentPass;
        appendHistory(card, "user.cancelled_queued_work", work.id);
      }
    }
    return { state: this.state, result: work, event: event(this.state, { cardId: work.cardId, workId, type: "work.cancelled", detail: { reason: work.error } }) };
  }

  completeWork(workId: string, token: string, result: { response: string; blocks?: CardBlock[]; proposedAction?: ProposedAction; done?: boolean }): FeedMutation<WorkItem> {
    const work = this.state.work[workId];
    if (!work || work.status !== "working") throw new Error("Work item is not currently claimed.");
    if (work.capabilityToken !== token) throw new Error("Invalid scoped work capability token.");
    if (!result?.response?.trim()) throw new Error("A work response is required.");
    if (work.cardId !== "__feed__") {
      const card = this.state.cards[work.cardId];
      if (work.approvalDigest && work.approvalDigest !== actionDigest(card)) {
        work.status = "stale";
        work.error = "Approval stale - the proposed action or artifact changed after approval.";
        card.status = "to_review_updated";
        card.readyForPass = this.state.config.currentPass + 1;
        appendHistory(card, "codex.stale_approval", work.id);
        return { state: this.state, result: work, event: event(this.state, { cardId: card.id, workId, type: "action.stale" }) };
      }
      if ("blocks" in result) card.blocks = normalizeCardBlocks((result as { blocks?: unknown }).blocks, card.blocks);
      if (result.proposedAction) card.proposedAction = result.proposedAction;
      const done = Boolean(result.done || work.kind === "default_cleanup" || card.status === "done");
      card.status = done ? "done" : "to_review_updated";
      card.completedAt = done ? isoNow() : undefined;
      card.readyForPass = this.state.config.currentPass + 1;
      appendHistory(card, "codex.completed", result.response.trim());
    }
    work.status = "completed";
    work.completedAt = isoNow();
    work.response = result.response.trim();
    work.updatedAt = isoNow();
    return { state: this.state, result: work, event: event(this.state, { cardId: work.cardId, workId, type: "work.completed", detail: { response: work.response } }) };
  }

  failWork(workId: string, token: string, error: string): FeedMutation<WorkItem> {
    const work = this.state.work[workId];
    if (!work || work.status !== "working") throw new Error("Work item is not currently claimed.");
    if (work.capabilityToken !== token) throw new Error("Invalid scoped work capability token.");
    work.status = "failed";
    work.error = error.trim() || "Codex could not complete this work.";
    if (work.cardId !== "__feed__") {
      const card = this.state.cards[work.cardId];
      card.status = "to_review_updated";
      card.readyForPass = this.state.config.currentPass + 1;
      appendHistory(card, "codex.failed", work.error);
    }
    return { state: this.state, result: work, event: event(this.state, { cardId: work.cardId, workId, type: "work.failed", detail: { error: work.error } }) };
  }

  verifyApprovedAction(workId: string, token: string) {
    const work = this.state.work[workId];
    if (!work || work.status !== "working") throw new Error("Approved action work must be claimed before verification.");
    if (work.kind !== "execute_approved_action" || !work.approvalDigest) throw new Error("Work item is not an approved action.");
    if (work.capabilityToken !== token) throw new Error("Invalid scoped work capability token.");
    const card = this.state.cards[work.cardId];
    if (!card.proposedAction || work.approvalDigest !== actionDigest(card)) throw new Error("Approval stale - reread and return the card for review.");
    return {
      approvalDigest: work.approvalDigest,
      action: card.proposedAction,
      artifact: card.proposedAction.artifactBlockId ? card.blocks.find((block) => block.id === card.proposedAction?.artifactBlockId) : undefined,
    };
  }

  upsertCard(input: HostedCardInput): FeedMutation<Card> {
    const now = isoNow();
    const existing = this.state.cards[input.id];
    const card: Card = {
      id: input.id,
      feedId: this.state.config.id,
      kind: input.kind ?? existing?.kind ?? "attention",
      status: input.status ?? existing?.status ?? "to_review_new",
      eyebrow: input.eyebrow ?? existing?.eyebrow ?? this.state.config.name,
      title: input.title,
      why: input.why,
      blocks: normalizeCardBlocks((input as HostedCardInput & { blocks?: unknown }).blocks, existing?.blocks),
      proposedAction: input.proposedAction,
      readyForPass: input.readyForPass ?? existing?.readyForPass ?? this.state.config.currentPass,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      completedAt: input.completedAt,
      history: existing?.history ?? [],
    };
    this.state.cards[card.id] = card;
    return { state: this.state, result: card, event: event(this.state, { cardId: card.id, type: existing ? "card.updated" : "card.created" }) };
  }

  recordSourceRun(sourceId: string, snapshots: unknown[], judgments: unknown[], checkpoint: unknown): FeedMutation<string> {
    const runId = makeId("run");
    this.state.runs[runId] = { id: runId, feedId: this.state.config.id, sourceId, snapshots, judgments, completedAt: isoNow() };
    this.state.checkpoints[sourceId] = checkpoint ?? {};
    return { state: this.state, result: runId, event: event(this.state, { type: "source.run_completed", detail: { runId, sourceId, snapshots: snapshots.length, judgments: judgments.length } }) };
  }
}
