import type {
  Card,
  CardAction,
  CardBlock,
  FeedConfig,
  FeedEvent,
  PolicyRevision,
  ProposedAction,
  RevisionProposal,
  RoutineActionGroup,
  SourceRecipe,
  SweepFeedbackTrace,
  ThreadBinding,
  VoiceTarget,
  WorkItem,
  WorkspaceRevision,
} from "../../types";
import type { FeedState, HostedCardInput } from "../env";
import { digest, isoNow, makeId, makeToken } from "../util";
import { FEED_PROMPT_NAMES, normalizeCard, normalizeCardBlocks, normalizeCardStatus, sourceRecipeFromBrief } from "./feed-state-service";

export interface FeedMutation<T> {
  state: FeedState;
  result: T;
  event?: Omit<FeedEvent, "id" | "at">;
}

function appendHistory(card: Card, type: string, detail?: string): void {
  card.history.push({ at: isoNow(), type, detail });
}

function actionDigestFor(card: Card, cardActionId?: string): string {
  const action = configuredApprovalAction(card, cardActionId);
  const artifact = action.artifactBlockId ? card.blocks.find((block) => block.id === action.artifactBlockId) : undefined;
  return digest({ cardActionId: cardActionId ?? null, action, artifact });
}

function cleanupDigest(card: Card, instruction: string): string {
  return digest({
    instruction,
    card: {
      id: card.id,
      feedId: card.feedId,
      title: card.title,
      why: card.why,
      blocks: card.blocks,
      proposedAction: card.proposedAction,
      actions: card.actions,
    },
  });
}

function routineActionDigest(group: RoutineActionGroup): string {
  return digest({
    feedId: group.feedId,
    id: group.id,
    label: group.label,
    summary: group.summary,
    proposedAction: group.proposedAction,
    items: group.items,
  });
}

function configuredApprovalAction(card: Card, cardActionId?: string): ProposedAction {
  if (!cardActionId) {
    if (!card.proposedAction) throw new Error("Card has no proposed action.");
    return card.proposedAction;
  }
  const action = card.actions?.find((item) => item.id === cardActionId);
  if (!action || action.behavior !== "approve_action" || !action.instruction?.trim()) {
    throw new Error("Card approval action not found.");
  }
  return {
    label: action.label,
    instruction: action.instruction,
    ...(action.artifactBlockId ? { artifactBlockId: action.artifactBlockId } : {}),
    ...(action.externalMutation !== undefined ? { externalMutation: action.externalMutation } : {}),
    ...(action.mailboxPolicy ? { mailboxPolicy: action.mailboxPolicy } : {}),
  };
}

function normalizeMailbox(mailbox?: string): string | undefined {
  const normalized = mailbox?.trim().toLowerCase();
  return normalized || undefined;
}

function requiresSourceMailboxMatch(feedId: string, action: ProposedAction): boolean {
  return action.mailboxPolicy === "reply_from_source" ||
    (feedId === "inbox" && action.externalMutation === true && Boolean(action.artifactBlockId));
}

function requiredSourceMailbox(feedId: string, card: Card, action: ProposedAction): string | undefined {
  if (!requiresSourceMailboxMatch(feedId, action)) return undefined;
  const sourceMailbox = normalizeMailbox(card.sourceMailbox);
  if (!sourceMailbox) throw new Error("Email reply is missing the mailbox that received the source email.");
  return sourceMailbox;
}

function verifySourceMailbox(feedId: string, card: Card, action: ProposedAction, authenticatedMailbox?: string): string | undefined {
  const sourceMailbox = requiredSourceMailbox(feedId, card, action);
  if (!sourceMailbox) return undefined;
  const authenticated = normalizeMailbox(authenticatedMailbox);
  if (!authenticated) throw new Error(`Email reply verification requires the authenticated Gmail mailbox. Expected ${sourceMailbox}.`);
  if (authenticated !== sourceMailbox) throw new Error(`Authenticated Gmail mailbox mismatch: expected ${sourceMailbox}, got ${authenticated}.`);
  return authenticated;
}

function event(state: FeedState, partial: Omit<FeedEvent, "id" | "at" | "feedId">): Omit<FeedEvent, "id" | "at"> {
  return { feedId: state.config.id, ...partial };
}

function assertThread(state: FeedState, threadId: string, crossFeed = false): void {
  if (!threadId.trim()) throw new Error("A Codex thread ID is required.");
  if (!state.thread.homeThreadId) throw new Error("Feed has no bound home thread.");
  if (state.thread.homeThreadId !== threadId.trim() && !crossFeed) throw new Error("This Codex thread does not own the feed. Use explicit cross-feed mode to proceed.");
}

function queuedWork(state: FeedState, cardId: string, instruction: string, extra: Pick<WorkItem, "kind"> & Partial<Pick<WorkItem, "target" | "intent" | "feedbackId" | "startingBatchId" | "previousSweepState" | "approvalDigest" | "cardActionId" | "routineActionGroupId">>): WorkItem {
  const now = isoNow();
  return {
    id: makeId("work"),
    feedId: state.config.id,
    cardId,
    instruction: instruction.trim(),
    status: "queued",
    capabilityToken: makeToken(),
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

function revisionLabel(target: VoiceTarget): string {
  if (target.kind === "feed") return "Feed policy";
  if (target.kind === "source_recipe") return `Source recipe · ${target.sourceId}`;
  if (target.kind === "prompt_layer") return `Feed prompt · ${target.promptId}`;
  if (target.kind === "global_prompt") return `Global prompt · ${target.promptId}`;
  return "Attention policy";
}

export class FeedService {
  constructor(private state: FeedState) {
    state.routineActions ??= {};
    state.sweep ??= { currentBatchId: null, lastFeedbackId: null, recollectionOffered: false, statusMessage: null };
    state.sweepFeedback ??= {};
    state.sweepBatches ??= {};
    state.revisionProposals ??= {};
    state.workspaceRevisions ??= {};
    state.prompts ??= {};
  }

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
    if (!card) throw new Error("Card not found.");
    return this.approveConfiguredAction(cardId);
  }

  approveConfiguredAction(cardId: string, cardActionId?: string): FeedMutation<WorkItem> {
    const card = this.state.cards[cardId];
    if (!card) throw new Error("Card not found.");
    if (card.status === "done") throw new Error("Done cards cannot be approved.");
    const action = configuredApprovalAction(card, cardActionId);
    requiredSourceMailbox(this.state.config.id, card, action);
    const approvalDigest = actionDigestFor(card, cardActionId);
    const active = Object.values(this.state.work).filter((work) => work.cardId === cardId && work.kind === "execute_approved_action" && (work.status === "queued" || work.status === "working"));
    const existing = active.find((work) => work.approvalDigest === approvalDigest);
    if (existing) return { state: this.state, result: existing };
    if (active.some((work) => work.status === "working")) throw new Error("An approved action is already in progress for an older snapshot.");
    for (const work of active) {
      work.status = "stale";
      work.error = "Approval stale - a newer visible action snapshot was approved.";
    }
    const work = queuedWork(this.state, cardId, action.instruction, {
      kind: "execute_approved_action",
      approvalDigest,
      ...(cardActionId ? { cardActionId } : {}),
    });
    card.status = "queued";
    appendHistory(card, "user.approved_action", approvalDigest);
    this.state.work[work.id] = work;
    return { state: this.state, result: work, event: event(this.state, { cardId, workId: work.id, type: "action.approved", detail: { approvalDigest } }) };
  }

  runCardAction(cardId: string, cardActionId: string): FeedMutation<WorkItem> {
    if (cardActionId === "default-cleanup") return this.dismissCard(cardId);
    if (cardActionId === "proposed-action") return this.approveConfiguredAction(cardId);
    const card = this.state.cards[cardId];
    if (!card) throw new Error("Card not found.");
    const action = card.actions?.find((item) => item.id === cardActionId);
    if (!action) throw new Error("Card action not found.");
    if (action.behavior === "default_cleanup") return this.dismissCard(cardId);
    if (!action.instruction?.trim()) throw new Error("Card action instruction is required.");
    if (action.behavior === "queue_instruction") return this.queueInstruction(cardId, action.instruction);
    return this.approveConfiguredAction(cardId, action.id);
  }

  dismissCard(cardId: string): FeedMutation<WorkItem> {
    const card = this.state.cards[cardId];
    if (!card) throw new Error("Card not found.");
    if (card.status === "done") throw new Error("Done cards cannot be cleaned up again.");
    const approvalDigest = cleanupDigest(card, this.state.config.defaultCleanup);
    const active = Object.values(this.state.work).filter((work) => work.cardId === cardId && work.kind === "default_cleanup" && (work.status === "queued" || work.status === "working"));
    const existing = active.find((work) => work.approvalDigest === approvalDigest);
    if (existing) return { state: this.state, result: existing };
    if (active.some((work) => work.status === "working")) throw new Error("A default cleanup is already in progress for an older snapshot.");
    for (const work of active) {
      work.status = "stale";
      work.error = "Approval stale - a newer visible cleanup snapshot was approved.";
    }
    const work = queuedWork(this.state, cardId, this.state.config.defaultCleanup, { kind: "default_cleanup", approvalDigest });
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
      instruction: "The user approved a learning pass. Review raw snapshots, runs, events, outcomes, and policy history. Distill a compact feed-policy improvement, then create an editable revision proposal with propose_revision --source compound. Do not apply it. The browser will bring the proposal back to the user for review.",
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
    if (work.kind === "routine_action_batch" && work.routineActionGroupId) {
      const group = this.state.routineActions[work.routineActionGroupId];
      if (group) {
        group.status = "working";
        group.workId = work.id;
      }
    } else if (work.cardId !== "__feed__") {
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
    if (work.kind === "routine_action_batch" && work.routineActionGroupId) {
      const group = this.state.routineActions[work.routineActionGroupId];
      if (group) {
        group.status = "proposed";
        group.workId = undefined;
        group.error = undefined;
      }
    } else if (work.cardId !== "__feed__") {
      const card = this.state.cards[work.cardId];
      const hasActiveWork = Object.values(this.state.work).some((item) => item.id !== work.id && item.cardId === work.cardId && (item.status === "queued" || item.status === "working"));
      if (!hasActiveWork) {
        card.status = "to_review_updated";
        card.readyForPass = this.state.config.currentPass;
        appendHistory(card, "user.cancelled_queued_work", work.id);
      }
    } else if (work.intent === "sweep_rejudge" && work.feedbackId && this.state.sweep.lastFeedbackId === work.feedbackId) {
      this.restoreAbandonedSweepFeedback(work);
    }
    return { state: this.state, result: work, event: event(this.state, { cardId: work.cardId, workId, type: "work.cancelled", detail: { reason: work.error } }) };
  }

  completeWork(workId: string, token: string, result: { response: string; blocks?: CardBlock[]; proposedAction?: ProposedAction; actions?: CardAction[]; done?: boolean }): FeedMutation<WorkItem> {
    const work = this.state.work[workId];
    if (!work || work.status !== "working") throw new Error("Work item is not currently claimed.");
    if (work.capabilityToken !== token) throw new Error("Invalid scoped work capability token.");
    if (!result?.response?.trim()) throw new Error("A work response is required.");
    if (work.intent === "sweep_rejudge") {
      if (!work.feedbackId || !this.state.sweepFeedback[work.feedbackId]?.rejudgedAt) throw new Error("Sweep rejudgment must be recorded before this work can complete.");
    }
    if (work.intent === "recollect_sources") {
      if (work.startingBatchId === undefined) throw new Error("Source recollection work is missing its starting sweep batch.");
      const batchId = this.state.sweep.currentBatchId;
      if (!batchId || batchId === work.startingBatchId) throw new Error("A new sweep batch must be recorded before source recollection can complete.");
      const batch = this.state.sweepBatches[batchId];
      if (!batch || batch.triggerWorkId !== work.id) throw new Error("Source recollection must complete with a sweep batch recorded for this work item.");
    }
    if (work.kind === "routine_action_batch") {
      if (!work.routineActionGroupId || !work.approvalDigest) throw new Error("Routine action work is missing its approved snapshot.");
      const group = this.state.routineActions[work.routineActionGroupId];
      if (!group || work.approvalDigest !== routineActionDigest(group)) {
        work.status = "stale";
        work.error = "Approval stale - the routine action group changed after approval.";
        if (group) {
          group.status = "stale";
          group.error = work.error;
          this.releaseRoutineActionCards(group, true);
        }
        throw new Error(work.error);
      }
      if (work.verifiedApprovalDigest !== work.approvalDigest) throw new Error("Approved action must pass action:verify immediately before the external mutation.");
      for (const item of group.items) {
        if (!item.cardId) continue;
        const card = this.state.cards[item.cardId];
        if (!card) continue;
        card.status = "done";
        card.completedAt = isoNow();
        appendHistory(card, "routine_action.completed", work.id);
      }
      group.status = "completed";
      group.completedAt = isoNow();
      group.error = undefined;
    } else if (work.cardId !== "__feed__") {
      const card = this.state.cards[work.cardId];
      const currentApprovalDigest = work.approvalDigest
        ? work.kind === "default_cleanup"
          ? cleanupDigest(card, this.state.config.defaultCleanup)
          : actionDigestFor(card, work.cardActionId)
        : undefined;
      if (work.approvalDigest !== currentApprovalDigest) {
        work.status = "stale";
        work.error = "Approval stale - the proposed action or artifact changed after approval.";
        card.status = "to_review_updated";
        card.readyForPass = this.state.config.currentPass + 1;
        appendHistory(card, "codex.stale_approval", work.id);
        return { state: this.state, result: work, event: event(this.state, { cardId: card.id, workId, type: "action.stale" }) };
      }
      if ((work.kind === "execute_approved_action" || work.kind === "default_cleanup") && work.verifiedApprovalDigest !== work.approvalDigest) {
        throw new Error("Approved action must pass action:verify immediately before the external mutation.");
      }
      if (work.kind === "execute_approved_action") {
        const action = configuredApprovalAction(card, work.cardActionId);
        const sourceMailbox = requiredSourceMailbox(this.state.config.id, card, action);
        if (sourceMailbox && work.verifiedMailbox !== sourceMailbox) throw new Error(`Approved email reply must be reverified for ${sourceMailbox} before completion.`);
      }
      if ("blocks" in result) card.blocks = normalizeCardBlocks((result as { blocks?: unknown }).blocks, card.blocks);
      if (result.proposedAction) card.proposedAction = result.proposedAction;
      if (result.actions) card.actions = result.actions;
      const done = Boolean(result.done || work.kind === "default_cleanup" || work.kind === "execute_approved_action" || card.status === "done");
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
    if (work.kind === "routine_action_batch" && work.routineActionGroupId) {
      const group = this.state.routineActions[work.routineActionGroupId];
      if (group) {
        group.status = "failed";
        group.error = work.error;
        this.releaseRoutineActionCards(group, true);
      }
    } else if (work.cardId !== "__feed__") {
      const card = this.state.cards[work.cardId];
      card.status = "to_review_updated";
      card.readyForPass = this.state.config.currentPass + 1;
      appendHistory(card, "codex.failed", work.error);
    } else if (work.intent === "recollect_sources") {
      if (this.state.sweep.currentBatchId === work.startingBatchId) {
        this.state.sweep = { ...this.state.sweep, recollectionOffered: true, statusMessage: "Source search failed" };
      }
    } else if (work.intent === "sweep_rejudge" && work.feedbackId && this.state.sweep.lastFeedbackId === work.feedbackId) {
      this.restoreAbandonedSweepFeedback(work);
    }
    return { state: this.state, result: work, event: event(this.state, { cardId: work.cardId, workId, type: "work.failed", detail: { error: work.error } }) };
  }

  blockApprovedWork(workId: string, token: string, error: string): FeedMutation<WorkItem> {
    const work = this.state.work[workId];
    if (!work || work.status !== "working") throw new Error("Work item is not currently claimed.");
    if (work.kind !== "execute_approved_action" || !work.approvalDigest) throw new Error("Only approved actions can wait for a retry.");
    if (work.capabilityToken !== token) throw new Error("Invalid scoped work capability token.");
    const card = this.state.cards[work.cardId];
    if (work.approvalDigest !== actionDigestFor(card, work.cardActionId)) {
      work.status = "stale";
      work.error = "Approval stale - the proposed action or artifact changed after approval.";
      card.status = "to_review_updated";
      card.readyForPass = this.state.config.currentPass + 1;
      appendHistory(card, "codex.stale_approval", work.id);
      return { state: this.state, result: work, event: event(this.state, { cardId: card.id, workId, type: "action.stale" }) };
    }
    work.status = "approved_blocked";
    work.error = error.trim() || "The approved action is waiting for Codex to retry.";
    work.updatedAt = isoNow();
    card.status = "approved_blocked";
    appendHistory(card, "codex.approved_action_blocked", work.error);
    return { state: this.state, result: work, event: event(this.state, { cardId: work.cardId, workId, type: "work.approved_action_blocked", detail: { error: work.error } }) };
  }

  retryApprovedWork(workId: string): FeedMutation<WorkItem> {
    const work = this.state.work[workId];
    if (!work || (work.status !== "approved_blocked" && work.status !== "failed") || work.kind !== "execute_approved_action" || !work.approvalDigest) {
      throw new Error("Only an approved blocked action can be retried.");
    }
    const card = this.state.cards[work.cardId];
    requiredSourceMailbox(this.state.config.id, card, configuredApprovalAction(card, work.cardActionId));
    if (work.approvalDigest !== actionDigestFor(card, work.cardActionId)) {
      work.status = "stale";
      work.error = "Approval stale - the proposed action or artifact changed after approval.";
      card.status = "to_review_updated";
      card.readyForPass = this.state.config.currentPass + 1;
      appendHistory(card, "codex.stale_approval", work.id);
      return { state: this.state, result: work, event: event(this.state, { cardId: card.id, workId, type: "action.stale" }) };
    }
    work.status = "queued";
    work.capabilityToken = makeToken();
    work.updatedAt = isoNow();
    work.claimedAt = undefined;
    work.error = undefined;
    work.verifiedAt = undefined;
    work.verifiedApprovalDigest = undefined;
    work.verifiedMailbox = undefined;
    card.status = "queued";
    appendHistory(card, "codex.approved_action_retry_queued", work.id);
    return { state: this.state, result: work, event: event(this.state, { cardId: work.cardId, workId, type: "work.approved_action_retry_queued" }) };
  }

  verifyApprovedAction(workId: string, token: string, authenticatedMailbox?: string) {
    const work = this.state.work[workId];
    if (!work || work.status !== "working") throw new Error("Approved action work must be claimed before verification.");
    if ((work.kind !== "execute_approved_action" && work.kind !== "default_cleanup" && work.kind !== "routine_action_batch") || !work.approvalDigest) throw new Error("Work item is not an approved action.");
    if (work.capabilityToken !== token) throw new Error("Invalid scoped work capability token.");
    let result: { approvalDigest: string; action: ProposedAction; artifact?: CardBlock; verifiedMailbox?: string };
    if (work.kind === "routine_action_batch") {
      if (!work.routineActionGroupId) throw new Error("Routine action work is missing its group.");
      const group = this.state.routineActions[work.routineActionGroupId];
      if (!group || work.approvalDigest !== routineActionDigest(group)) throw new Error("Approval stale - reread and return the routine action group for review.");
      result = { approvalDigest: work.approvalDigest, action: group.proposedAction };
    } else {
      const card = this.state.cards[work.cardId];
      if (work.kind === "default_cleanup") {
        if (work.instruction !== this.state.config.defaultCleanup || work.approvalDigest !== cleanupDigest(card, this.state.config.defaultCleanup)) throw new Error("Approval stale - reread and return the card for review.");
        result = { approvalDigest: work.approvalDigest, action: { label: "Default cleanup", instruction: this.state.config.defaultCleanup } };
      } else {
        const action = configuredApprovalAction(card, work.cardActionId);
        if (work.approvalDigest !== actionDigestFor(card, work.cardActionId)) throw new Error("Approval stale - reread and return the card for review.");
        const verifiedMailbox = verifySourceMailbox(this.state.config.id, card, action, authenticatedMailbox);
        result = {
          approvalDigest: work.approvalDigest,
          action,
          artifact: action.artifactBlockId ? card.blocks.find((block) => block.id === action.artifactBlockId) : undefined,
          ...(verifiedMailbox ? { verifiedMailbox } : {}),
        };
      }
    }
    work.verifiedAt = isoNow();
    work.verifiedApprovalDigest = work.approvalDigest;
    work.verifiedMailbox = result.verifiedMailbox;
    return result;
  }

  upsertCard(input: HostedCardInput): FeedMutation<Card> {
    const now = isoNow();
    const raw = input as HostedCardInput & { blocks?: unknown; done?: unknown; status?: unknown; summary?: unknown };
    const existing = this.state.cards[raw.id];
    const card = normalizeCard({
      ...raw,
      id: raw.id,
      feedId: this.state.config.id,
      kind: input.kind ?? existing?.kind ?? "attention",
      status: normalizeCardStatus(raw.status, raw.done, existing?.status),
      eyebrow: input.eyebrow ?? existing?.eyebrow ?? this.state.config.name,
      title: input.title,
      why: input.why ?? (typeof raw.summary === "string" ? raw.summary : existing?.why ?? ""),
      sourceMailbox: input.sourceMailbox ?? existing?.sourceMailbox,
      blocks: normalizeCardBlocks(raw.blocks, existing?.blocks),
      proposedAction: input.proposedAction ?? existing?.proposedAction,
      actions: input.actions ?? existing?.actions,
      readyForPass: input.readyForPass ?? existing?.readyForPass ?? this.state.config.currentPass,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      completedAt: input.completedAt ?? (raw.done === true || raw.status === "done" ? now : existing?.completedAt),
      routineActionGroupId: input.routineActionGroupId ?? (raw.status === "to_review_new" || raw.status === "to_review_updated" ? undefined : existing?.routineActionGroupId),
      sweep: input.sweep ?? existing?.sweep,
      history: existing?.history ?? [],
    } as Card);
    this.state.cards[card.id] = card;
    return { state: this.state, result: card, event: event(this.state, { cardId: card.id, type: existing ? "card.updated" : "card.created" }) };
  }

  recordVoiceTargetChange(requested: VoiceTarget): FeedMutation<VoiceTarget> {
    const target = this.validateVoiceTarget(requested);
    return { state: this.state, result: target, event: event(this.state, { type: "voice.target_changed", detail: { requested, target } }) };
  }

  submitVoiceInstruction(requested: VoiceTarget, instruction: string): FeedMutation<{ kind: "scoped_work"; target: VoiceTarget; work: WorkItem; trace?: SweepFeedbackTrace }> {
    if (!instruction.trim()) throw new Error("Instruction is required.");
    const target = this.validateVoiceTarget(requested);
    if (target.kind === "sweep") {
      const visibleCardIds = Object.values(this.state.cards)
        .filter((card) =>
          (card.status === "to_review_new" || card.status === "to_review_updated") &&
          card.readyForPass <= this.state.config.currentPass &&
          !card.sweep?.hidden &&
          !card.routineActionGroupId
        )
        .map((card) => card.id);
      const trace: SweepFeedbackTrace = {
        id: makeId("sweep_feedback"),
        feedId: this.state.config.id,
        ...(target.batchId ? { batchId: target.batchId } : {}),
        instruction: instruction.trim(),
        visibleCardIds,
        orderedCardIds: [],
        removedCardIds: [],
        createdAt: isoNow(),
      };
      const work = queuedWork(this.state, "__feed__", instruction, {
        kind: "scoped_instruction",
        target,
        intent: "sweep_rejudge",
        feedbackId: trace.id,
        startingBatchId: target.batchId ?? null,
        previousSweepState: this.state.sweep,
      });
      this.state.sweepFeedback[trace.id] = trace;
      this.state.work[work.id] = work;
      this.state.sweep = { ...this.state.sweep, lastFeedbackId: trace.id, recollectionOffered: false, statusMessage: "Feedback queued for Codex" };
      return { state: this.state, result: { kind: "scoped_work", target, work, trace }, event: event(this.state, { workId: work.id, type: "voice.intent_queued", detail: { target, intent: work.intent } }) };
    }
    const cardId = target.kind === "card" ? target.cardId : "__feed__";
    const work = queuedWork(this.state, cardId, instruction, { kind: "scoped_instruction", target, intent: "voice_instruction" });
    if (target.kind === "card") {
      const card = this.state.cards[target.cardId];
      if (!card) throw new Error("Card not found.");
      if (card.status === "done") throw new Error("Done cards cannot be queued.");
      card.status = "queued";
      appendHistory(card, "user.scoped_instruction", instruction.trim());
    }
    this.state.work[work.id] = work;
    return { state: this.state, result: { kind: "scoped_work", target, work }, event: event(this.state, { cardId, workId: work.id, type: "voice.intent_queued", detail: { target, intent: work.intent } }) };
  }

  proposeRevision(target: VoiceTarget, instruction: string, next: string, source: RevisionProposal["source"] = "voice"): FeedMutation<RevisionProposal> {
    if (!instruction.trim()) throw new Error("Revision instruction is required.");
    if (!next.trim()) throw new Error("Proposed revision content is required.");
    const validated = this.validateVoiceTarget(target);
    if (validated.kind === "card" || validated.kind === "sweep") throw new Error("This target routes to work or sweep feedback, not a revision proposal.");
    const proposal: RevisionProposal = {
      id: makeId("proposal"),
      anchorFeedId: this.state.config.id,
      target: validated,
      label: revisionLabel(validated),
      instruction: instruction.trim(),
      previous: this.readTargetContent(validated),
      next: next.trim(),
      source,
      status: "proposed",
      createdAt: isoNow(),
    };
    this.state.revisionProposals[proposal.id] = proposal;
    return { state: this.state, result: proposal, event: event(this.state, { type: "revision.proposed", detail: { proposalId: proposal.id, target: validated } }) };
  }

  updateRevisionProposal(proposalId: string, next: string): FeedMutation<RevisionProposal> {
    if (!next.trim()) throw new Error("Proposed revision content is required.");
    const proposal = this.state.revisionProposals[proposalId];
    if (!proposal) throw new Error("Revision proposal not found.");
    if (proposal.status !== "proposed") throw new Error("Revision proposal is no longer pending.");
    proposal.next = next.trim();
    proposal.updatedAt = isoNow();
    return { state: this.state, result: proposal, event: event(this.state, { type: "revision.proposal_updated", detail: { proposalId, target: proposal.target } }) };
  }

  applyRevisionProposal(proposalId: string): FeedMutation<WorkspaceRevision> {
    const proposal = this.state.revisionProposals[proposalId];
    if (!proposal) throw new Error("Revision proposal not found.");
    if (proposal.status !== "proposed") throw new Error("Revision proposal is no longer pending.");
    const current = this.readTargetContent(proposal.target);
    if (current.trimEnd() !== proposal.previous.trimEnd()) throw new Error("Workspace content changed after this proposal. Review a fresh diff.");
    const revision: WorkspaceRevision = {
      id: makeId("revision"),
      anchorFeedId: proposal.anchorFeedId,
      target: proposal.target,
      previous: proposal.previous,
      next: proposal.next,
      reason: proposal.instruction,
      source: "voice_proposal",
      status: "applied",
      createdAt: isoNow(),
    };
    this.writeTargetContent(proposal.target, proposal.next);
    this.state.workspaceRevisions[revision.id] = revision;
    proposal.status = "applied";
    proposal.appliedAt = isoNow();
    proposal.appliedRevisionId = revision.id;
    return { state: this.state, result: revision, event: event(this.state, { type: "revision.applied", detail: { revisionId: revision.id, target: revision.target, source: revision.source } }) };
  }

  rejectRevisionProposal(proposalId: string): FeedMutation<RevisionProposal> {
    const proposal = this.state.revisionProposals[proposalId];
    if (!proposal) throw new Error("Revision proposal not found.");
    if (proposal.status !== "proposed") throw new Error("Revision proposal is no longer pending.");
    proposal.status = "rejected";
    proposal.rejectedAt = isoNow();
    return { state: this.state, result: proposal, event: event(this.state, { type: "revision.rejected", detail: { proposalId, target: proposal.target } }) };
  }

  revertWorkspaceRevision(revisionId: string): FeedMutation<WorkspaceRevision> {
    const revision = this.state.workspaceRevisions[revisionId];
    if (!revision) throw new Error("Workspace revision not found.");
    if (revision.status !== "applied") throw new Error("Workspace revision is not active.");
    const current = this.readTargetContent(revision.target);
    if (current.trimEnd() !== revision.next.trimEnd()) throw new Error("Workspace content changed after this revision. Undo the newest revision first.");
    revision.status = "reverted";
    revision.revertedAt = isoNow();
    this.writeTargetContent(revision.target, revision.previous);
    return { state: this.state, result: revision, event: event(this.state, { type: "revision.reverted", detail: { revisionId, target: revision.target } }) };
  }

  listRevisionProposals(): RevisionProposal[] {
    return Object.values(this.state.revisionProposals).filter((proposal) => proposal.status === "proposed").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  recordSourceRun(sourceId: string, snapshots: unknown[], judgments: unknown[], checkpoint: unknown, triggerWorkId?: string): FeedMutation<string> {
    if (!this.state.sources.some((source) => source.id === sourceId)) throw new Error(`Source recipe not found: ${sourceId}`);
    if (triggerWorkId) this.assertClaimedRecollectionWork(triggerWorkId);
    const runId = makeId("run");
    this.state.runs[runId] = { id: runId, feedId: this.state.config.id, sourceId, snapshots, judgments, ...(triggerWorkId ? { triggerWorkId } : {}), completedAt: isoNow() };
    this.state.checkpoints[sourceId] = checkpoint ?? {};
    return { state: this.state, result: runId, event: event(this.state, { workId: triggerWorkId, type: "source.run_completed", detail: { runId, sourceId, triggerWorkId, snapshots: snapshots.length, judgments: judgments.length } }) };
  }

  recordSweepBatch(sourceRunIds: string[], triggerWorkId?: string): FeedMutation<string> {
    if (!Array.isArray(sourceRunIds) || sourceRunIds.some((runId) => typeof runId !== "string" || !runId.trim())) throw new Error("Sweep batch source run IDs must be non-empty strings.");
    if (new Set(sourceRunIds).size !== sourceRunIds.length) throw new Error("Sweep batch source run IDs must be unique.");
    const triggerWork = triggerWorkId ? this.assertClaimedRecollectionWork(triggerWorkId) : null;
    if (triggerWork && sourceRunIds.length === 0) throw new Error("Source recollection must record at least one source run.");
    for (const runId of sourceRunIds) {
      const run = this.state.runs[runId] as { id?: string; feedId?: string; triggerWorkId?: string; completedAt?: string } | undefined;
      if (!run) throw new Error(`Source run not found for this feed: ${runId}`);
      if (run.id !== runId || run.feedId !== this.state.config.id) throw new Error(`Source run does not belong to this feed: ${runId}`);
      if (triggerWork && run.triggerWorkId !== triggerWork.id) throw new Error(`Source run was not recorded for this recollection work: ${runId}`);
      if (triggerWork && (!run.completedAt || run.completedAt < triggerWork.createdAt)) throw new Error(`Source run predates this recollection work: ${runId}`);
    }
    const batchId = makeId("batch");
    this.state.sweepBatches[batchId] = { id: batchId, feedId: this.state.config.id, sourceRunIds, ...(triggerWorkId ? { triggerWorkId } : {}), createdAt: isoNow() };
    this.state.sweep = { currentBatchId: batchId, lastFeedbackId: null, recollectionOffered: false, statusMessage: null };
    return { state: this.state, result: batchId, event: event(this.state, { workId: triggerWorkId, type: "sweep.batch_recorded", detail: { batchId, sourceRunIds, triggerWorkId } }) };
  }

  recordSweepRejudgment(feedbackId: string, orderedCardIds: string[], removedCardIds: string[]): FeedMutation<SweepFeedbackTrace> {
    const work = Object.values(this.state.work).find((item) => item.intent === "sweep_rejudge" && item.feedbackId === feedbackId);
    if (!work || work.status !== "working") throw new Error("Sweep feedback must be claimed before rejudgment write-back.");
    const trace = this.state.sweepFeedback[feedbackId];
    if (!trace) throw new Error("Sweep feedback trace not found.");
    if (trace.rejudgedAt) throw new Error("Sweep feedback has already been rejudged.");
    if ((trace.batchId ?? null) !== this.state.sweep.currentBatchId) throw new Error("Sweep feedback is stale because a newer batch is active.");
    const combined = [...orderedCardIds, ...removedCardIds];
    const expected = new Set(trace.visibleCardIds);
    if (new Set(combined).size !== combined.length || combined.length !== expected.size || combined.some((cardId) => !expected.has(cardId))) {
      throw new Error("Sweep rejudgment must account for each visible card exactly once.");
    }
    for (const [rank, cardId] of combined.entries()) {
      const card = this.state.cards[cardId];
      if (!card) throw new Error(`Sweep card not found: ${cardId}`);
      card.sweep = { rank, hidden: removedCardIds.includes(card.id), feedbackId: trace.id };
      appendHistory(card, card.sweep.hidden ? "sweep.feedback_hidden" : "sweep.feedback_ranked", trace.id);
    }
    trace.orderedCardIds = orderedCardIds;
    trace.removedCardIds = removedCardIds;
    trace.rejudgedAt = isoNow();
    this.state.sweep = {
      ...this.state.sweep,
      lastFeedbackId: trace.id,
      recollectionOffered: true,
      statusMessage: removedCardIds.length ? `${removedCardIds.length} card${removedCardIds.length === 1 ? "" : "s"} removed` : "Cards reranked",
    };
    return { state: this.state, result: trace, event: event(this.state, { workId: work.id, type: "sweep.rejudged", detail: { feedbackId: trace.id, orderedCardIds, removedCardIds } }) };
  }

  requestSweepRecollection(): FeedMutation<WorkItem> {
    const existing = Object.values(this.state.work).find((work) => work.intent === "recollect_sources" && (work.status === "queued" || work.status === "working"));
    if (existing) return { state: this.state, result: existing };
    if (!this.state.sweep.recollectionOffered) throw new Error("Search sources again is not currently offered.");
    const target: VoiceTarget = { kind: "sweep", feedId: this.state.config.id, ...(this.state.sweep.currentBatchId ? { batchId: this.state.sweep.currentBatchId } : {}) };
    const work = queuedWork(this.state, "__feed__", "Search the configured sources again, record source runs, judge a new sweep batch, and write back the refreshed cards.", {
      kind: "scoped_instruction",
      target,
      intent: "recollect_sources",
      ...(this.state.sweep.lastFeedbackId ? { feedbackId: this.state.sweep.lastFeedbackId } : {}),
      startingBatchId: this.state.sweep.currentBatchId,
    });
    this.state.work[work.id] = work;
    this.state.sweep = { ...this.state.sweep, recollectionOffered: false, statusMessage: "Source search queued" };
    return { state: this.state, result: work, event: event(this.state, { workId: work.id, type: "sweep.recollection_requested", detail: { feedbackId: work.feedbackId } }) };
  }

  upsertRoutineActionGroup(input: Pick<RoutineActionGroup, "id" | "label" | "summary" | "proposedAction" | "items">): FeedMutation<RoutineActionGroup> {
    if (!input.id.trim() || !input.label.trim() || !input.summary.trim()) throw new Error("Routine action group id, label, and summary are required.");
    if (!input.proposedAction.label.trim() || !input.proposedAction.instruction.trim()) throw new Error("Routine action group approval needs a visible label and exact instruction.");
    if (!input.items.length) throw new Error("Routine action group needs at least one item.");
    const itemIds = input.items.map((item) => item.id);
    const cardIds = input.items.flatMap((item) => item.cardId ? [item.cardId] : []);
    if (new Set(itemIds).size !== itemIds.length) throw new Error("Routine action item IDs must be unique.");
    if (new Set(cardIds).size !== cardIds.length) throw new Error("A card cannot appear twice in one routine action group.");
    const existing = this.state.routineActions[input.id];
    if (existing && (existing.status === "queued" || existing.status === "working" || existing.status === "completed")) throw new Error("Routine action group cannot change after approval or completion.");
    for (const item of input.items) {
      if (!item.id.trim() || !item.title.trim() || !item.reason.trim()) throw new Error("Routine action items need an id, title, and reason.");
      if (!item.cardId) continue;
      const card = this.state.cards[item.cardId];
      if (!card) throw new Error(`Routine action card not found: ${item.cardId}`);
      if (card.status !== "to_review_new" && card.status !== "to_review_updated") throw new Error(`Routine action card is no longer reviewable: ${card.id}`);
      if (card.routineActionGroupId && card.routineActionGroupId !== input.id) throw new Error(`Routine action card already belongs to another group: ${card.id}`);
    }
    if (existing) this.releaseRoutineActionCards(existing, false);
    const now = isoNow();
    const group: RoutineActionGroup = {
      id: input.id.trim(),
      feedId: this.state.config.id,
      label: input.label.trim(),
      summary: input.summary.trim(),
      proposedAction: input.proposedAction,
      items: input.items.map((item) => ({ ...item, id: item.id.trim(), title: item.title.trim(), reason: item.reason.trim() })),
      status: "proposed",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    for (const item of group.items) {
      if (!item.cardId) continue;
      const card = this.state.cards[item.cardId];
      card.routineActionGroupId = group.id;
      appendHistory(card, "routine_action.proposed", group.id);
    }
    this.state.routineActions[group.id] = group;
    return { state: this.state, result: group, event: event(this.state, { type: "routine_action.proposed", detail: { groupId: group.id, items: group.items.length } }) };
  }

  approveRoutineActionGroup(groupId: string): FeedMutation<WorkItem> {
    const group = this.state.routineActions[groupId];
    if (!group) throw new Error("Routine action group not found.");
    const approvalDigest = routineActionDigest(group);
    const active = Object.values(this.state.work).filter((work) => work.kind === "routine_action_batch" && work.routineActionGroupId === groupId && (work.status === "queued" || work.status === "working"));
    const existing = active.find((work) => work.approvalDigest === approvalDigest);
    if (existing) return { state: this.state, result: existing };
    if (group.status !== "proposed") throw new Error("Routine action group is no longer waiting for approval.");
    if (active.some((work) => work.status === "working")) throw new Error("An older routine action snapshot is already in progress.");
    for (const work of active) {
      work.status = "stale";
      work.error = "Approval stale - a newer routine action snapshot was approved.";
    }
    const work = queuedWork(this.state, "__routine__", group.proposedAction.instruction, {
      kind: "routine_action_batch",
      routineActionGroupId: group.id,
      approvalDigest,
    });
    group.status = "queued";
    group.workId = work.id;
    this.state.work[work.id] = work;
    return { state: this.state, result: work, event: event(this.state, { workId: work.id, type: "routine_action.approved", detail: { groupId: group.id, approvalDigest, items: group.items.length } }) };
  }

  private validateVoiceTarget(target: VoiceTarget): VoiceTarget {
    if (target.kind === "attention" || target.kind === "global_prompt") return target;
    if ("feedId" in target && target.feedId !== this.state.config.id) return { kind: "attention" };
    if (target.kind === "feed") return target;
    if (target.kind === "sweep") return { kind: "sweep", feedId: this.state.config.id, ...(this.state.sweep.currentBatchId ? { batchId: this.state.sweep.currentBatchId } : {}) };
    if (target.kind === "card") return this.state.cards[target.cardId] ? target : { kind: "sweep", feedId: this.state.config.id, ...(this.state.sweep.currentBatchId ? { batchId: this.state.sweep.currentBatchId } : {}) };
    if (target.kind === "source_recipe") return this.state.sources.some((source) => source.id === target.sourceId) ? target : { kind: "feed", feedId: this.state.config.id };
    if (target.kind === "prompt_layer") return FEED_PROMPT_NAMES.includes(target.promptId) ? target : { kind: "feed", feedId: this.state.config.id };
    return target;
  }

  private readTargetContent(target: VoiceTarget): string {
    if (target.kind === "feed") return this.state.policy;
    if (target.kind === "source_recipe") {
      const source = this.state.sources.find((item) => item.id === target.sourceId) as SourceRecipe & { content?: string } | undefined;
      if (!source) throw new Error(`Source recipe not found: ${target.sourceId}`);
      return source.content ?? source.summary;
    }
    if (target.kind === "prompt_layer") return this.state.prompts[target.promptId] ?? "";
    throw new Error("This target does not contain editable feed content.");
  }

  private writeTargetContent(target: VoiceTarget, content: string): void {
    const normalized = content.replace(/\\n/g, "\n").trim();
    if (!normalized) throw new Error("Workspace content is required.");
    if (target.kind === "feed") {
      this.state.policy = normalized;
      return;
    }
    if (target.kind === "source_recipe") {
      const source = this.state.sources.find((item) => item.id === target.sourceId) as SourceRecipe & { content?: string } | undefined;
      if (!source) throw new Error(`Source recipe not found: ${target.sourceId}`);
      source.content = normalized;
      return;
    }
    if (target.kind === "prompt_layer") {
      if (!FEED_PROMPT_NAMES.includes(target.promptId)) throw new Error(`Unknown feed prompt: ${target.promptId}`);
      this.state.prompts[target.promptId] = normalized;
      return;
    }
    throw new Error("This target does not contain editable feed content.");
  }

  private assertClaimedRecollectionWork(workId: string): WorkItem {
    const work = this.state.work[workId];
    if (!work || work.feedId !== this.state.config.id || work.intent !== "recollect_sources" || work.status !== "working") {
      throw new Error("Source recollection must be recorded for the claimed same-feed recollection work item.");
    }
    return work;
  }

  private releaseRoutineActionCards(group: RoutineActionGroup, returnForReview: boolean): void {
    for (const item of group.items) {
      if (!item.cardId) continue;
      const card = this.state.cards[item.cardId];
      if (!card || card.routineActionGroupId !== group.id) continue;
      card.routineActionGroupId = undefined;
      if (returnForReview && card.status !== "done") {
        card.status = "to_review_updated";
        card.readyForPass = this.state.config.currentPass;
      }
    }
  }

  private restoreAbandonedSweepFeedback(abandoned: WorkItem): void {
    const currentBatchId = this.state.sweep.currentBatchId;
    const byFeedbackId = new Map(Object.values(this.state.work).filter((work) => work.intent === "sweep_rejudge" && work.feedbackId).map((work) => [work.feedbackId as string, work]));
    const cleared = { currentBatchId, lastFeedbackId: null, recollectionOffered: false, statusMessage: null };
    let previous = abandoned.previousSweepState;
    const visited = new Set<string>([abandoned.id]);
    while (previous?.lastFeedbackId) {
      const work = byFeedbackId.get(previous.lastFeedbackId);
      if (!work || visited.has(work.id)) {
        previous = undefined;
        break;
      }
      visited.add(work.id);
      if (work.status === "queued" || work.status === "working" || (work.status === "completed" && previous.recollectionOffered)) {
        this.state.sweep = { ...previous, currentBatchId };
        return;
      }
      previous = work.previousSweepState;
    }
    this.state.sweep = previous ? { ...previous, currentBatchId } : cleared;
  }
}
