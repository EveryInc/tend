import type {
  AppFeedback,
  Card,
  CardAction,
  CardBlock,
  FeedConfig,
  FeedView,
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
} from "../shared/types";
import { AttentionStore, FEED_PROMPT_NAMES } from "./store";
import { demoCards, feedConfig } from "./templates";
import { detectMonologue } from "./monologue";
import { isoNow, makeId, makeToken, slugify } from "./util";
import { actionDigest, cleanupDigest, configuredApprovalAction, requiredSourceMailbox, routineActionDigest, verifySourceMailbox } from "./workflow/approvals";
import { queuedWork } from "./workflow/workItems";

function appendHistory(card: Card, type: string, detail?: string): void {
  card.history.push({ at: isoNow(), type, detail });
}

const INBOX_DEMO_REPLAY_SOURCE_IDS: Record<string, string> = {
  "demo-inbox-partnership": "gmail-thread-19e8570055b2e4ed",
  "demo-inbox-investor-followup": "gmail-thread-19e0f349c4e9039f",
  "demo-inbox-scheduling": "gmail-thread-195952aa242e973c",
  "demo-inbox-delegation": "gmail-thread-19e8496ed12388f3",
  "demo-inbox-attachment": "gmail-thread-19e6ad9592b6f462",
  "demo-inbox-routine-cleanup": "gmail-thread-19e7434a384dfe39",
  "demo-inbox-intro": "gmail-thread-19e85140ab834ad2",
};

function sourceRecipeFromBrief(brief: string): { recipe: SourceRecipe; markdown: string } {
  const normalizedBrief = brief.replace(/\\n/g, "\n").trim();
  const firstLine = normalizedBrief.split("\n")[0]?.replace(/^#+\s*/, "") || "New source";
  const id = slugify(firstLine);
  const recipe: SourceRecipe = {
    id,
    name: firstLine.slice(0, 80),
    filename: `${id}.md`,
    checkpointFilename: `${id}.json`,
    summary: normalizedBrief,
  };
  return {
    recipe,
    markdown: `---
id: ${id}
kind: codex-recipe
checkpoint: ${id}.json
---
# ${recipe.name}

${normalizedBrief}

Preserve timestamps, locators, and content hashes in immutable local raw snapshots. Advance the
checkpoint only after the run record is durable. Return no candidate rather than padding.
`,
  };
}

function revisionLabel(target: VoiceTarget): string {
  if (target.kind === "feed") return "Feed policy";
  if (target.kind === "source_recipe") return `Source recipe · ${target.sourceId}`;
  if (target.kind === "prompt_layer") return `Feed prompt · ${target.promptId}`;
  if (target.kind === "global_prompt") return `Global prompt · ${target.promptId}`;
  return "Attention policy";
}

const CARD_BLOCK_TYPES = new Set<CardBlock["type"]>([
  "rich_text",
  "evidence",
  "editable_text",
  "memo",
  "options",
  "checklist",
  "diff",
  "clarification",
  "email_thread",
  "profile",
  "video",
  "chart",
  "receipt",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function blockDescription(block: Record<string, unknown>, index: number): string {
  const type = typeof block.type === "string" ? block.type : "unknown type";
  const id = typeof block.id === "string" && block.id.trim() ? ` "${block.id}"` : "";
  return `Card block ${index + 1} (${type}${id})`;
}

function validateTextBlock(block: Record<string, unknown>, index: number, hint?: string): void {
  if (hasText(block.text)) return;
  throw new Error(`${blockDescription(block, index)} needs a non-empty \`text\` string.${hint ? ` ${hint}` : ""}`);
}

function validateListBlock(block: Record<string, unknown>, index: number): void {
  if (!Array.isArray(block.items) || !block.items.length) {
    throw new Error(`${blockDescription(block, index)} needs a non-empty \`items\` array.`);
  }
  for (const [itemIndex, item] of block.items.entries()) {
    if (hasText(item)) continue;
    if (!isRecord(item) || !hasText(item.label)) {
      throw new Error(`${blockDescription(block, index)} item ${itemIndex + 1} must be a non-empty string or an object with a non-empty \`label\`.`);
    }
    if (item.detail !== undefined && typeof item.detail !== "string") {
      throw new Error(`${blockDescription(block, index)} item ${itemIndex + 1} has a non-string \`detail\`.`);
    }
    if (item.checked !== undefined && typeof item.checked !== "boolean") {
      throw new Error(`${blockDescription(block, index)} item ${itemIndex + 1} has a non-boolean \`checked\`.`);
    }
  }
}

function validateCardBlocks(blocks: unknown): asserts blocks is CardBlock[] {
  if (!Array.isArray(blocks)) throw new Error("Card blocks must be an array.");
  const ids = new Set<string>();
  for (const [index, block] of blocks.entries()) {
    if (!isRecord(block)) throw new Error(`Card block ${index + 1} must be an object.`);
    if (!hasText(block.id)) throw new Error(`${blockDescription(block, index)} needs a non-empty \`id\` string.`);
    if (ids.has(block.id)) throw new Error(`${blockDescription(block, index)} repeats block id "${block.id}". Block ids must be unique within a card.`);
    ids.add(block.id);
    if (typeof block.type !== "string" || !CARD_BLOCK_TYPES.has(block.type as CardBlock["type"])) {
      throw new Error(`${blockDescription(block, index)} has an unsupported \`type\`.`);
    }
    if (block.label !== undefined && typeof block.label !== "string") {
      throw new Error(`${blockDescription(block, index)} has a non-string \`label\`.`);
    }
    switch (block.type) {
      case "memo":
        validateTextBlock(block, index, "Use `text`, not `title` or `body`.");
        break;
      case "receipt":
        validateTextBlock(block, index, "Put source links in `text` using Markdown link syntax, not a loose `url` field.");
        break;
      case "rich_text":
      case "clarification":
      case "email_thread":
        validateTextBlock(block, index);
        break;
      case "evidence":
      case "options":
      case "checklist":
        validateListBlock(block, index);
        break;
      case "editable_text":
        if (typeof block.value !== "string") throw new Error(`${blockDescription(block, index)} needs a string \`value\`.`);
        break;
      case "diff":
        if (typeof block.before !== "string" || typeof block.after !== "string") {
          throw new Error(`${blockDescription(block, index)} needs string \`before\` and \`after\` values.`);
        }
        break;
      case "profile":
        if (
          !isRecord(block.profile) ||
          !hasText(block.profile.name) ||
          !hasText(block.profile.href) ||
          !hasText(block.profile.imageUrl)
        ) {
          throw new Error(`${blockDescription(block, index)} needs \`profile.name\`, \`profile.href\`, and \`profile.imageUrl\` strings.`);
        }
        if (block.profile.links !== undefined) {
          if (!Array.isArray(block.profile.links) || block.profile.links.some((link) => !isRecord(link) || !hasText(link.label) || !hasText(link.href))) {
            throw new Error(`${blockDescription(block, index)} profile links need non-empty \`label\` and \`href\` strings.`);
          }
        }
        break;
      case "video":
        if (!isRecord(block.video) || !hasText(block.video.title) || !hasText(block.video.href)) {
          throw new Error(`${blockDescription(block, index)} needs \`video.title\` and \`video.href\` strings.`);
        }
        break;
      case "chart":
        if (!isRecord(block.chart) || typeof block.chart.max !== "number" || !Number.isFinite(block.chart.max) || block.chart.max <= 0) {
          throw new Error(`${blockDescription(block, index)} needs a positive numeric \`chart.max\`.`);
        }
        const max = block.chart.max;
        if (
          !Array.isArray(block.chart.series) ||
          block.chart.series.length !== 2 ||
          block.chart.series.some((series) => !isRecord(series) || !hasText(series.label))
        ) {
          throw new Error(`${blockDescription(block, index)} needs exactly two \`chart.series\` entries with non-empty \`label\` strings.`);
        }
        if (!Array.isArray(block.chart.rows) || !block.chart.rows.length) {
          throw new Error(`${blockDescription(block, index)} needs a non-empty \`chart.rows\` array.`);
        }
        for (const [rowIndex, row] of block.chart.rows.entries()) {
          if (
            !isRecord(row) ||
            !hasText(row.label) ||
            !Array.isArray(row.values) ||
            row.values.length !== 2 ||
            row.values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max)
          ) {
            throw new Error(`${blockDescription(block, index)} chart row ${rowIndex + 1} needs a non-empty \`label\` and exactly two numeric \`values\` between 0 and \`chart.max\`.`);
          }
          if (row.detail !== undefined && typeof row.detail !== "string") {
            throw new Error(`${blockDescription(block, index)} chart row ${rowIndex + 1} has a non-string \`detail\`.`);
          }
        }
        if (block.chart.unit !== undefined && typeof block.chart.unit !== "string") {
          throw new Error(`${blockDescription(block, index)} has a non-string \`chart.unit\`.`);
        }
        if (block.chart.note !== undefined && typeof block.chart.note !== "string") {
          throw new Error(`${blockDescription(block, index)} has a non-string \`chart.note\`.`);
        }
        break;
    }
  }
}

export class AttentionDomain {
  constructor(readonly store: AttentionStore) {}

  private async releaseRoutineActionCards(group: RoutineActionGroup, returnForReview: boolean): Promise<void> {
    const config = returnForReview ? await this.store.readConfig(group.feedId) : null;
    for (const item of group.items) {
      if (!item.cardId) continue;
      const card = await this.store.readCard(group.feedId, item.cardId);
      if (card.routineActionGroupId !== group.id) continue;
      card.routineActionGroupId = undefined;
      if (returnForReview && card.status !== "done") {
        card.status = "to_review_updated";
        card.readyForPass = config?.currentPass ?? card.readyForPass;
      }
      await this.store.writeCard(card);
    }
  }

  private async quarantineLegacyMutationWork(feed: FeedView, work: WorkItem): Promise<boolean> {
    if (
      work.approvalDigest ||
      (work.kind !== "execute_approved_action" && work.kind !== "default_cleanup" && work.kind !== "routine_action_batch")
    ) {
      return false;
    }
    work.status = "stale";
    work.error = "Approval stale - this action predates digest-bound approval. Review and approve it again.";
    await this.store.writeWork(work);
    if (work.kind === "routine_action_batch" && work.routineActionGroupId) {
      const group = await this.store.readRoutineActionGroup(feed.config.id, work.routineActionGroupId);
      group.status = "stale";
      group.error = work.error;
      await this.releaseRoutineActionCards(group, true);
      await this.store.writeRoutineActionGroup(group);
    } else if (work.cardId !== "__feed__") {
      const card = await this.store.readCard(feed.config.id, work.cardId);
      card.status = "to_review_updated";
      card.readyForPass = feed.config.currentPass;
      appendHistory(card, "codex.stale_approval", work.id);
      await this.store.writeCard(card);
    }
    await this.store.appendEvent({ feedId: feed.config.id, cardId: work.cardId, workId: work.id, type: "action.stale", detail: { reason: work.error } });
    return true;
  }

  async detectLocalMonologue(options: { appPath?: string; settingsPath?: string } = {}) {
    const capability = await detectMonologue(options);
    await this.store.serialize(() => this.store.writeDictationCapability(capability));
    return capability;
  }

  async recordVoiceTargetChange(anchorFeedId: string, requested: VoiceTarget): Promise<VoiceTarget> {
    const target = await this.store.validateVoiceTarget(requested);
    await this.store.serialize(() => this.store.appendEvent({ feedId: anchorFeedId, type: "voice.target_changed", detail: { requested, target } }));
    return target;
  }

  async submitVoiceInstruction(anchorFeedId: string, requested: VoiceTarget, instruction: string) {
    if (!instruction.trim()) throw new Error("Instruction is required.");
    const target = await this.store.validateVoiceTarget(requested);
    return this.store.serialize(async () => {
      await this.store.appendEvent({ feedId: anchorFeedId, type: "voice.instruction_submitted", detail: { target, instruction: instruction.trim() } });
      if (target.kind === "sweep") {
        const feed = await this.store.readFeed(target.feedId);
        const visibleCardIds = feed.cards
          .filter((card) =>
            (card.status === "to_review_new" || card.status === "to_review_updated") &&
            card.readyForPass <= feed.config.currentPass &&
            !card.sweep?.hidden &&
            !card.routineActionGroupId
          )
          .map((card) => card.id);
        const trace: SweepFeedbackTrace = {
          id: makeId("sweep_feedback"),
          feedId: target.feedId,
          ...(target.batchId ? { batchId: target.batchId } : {}),
          instruction: instruction.trim(),
          visibleCardIds,
          orderedCardIds: [],
          removedCardIds: [],
          createdAt: isoNow(),
        };
        const work = queuedWork(target.feedId, "__feed__", instruction, {
          kind: "scoped_instruction",
          target,
          intent: "sweep_rejudge",
          feedbackId: trace.id,
          startingBatchId: target.batchId ?? null,
          previousSweepState: feed.sweep,
        });
        await this.store.writeSweepFeedback(trace);
        await this.store.writeWork(work);
        await this.store.writeSweepState(target.feedId, {
          ...feed.sweep,
          lastFeedbackId: trace.id,
          recollectionOffered: false,
          statusMessage: "Feedback queued for Codex",
        });
        await this.store.appendEvent({ feedId: target.feedId, workId: work.id, type: "sweep.feedback_recorded", detail: { feedbackId: trace.id, batchId: trace.batchId, instruction: trace.instruction } });
        await this.store.appendEvent({ feedId: target.feedId, workId: work.id, type: "voice.intent_queued", detail: { target, intent: work.intent } });
        return { kind: "scoped_work" as const, target, work, trace };
      }

      const feedId = "feedId" in target ? target.feedId : anchorFeedId;
      const cardId = target.kind === "card" ? target.cardId : "__feed__";
      const work = queuedWork(feedId, cardId, instruction, { kind: "scoped_instruction", target, intent: "voice_instruction" });
      if (target.kind === "card") {
        const card = await this.store.readCard(feedId, target.cardId);
        if (card.status === "done") throw new Error("Done cards cannot be queued.");
        card.status = "queued";
        appendHistory(card, "user.scoped_instruction", instruction.trim());
        await this.store.writeCard(card);
      }
      await this.store.writeWork(work);
      await this.store.appendEvent({ feedId, cardId, workId: work.id, type: "voice.intent_queued", detail: { target, intent: work.intent } });
      return { kind: "scoped_work" as const, target, work };
    });
  }

  async recordSweepRejudgment(feedId: string, feedbackId: string, orderedCardIds: string[], removedCardIds: string[]): Promise<SweepFeedbackTrace> {
    return this.store.serialize(async () => {
      const feed = await this.store.readFeed(feedId);
      const work = feed.work.find((item) => item.intent === "sweep_rejudge" && item.feedbackId === feedbackId);
      if (!work || work.status !== "working") throw new Error("Sweep feedback must be claimed before rejudgment write-back.");
      const trace = await this.store.readSweepFeedback(feedId, feedbackId);
      if (trace.rejudgedAt) throw new Error("Sweep feedback has already been rejudged.");
      const sweep = await this.store.readSweepState(feedId);
      if ((trace.batchId ?? null) !== sweep.currentBatchId) {
        work.status = "stale";
        work.error = "Sweep feedback is stale because a newer batch is active.";
        await this.store.writeWork(work);
        if (sweep.lastFeedbackId === feedbackId) await this.restoreAbandonedSweepFeedback(feedId, sweep.currentBatchId, work);
        await this.store.appendEvent({ feedId, workId: work.id, type: "sweep.feedback_stale", detail: { feedbackId, activeBatchId: sweep.currentBatchId, feedbackBatchId: trace.batchId ?? null } });
        await this.store.appendEvent({ feedId, cardId: work.cardId, workId: work.id, type: "work.stale", detail: { reason: work.error } });
        throw new Error(work.error);
      }
      const combined = [...orderedCardIds, ...removedCardIds];
      const expected = new Set(trace.visibleCardIds);
      if (new Set(combined).size !== combined.length || combined.length !== expected.size || combined.some((cardId) => !expected.has(cardId))) {
        throw new Error("Sweep rejudgment must account for each visible card exactly once.");
      }
      for (const [rank, cardId] of combined.entries()) {
        const card = await this.store.readCard(feedId, cardId);
        card.sweep = { rank, hidden: removedCardIds.includes(card.id), feedbackId: trace.id };
        appendHistory(card, card.sweep.hidden ? "sweep.feedback_hidden" : "sweep.feedback_ranked", trace.id);
        await this.store.writeCard(card);
      }
      trace.orderedCardIds = orderedCardIds;
      trace.removedCardIds = removedCardIds;
      trace.rejudgedAt = isoNow();
      await this.store.writeSweepFeedback(trace);
      await this.store.writeSweepState(feedId, {
        ...sweep,
        lastFeedbackId: trace.id,
        recollectionOffered: true,
        statusMessage: removedCardIds.length
          ? `${removedCardIds.length} card${removedCardIds.length === 1 ? "" : "s"} removed`
          : "Cards reranked",
      });
      await this.store.appendEvent({ feedId, workId: work.id, type: "sweep.rejudged", detail: { feedbackId: trace.id, orderedCardIds, removedCardIds } });
      await this.store.appendEvent({ feedId, workId: work.id, type: "sweep.recollection_offered", detail: { feedbackId: trace.id } });
      return trace;
    });
  }

  async requestSweepRecollection(feedId: string): Promise<WorkItem> {
    return this.store.serialize(async () => {
      const feed = await this.store.readFeed(feedId);
      const existing = feed.work.find((work) => work.intent === "recollect_sources" && (work.status === "queued" || work.status === "working"));
      if (existing) return existing;
      const sweep = feed.sweep;
      if (!sweep.recollectionOffered) throw new Error("Search sources again is not currently offered.");
      const target: VoiceTarget = { kind: "sweep", feedId, ...(sweep.currentBatchId ? { batchId: sweep.currentBatchId } : {}) };
      const work = queuedWork(feedId, "__feed__", "Search the configured sources again, record source runs, judge a new sweep batch, and write back the refreshed cards.", {
        kind: "scoped_instruction",
        target,
        intent: "recollect_sources",
        ...(sweep.lastFeedbackId ? { feedbackId: sweep.lastFeedbackId } : {}),
        startingBatchId: sweep.currentBatchId,
      });
      await this.store.writeWork(work);
      await this.store.writeSweepState(feedId, { ...sweep, recollectionOffered: false, statusMessage: "Source search queued" });
      await this.store.appendEvent({ feedId, workId: work.id, type: "sweep.recollection_requested", detail: { feedbackId: sweep.lastFeedbackId } });
      return work;
    });
  }

  async proposeRevision(anchorFeedId: string, requested: VoiceTarget, instruction: string, next: string, source: RevisionProposal["source"] = "voice"): Promise<RevisionProposal> {
    if (!instruction.trim()) throw new Error("Revision instruction is required.");
    if (!next.trim()) throw new Error("Proposed revision content is required.");
    const target = await this.store.validateVoiceTarget(requested);
    if (target.kind === "card" || target.kind === "sweep") throw new Error("This target routes to work or sweep feedback, not a revision proposal.");
    return this.store.serialize(async () => {
      const previous = await this.store.readTargetContent(target);
      const proposal: RevisionProposal = {
        id: makeId("proposal"),
        anchorFeedId,
        target,
        label: revisionLabel(target),
        instruction: instruction.trim(),
        previous,
        next: next.trim(),
        source,
        status: "proposed",
        createdAt: isoNow(),
      };
      await this.store.writeRevisionProposal(proposal);
      await this.store.appendEvent({ feedId: anchorFeedId, type: "revision.proposed", detail: { proposalId: proposal.id, target } });
      return proposal;
    });
  }

  async updateRevisionProposal(proposalId: string, next: string): Promise<RevisionProposal> {
    if (!next.trim()) throw new Error("Proposed revision content is required.");
    return this.store.serialize(async () => {
      const proposal = await this.store.readRevisionProposal(proposalId);
      if (proposal.status !== "proposed") throw new Error("Revision proposal is no longer pending.");
      proposal.next = next.trim();
      proposal.updatedAt = isoNow();
      await this.store.writeRevisionProposal(proposal);
      await this.store.appendEvent({ feedId: proposal.anchorFeedId, type: "revision.proposal_updated", detail: { proposalId, target: proposal.target } });
      return proposal;
    });
  }

  async applyRevisionProposal(proposalId: string): Promise<WorkspaceRevision> {
    return this.store.serialize(async () => {
      const proposal = await this.store.readRevisionProposal(proposalId);
      if (proposal.status !== "proposed") throw new Error("Revision proposal is no longer pending.");
      const current = await this.store.readTargetContent(proposal.target);
      if (current.trimEnd() !== proposal.previous.trimEnd()) throw new Error("Workspace content changed after this proposal. Review a fresh diff.");
      const revision = await this.store.writeWorkspaceRevision(proposal.anchorFeedId, proposal.target, proposal.next, proposal.instruction, "voice_proposal");
      proposal.status = "applied";
      proposal.appliedAt = isoNow();
      proposal.appliedRevisionId = revision.id;
      await this.store.writeRevisionProposal(proposal);
      return revision;
    });
  }

  async rejectRevisionProposal(proposalId: string): Promise<RevisionProposal> {
    return this.store.serialize(async () => {
      const proposal = await this.store.readRevisionProposal(proposalId);
      if (proposal.status !== "proposed") throw new Error("Revision proposal is no longer pending.");
      proposal.status = "rejected";
      proposal.rejectedAt = isoNow();
      await this.store.writeRevisionProposal(proposal);
      await this.store.appendEvent({ feedId: proposal.anchorFeedId, type: "revision.rejected", detail: { proposalId, target: proposal.target } });
      return proposal;
    });
  }

  async updateWorkspaceDocument(anchorFeedId: string, target: VoiceTarget, content: string): Promise<WorkspaceRevision> {
    if (!content.trim()) throw new Error("Workspace content is required.");
    return this.store.serialize(() => this.store.writeWorkspaceRevision(anchorFeedId, target, content, "Edited directly in the workspace.", "manual_edit"));
  }

  async revertWorkspaceRevision(revisionId: string): Promise<WorkspaceRevision> {
    return this.store.serialize(() => this.store.revertWorkspaceRevision(revisionId));
  }

  async bindFeed(feedId: string, homeThreadId: string): Promise<ThreadBinding> {
    if (!homeThreadId.trim()) throw new Error("A home Codex thread ID is required.");
    return this.store.serialize(async () => {
      const thread = await this.store.readThread(feedId);
      thread.homeThreadId = homeThreadId.trim();
      thread.boundAt = isoNow();
      await this.store.writeThread(feedId, thread);
      await this.store.appendEvent({ feedId, type: "thread.bound", detail: { homeThreadId: thread.homeThreadId } });
      return thread;
    });
  }

  async proposeHeartbeat(feedId: string, cadence: string): Promise<ThreadBinding> {
    return this.store.serialize(async () => {
      const thread = await this.store.readThread(feedId);
      thread.heartbeat = { status: "proposed", cadence: cadence.trim(), automationId: null };
      await this.store.writeThread(feedId, thread);
      await this.store.appendEvent({ feedId, type: "heartbeat.proposed", detail: { cadence: cadence.trim() } });
      return thread;
    });
  }

  async recordHeartbeatInstalled(feedId: string, automationId: string): Promise<ThreadBinding> {
    return this.store.serialize(async () => {
      const thread = await this.store.readThread(feedId);
      if (thread.heartbeat.status !== "proposed") throw new Error("Heartbeat must be proposed before installation.");
      thread.heartbeat = { ...thread.heartbeat, status: "installed", automationId: automationId.trim() };
      await this.store.writeThread(feedId, thread);
      await this.store.appendEvent({ feedId, type: "heartbeat.installed", detail: { automationId } });
      return thread;
    });
  }

  async queueInstruction(feedId: string, cardId: string, instruction: string): Promise<WorkItem> {
    if (!instruction.trim()) throw new Error("Instruction is required.");
    return this.store.serialize(async () => {
      const card = await this.store.readCard(feedId, cardId);
      if (card.status === "done") throw new Error("Done cards cannot be queued.");
      const work = queuedWork(feedId, cardId, instruction, { kind: "instruction" });
      card.status = "queued";
      appendHistory(card, "user.instruction", instruction.trim());
      await this.store.writeWork(work);
      await this.store.writeCard(card);
      await this.store.appendEvent({ feedId, cardId, workId: work.id, type: "work.queued", detail: { instruction: work.instruction } });
      return work;
    });
  }

  async queueFeedInstruction(feedId: string, instruction: string): Promise<WorkItem> {
    if (!instruction.trim()) throw new Error("Instruction is required.");
    return this.store.serialize(async () => {
      const work = queuedWork(feedId, "__feed__", instruction, { kind: "instruction" });
      await this.store.writeWork(work);
      await this.store.appendEvent({ feedId, workId: work.id, type: "feed.instruction_queued", detail: { instruction: work.instruction } });
      return work;
    });
  }

  async approveAction(feedId: string, cardId: string, cardActionId?: string): Promise<WorkItem> {
    return this.store.serialize(async () => {
      const card = await this.store.readCard(feedId, cardId);
      if (card.status === "done") throw new Error("Done cards cannot be approved.");
      const action = configuredApprovalAction(card, cardActionId);
      requiredSourceMailbox(feedId, card, action);
      const now = isoNow();
      const approvalDigest = actionDigest(card, cardActionId);
      const feed = await this.store.readFeed(feedId);
      const active = feed.work.filter((work) => work.cardId === cardId && work.kind === "execute_approved_action" && (work.status === "queued" || work.status === "working"));
      const existing = active.find((work) => work.approvalDigest === approvalDigest);
      if (existing) return existing;
      if (active.some((work) => work.status === "working")) throw new Error("An approved action is already in progress for an older snapshot.");
      for (const work of active) {
        work.status = "stale";
        work.error = "Approval stale - a newer visible action snapshot was approved.";
        await this.store.writeWork(work);
        await this.store.appendEvent({ feedId, cardId, workId: work.id, type: "action.stale", detail: { reason: work.error } });
      }
      const work: WorkItem = {
        id: makeId("work"),
        feedId,
        cardId,
        kind: "execute_approved_action",
        instruction: action.instruction,
        status: "queued",
        capabilityToken: makeToken(),
        approvalDigest,
        ...(cardActionId ? { cardActionId } : {}),
        createdAt: now,
        updatedAt: now,
      };
      card.status = "queued";
      appendHistory(card, "user.approved_action", approvalDigest);
      await this.store.writeWork(work);
      await this.store.writeCard(card);
      await this.store.appendEvent({ feedId, cardId, workId: work.id, type: "action.approved", detail: { approvalDigest } });
      return work;
    });
  }

  async runCardAction(feedId: string, cardId: string, cardActionId: string): Promise<WorkItem> {
    if (cardActionId === "default-cleanup") return this.dismissCard(feedId, cardId);
    if (cardActionId === "proposed-action") return this.approveAction(feedId, cardId);
    const card = await this.store.readCard(feedId, cardId);
    const action = card.actions?.find((item) => item.id === cardActionId);
    if (!action) throw new Error("Card action not found.");
    if (action.behavior === "default_cleanup") return this.dismissCard(feedId, cardId);
    if (!action.instruction?.trim()) throw new Error("Card action instruction is required.");
    if (action.behavior === "queue_instruction") return this.queueInstruction(feedId, cardId, action.instruction);
    return this.approveAction(feedId, cardId, action.id);
  }

  async dismissCard(feedId: string, cardId: string): Promise<WorkItem> {
    return this.store.serialize(async () => {
      const config = await this.store.readConfig(feedId);
      const card = await this.store.readCard(feedId, cardId);
      if (card.status === "done") throw new Error("Done cards cannot be cleaned up again.");
      const now = isoNow();
      const approvalDigest = cleanupDigest(card, config.defaultCleanup);
      const feed = await this.store.readFeed(feedId);
      const active = feed.work.filter((work) => work.cardId === cardId && work.kind === "default_cleanup" && (work.status === "queued" || work.status === "working"));
      const existing = active.find((work) => work.approvalDigest === approvalDigest);
      if (existing) return existing;
      if (active.some((work) => work.status === "working")) throw new Error("A default cleanup is already in progress for an older snapshot.");
      for (const work of active) {
        work.status = "stale";
        work.error = "Approval stale - a newer visible cleanup snapshot was approved.";
        await this.store.writeWork(work);
        await this.store.appendEvent({ feedId, cardId, workId: work.id, type: "action.stale", detail: { reason: work.error } });
      }
      const work: WorkItem = {
        id: makeId("work"),
        feedId,
        cardId,
        kind: "default_cleanup",
        instruction: config.defaultCleanup,
        status: "queued",
        capabilityToken: makeToken(),
        approvalDigest,
        createdAt: now,
        updatedAt: now,
      };
      card.status = "queued";
      appendHistory(card, "user.default_cleanup_approved", config.defaultCleanup);
      await this.store.writeWork(work);
      await this.store.writeCard(card);
      await this.store.appendEvent({ feedId, cardId, workId: work.id, type: "cleanup.queued", detail: { cleanup: config.defaultCleanup } });
      return work;
    });
  }

  async upsertRoutineActionGroup(feedId: string, input: Pick<RoutineActionGroup, "id" | "label" | "summary" | "proposedAction" | "items">): Promise<RoutineActionGroup> {
    if (!input.id.trim() || !input.label.trim() || !input.summary.trim()) throw new Error("Routine action group id, label, and summary are required.");
    if (!input.proposedAction.label.trim() || !input.proposedAction.instruction.trim()) throw new Error("Routine action group approval needs a visible label and exact instruction.");
    if (!input.items.length) throw new Error("Routine action group needs at least one item.");
    const itemIds = input.items.map((item) => item.id);
    const cardIds = input.items.flatMap((item) => item.cardId ? [item.cardId] : []);
    if (new Set(itemIds).size !== itemIds.length) throw new Error("Routine action item IDs must be unique.");
    if (new Set(cardIds).size !== cardIds.length) throw new Error("A card cannot appear twice in one routine action group.");
    return this.store.serialize(async () => {
      const existing = (await this.store.hasRoutineActionGroup(feedId, input.id)) ? await this.store.readRoutineActionGroup(feedId, input.id) : null;
      if (existing && (existing.status === "queued" || existing.status === "working" || existing.status === "completed")) {
        throw new Error("Routine action group cannot change after approval or completion.");
      }
      for (const item of input.items) {
        if (!item.id.trim() || !item.title.trim() || !item.reason.trim()) throw new Error("Routine action items need an id, title, and reason.");
        if (!item.cardId) continue;
        const card = await this.store.readCard(feedId, item.cardId);
        if (card.status !== "to_review_new" && card.status !== "to_review_updated") throw new Error(`Routine action card is no longer reviewable: ${card.id}`);
        if (card.routineActionGroupId && card.routineActionGroupId !== input.id) throw new Error(`Routine action card already belongs to another group: ${card.id}`);
      }
      if (existing) await this.releaseRoutineActionCards(existing, false);
      const now = isoNow();
      const group: RoutineActionGroup = {
        id: input.id.trim(),
        feedId,
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
        const card = await this.store.readCard(feedId, item.cardId);
        card.routineActionGroupId = group.id;
        appendHistory(card, "routine_action.proposed", group.id);
        await this.store.writeCard(card);
      }
      await this.store.writeRoutineActionGroup(group);
      await this.store.appendEvent({ feedId, type: "routine_action.proposed", detail: { groupId: group.id, items: group.items.length } });
      return group;
    });
  }

  async approveRoutineActionGroup(feedId: string, groupId: string): Promise<WorkItem> {
    return this.store.serialize(async () => {
      const group = await this.store.readRoutineActionGroup(feedId, groupId);
      const approvalDigest = routineActionDigest(group);
      const feed = await this.store.readFeed(feedId);
      const active = feed.work.filter((work) => work.kind === "routine_action_batch" && work.routineActionGroupId === groupId && (work.status === "queued" || work.status === "working"));
      const existing = active.find((work) => work.approvalDigest === approvalDigest);
      if (existing) return existing;
      if (group.status !== "proposed") throw new Error("Routine action group is no longer waiting for approval.");
      if (active.some((work) => work.status === "working")) throw new Error("An older routine action snapshot is already in progress.");
      for (const work of active) {
        work.status = "stale";
        work.error = "Approval stale - a newer routine action snapshot was approved.";
        await this.store.writeWork(work);
      }
      const work = queuedWork(feedId, "__routine__", group.proposedAction.instruction, {
        kind: "routine_action_batch",
        routineActionGroupId: group.id,
        approvalDigest,
      });
      group.status = "queued";
      group.workId = work.id;
      await this.store.writeWork(work);
      await this.store.writeRoutineActionGroup(group);
      await this.store.appendEvent({ feedId, workId: work.id, type: "routine_action.approved", detail: { groupId: group.id, approvalDigest, items: group.items.length } });
      return work;
    });
  }

  async undoDismiss(feedId: string, cardId: string): Promise<Card> {
    return this.store.serialize(async () => {
      const feed = await this.store.readFeed(feedId);
      const work = [...feed.work].reverse().find((item) => item.cardId === cardId && item.kind === "default_cleanup" && item.status === "queued");
      if (!work) throw new Error("Queued cleanup is no longer available to undo.");
      work.status = "cancelled";
      const card = await this.store.readCard(feedId, cardId);
      card.status = "to_review_updated";
      card.readyForPass = feed.config.currentPass;
      appendHistory(card, "user.default_cleanup_undone", work.id);
      await this.store.writeWork(work);
      await this.store.writeCard(card);
      await this.store.appendEvent({ feedId, cardId, workId: work.id, type: "cleanup.cancelled" });
      return card;
    });
  }

  async returnCardToReview(feedId: string, cardId: string): Promise<Card> {
    return this.store.serialize(async () => {
      const feed = await this.store.readFeed(feedId);
      const card = await this.store.readCard(feedId, cardId);
      if (card.routineActionGroupId) throw new Error("This card belongs to a routine action group. Review the group instead.");
      const activeWork = feed.work.filter((work) =>
        work.cardId === cardId &&
        (work.status === "queued" || work.status === "working" || work.status === "approved_blocked")
      );
      if (activeWork.some((work) => work.status === "working")) {
        throw new Error("Codex already started this card. Wait for it to finish before moving it back to review.");
      }
      for (const work of activeWork) {
        work.status = "cancelled";
        work.error = "Returned to review by the user.";
        await this.store.writeWork(work);
        await this.store.appendEvent({ feedId, cardId, workId: work.id, type: "work.cancelled", detail: { reason: work.error } });
      }
      card.status = "to_review_updated";
      card.readyForPass = feed.config.currentPass;
      card.completedAt = undefined;
      appendHistory(card, "user.returned_to_review");
      await this.store.writeCard(card);
      await this.store.appendEvent({ feedId, cardId, type: "card.returned_to_review", detail: { cancelledWorkIds: activeWork.map((work) => work.id) } });
      return card;
    });
  }

  async updateBlock(feedId: string, cardId: string, blockId: string, value: string): Promise<Card> {
    return this.store.serialize(async () => {
      const card = await this.store.readCard(feedId, cardId);
      const block = card.blocks.find((item) => item.id === blockId);
      if (!block || block.type !== "editable_text") throw new Error("Editable card block not found.");
      block.value = value;
      block.editable = true;
      appendHistory(card, "user.edited_artifact", blockId);
      await this.store.writeCard(card);
      await this.store.appendEvent({ feedId, cardId, type: "card.block_edited", detail: { blockId } });
      return card;
    });
  }

  async updateQueuedWorkInstruction(feedId: string, workId: string, instruction: string): Promise<WorkItem> {
    if (!instruction.trim()) throw new Error("Instruction is required.");
    return this.store.serialize(async () => {
      const work = await this.store.readWork(feedId, workId);
      if (work.status !== "queued") throw new Error("Only queued notes can be edited before Codex starts.");
      if (
        work.cardId === "__feed__" ||
        work.cardId === "__routine__" ||
        (work.kind !== "instruction" && work.kind !== "scoped_instruction") ||
        (work.intent && work.intent !== "voice_instruction")
      ) {
        throw new Error("This queued work item is not an editable card note.");
      }
      work.instruction = instruction.trim();
      await this.store.writeWork(work);
      const card = await this.store.readCard(feedId, work.cardId);
      appendHistory(card, "user.edited_queued_instruction", work.instruction);
      await this.store.writeCard(card);
      await this.store.appendEvent({ feedId, cardId: work.cardId, workId, type: "work.instruction_edited" });
      return work;
    });
  }

  async beginNextPass(feedId: string): Promise<FeedConfig> {
    return this.store.serialize(async () => {
      const config = await this.store.readConfig(feedId);
      config.currentPass += 1;
      await this.store.writeConfig(config);
      await this.store.appendEvent({ feedId, type: "sweep.next_pass", detail: { currentPass: config.currentPass } });
      return config;
    });
  }

  async queueCompound(feedId: string): Promise<WorkItem> {
    return this.store.serialize(async () => {
      const feed = await this.store.readFeed(feedId);
      const existing = feed.work.find((work) => work.kind === "compound_learnings" && (work.status === "queued" || work.status === "working"));
      if (existing) return existing;
      const now = isoNow();
      const work: WorkItem = {
        id: makeId("work"),
        feedId,
        cardId: "__feed__",
        kind: "compound_learnings",
        instruction: "The user approved a learning pass. Review raw snapshots, runs, events, outcomes, and policy history. Distill a compact feed-policy improvement, then create an editable revision proposal with revision:propose --source compound. Do not apply it. The browser will bring the proposal back to the user for review.",
        status: "queued",
        capabilityToken: makeToken(),
        createdAt: now,
        updatedAt: now,
      };
      await this.store.writeWork(work);
      await this.store.appendEvent({ feedId, workId: work.id, type: "learning.compound_queued" });
      return work;
    });
  }

  async listPendingWork(feedId: string, threadId: string, explicitCrossFeed = false): Promise<WorkItem[]> {
    await this.assertThread(feedId, threadId, explicitCrossFeed);
    const feed = await this.store.readFeed(feedId);
    return feed.work.filter((work) => work.status === "queued" || work.status === "working");
  }

  async claimWork(feedId: string, threadId: string, explicitCrossFeed = false): Promise<WorkItem | null> {
    await this.assertThread(feedId, threadId, explicitCrossFeed);
    return this.store.serialize(async () => {
      const feed = await this.store.readFeed(feedId);
      const existing = feed.work.find((work) => work.status === "working");
      if (existing && !(await this.quarantineLegacyMutationWork(feed, existing))) return existing;
      let work = feed.work.find((item) => item.status === "queued");
      while (work && await this.quarantineLegacyMutationWork(feed, work)) {
        work = feed.work.find((item) => item.status === "queued");
      }
      if (!work) return null;
      work.status = "working";
      work.claimedAt = isoNow();
      await this.store.writeWork(work);
      if (work.kind === "routine_action_batch" && work.routineActionGroupId) {
        const group = await this.store.readRoutineActionGroup(feedId, work.routineActionGroupId);
        group.status = "working";
        group.workId = work.id;
        await this.store.writeRoutineActionGroup(group);
      } else if (work.cardId !== "__feed__") {
        const card = await this.store.readCard(feedId, work.cardId);
        card.status = "working";
        appendHistory(card, "codex.claimed", work.id);
        await this.store.writeCard(card);
      }
      await this.store.appendEvent({ feedId, cardId: work.cardId, workId: work.id, type: "work.claimed", detail: { threadId } });
      return work;
    });
  }

  async cancelQueuedWork(feedId: string, workId: string, reason = "Cancelled before Codex started work."): Promise<WorkItem> {
    return this.store.serialize(async () => {
      const work = await this.store.readWork(feedId, workId);
      if (work.status !== "queued") throw new Error("Only queued work can be cancelled before Codex starts.");
      work.status = "cancelled";
      work.error = reason.trim() || "Cancelled before Codex started work.";
      await this.store.writeWork(work);
      if (work.kind === "routine_action_batch" && work.routineActionGroupId) {
        const group = await this.store.readRoutineActionGroup(feedId, work.routineActionGroupId);
        group.status = "proposed";
        group.workId = undefined;
        group.error = undefined;
        await this.store.writeRoutineActionGroup(group);
      } else if (work.cardId !== "__feed__") {
        const feed = await this.store.readFeed(feedId);
        const card = await this.store.readCard(feedId, work.cardId);
        const hasActiveWork = feed.work.some((item) => item.id !== work.id && item.cardId === work.cardId && (item.status === "queued" || item.status === "working"));
        if (!hasActiveWork) {
          card.status = "to_review_updated";
          card.readyForPass = feed.config.currentPass;
          appendHistory(card, "user.cancelled_queued_work", work.id);
          await this.store.writeCard(card);
        }
      } else if (work.intent === "sweep_rejudge" && work.feedbackId) {
        const sweep = await this.store.readSweepState(feedId);
        if (sweep.lastFeedbackId === work.feedbackId) {
          await this.restoreAbandonedSweepFeedback(feedId, sweep.currentBatchId, work);
          await this.store.appendEvent({ feedId, workId, type: "sweep.feedback_cancelled", detail: { feedbackId: work.feedbackId } });
        }
      }
      await this.store.appendEvent({ feedId, cardId: work.cardId, workId, type: "work.cancelled", detail: { reason: work.error } });
      return work;
    });
  }

  async completeWork(feedId: string, workId: string, token: string, result: { response: string; blocks?: CardBlock[]; proposedAction?: ProposedAction; actions?: CardAction[]; done?: boolean }): Promise<WorkItem> {
    if (result.blocks) validateCardBlocks(result.blocks);
    return this.store.serialize(async () => {
      const work = await this.store.readWork(feedId, workId);
      if (work.status !== "working") throw new Error("Work item is not currently claimed.");
      if (work.capabilityToken !== token) throw new Error("Invalid scoped work capability token.");
      if (!result.response?.trim()) throw new Error("A work response is required.");
      if (work.intent === "sweep_rejudge") {
        if (!work.feedbackId) throw new Error("Sweep rejudgment work is missing its feedback trace.");
        const trace = await this.store.readSweepFeedback(feedId, work.feedbackId);
        if (!trace.rejudgedAt) throw new Error("Sweep rejudgment must be recorded before this work can complete.");
      }
      if (work.intent === "recollect_sources") {
        if (work.startingBatchId === undefined) throw new Error("Source recollection work is missing its starting sweep batch.");
        const sweep = await this.store.readSweepState(feedId);
        if (!sweep.currentBatchId || sweep.currentBatchId === work.startingBatchId) {
          throw new Error("A new sweep batch must be recorded before source recollection can complete.");
        }
        const batch = await this.store.readSweepBatch(feedId, sweep.currentBatchId);
        if (batch.createdAt < work.createdAt) throw new Error("Source recollection completed with a sweep batch that predates the request.");
        if (batch.triggerWorkId !== work.id) throw new Error("Source recollection must complete with a sweep batch recorded for this work item.");
      }
      if (work.kind === "routine_action_batch") {
        if (!work.routineActionGroupId || !work.approvalDigest) throw new Error("Routine action work is missing its approved snapshot.");
        const group = await this.store.readRoutineActionGroup(feedId, work.routineActionGroupId);
        if (work.approvalDigest !== routineActionDigest(group)) {
          work.status = "stale";
          work.error = "Approval stale - the routine action group changed after approval.";
          group.status = "stale";
          group.error = work.error;
          await this.releaseRoutineActionCards(group, true);
          await this.store.writeWork(work);
          await this.store.writeRoutineActionGroup(group);
          await this.store.appendEvent({ feedId, workId, type: "routine_action.stale", detail: { groupId: group.id } });
          throw new Error(work.error);
        }
        if (work.verifiedApprovalDigest !== work.approvalDigest) {
          throw new Error("Approved action must pass action:verify immediately before the external mutation.");
        }
        for (const item of group.items) {
          if (!item.cardId) continue;
          const card = await this.store.readCard(feedId, item.cardId);
          card.status = "done";
          card.completedAt = isoNow();
          appendHistory(card, "routine_action.completed", work.id);
          await this.store.writeCard(card);
        }
        group.status = "completed";
        group.completedAt = isoNow();
        group.error = undefined;
        await this.store.writeRoutineActionGroup(group);
      } else if (work.cardId !== "__feed__") {
        const card = await this.store.readCard(feedId, work.cardId);
        const currentApprovalDigest = work.approvalDigest
          ? work.kind === "default_cleanup"
            ? cleanupDigest(card, (await this.store.readConfig(feedId)).defaultCleanup)
            : actionDigest(card, work.cardActionId)
          : undefined;
        if (work.approvalDigest !== currentApprovalDigest) {
          work.status = "stale";
          work.error = "Approval stale - the proposed action or artifact changed after approval.";
          card.status = "to_review_updated";
          card.readyForPass = (await this.store.readConfig(feedId)).currentPass + 1;
          appendHistory(card, "codex.stale_approval", work.id);
          await this.store.writeWork(work);
          await this.store.writeCard(card);
          await this.store.appendEvent({ feedId, cardId: card.id, workId, type: "action.stale" });
          throw new Error(work.error);
        }
        if (
          (work.kind === "execute_approved_action" || work.kind === "default_cleanup") &&
          work.verifiedApprovalDigest !== work.approvalDigest
        ) {
          throw new Error("Approved action must pass action:verify immediately before the external mutation.");
        }
        if (work.kind === "execute_approved_action") {
          const action = configuredApprovalAction(card, work.cardActionId);
          const sourceMailbox = requiredSourceMailbox(feedId, card, action);
          if (sourceMailbox && work.verifiedMailbox !== sourceMailbox) {
            throw new Error(`Approved email reply must be reverified for ${sourceMailbox} before completion.`);
          }
        }
        if (result.blocks) card.blocks = result.blocks;
        if (result.proposedAction) card.proposedAction = result.proposedAction;
        if (result.actions) card.actions = result.actions;
        const done = Boolean(result.done || work.kind === "default_cleanup" || work.kind === "execute_approved_action");
        card.status = done ? "done" : "to_review_updated";
        card.completedAt = done ? isoNow() : undefined;
        card.readyForPass = (await this.store.readConfig(feedId)).currentPass + 1;
        appendHistory(card, "codex.completed", result.response.trim());
        await this.store.writeCard(card);
      }
      work.status = "completed";
      work.completedAt = isoNow();
      work.response = result.response.trim();
      await this.store.writeWork(work);
      await this.store.appendEvent({ feedId, cardId: work.cardId, workId, type: "work.completed", detail: { response: work.response } });
      return work;
    });
  }

  async verifyApprovedAction(feedId: string, workId: string, token: string, authenticatedMailbox?: string): Promise<{ approvalDigest: string; action: ProposedAction; artifact?: CardBlock; verifiedMailbox?: string }> {
    return this.store.serialize(async () => {
      const work = await this.store.readWork(feedId, workId);
      if (work.status !== "working") throw new Error("Approved action work must be claimed before verification.");
      if ((work.kind !== "execute_approved_action" && work.kind !== "default_cleanup" && work.kind !== "routine_action_batch") || !work.approvalDigest) throw new Error("Work item is not an approved action.");
      if (work.capabilityToken !== token) throw new Error("Invalid scoped work capability token.");
      let result: { approvalDigest: string; action: ProposedAction; artifact?: CardBlock; verifiedMailbox?: string };
      if (work.kind === "routine_action_batch") {
        if (!work.routineActionGroupId) throw new Error("Routine action work is missing its group.");
        const group = await this.store.readRoutineActionGroup(feedId, work.routineActionGroupId);
        if (work.approvalDigest !== routineActionDigest(group)) throw new Error("Approval stale - reread and return the routine action group for review.");
        result = { approvalDigest: work.approvalDigest, action: group.proposedAction };
      } else {
        const card = await this.store.readCard(feedId, work.cardId);
        if (work.kind === "default_cleanup") {
          const config = await this.store.readConfig(feedId);
          if (work.instruction !== config.defaultCleanup || work.approvalDigest !== cleanupDigest(card, config.defaultCleanup)) throw new Error("Approval stale - reread and return the card for review.");
          result = {
            approvalDigest: work.approvalDigest,
            action: { label: "Default cleanup", instruction: config.defaultCleanup },
          };
        } else {
          const action = configuredApprovalAction(card, work.cardActionId);
          if (work.approvalDigest !== actionDigest(card, work.cardActionId)) throw new Error("Approval stale - reread and return the card for review.");
          const verifiedMailbox = verifySourceMailbox(feedId, card, action, authenticatedMailbox);
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
      await this.store.writeWork(work);
      await this.store.appendEvent({ feedId, cardId: work.cardId, workId, type: "action.verified", detail: { verifiedMailbox: work.verifiedMailbox } });
      return result;
    });
  }

  async failWork(feedId: string, workId: string, token: string, error: string): Promise<WorkItem> {
    return this.store.serialize(async () => {
      const work = await this.store.readWork(feedId, workId);
      if (work.status !== "working") throw new Error("Work item is not currently claimed.");
      if (work.capabilityToken !== token) throw new Error("Invalid scoped work capability token.");
      work.status = "failed";
      work.error = error.trim() || "Codex could not complete this work.";
      await this.store.writeWork(work);
      if (work.kind === "routine_action_batch" && work.routineActionGroupId) {
        const group = await this.store.readRoutineActionGroup(feedId, work.routineActionGroupId);
        group.status = "failed";
        group.error = work.error;
        await this.releaseRoutineActionCards(group, true);
        await this.store.writeRoutineActionGroup(group);
      } else if (work.cardId !== "__feed__") {
        const config = await this.store.readConfig(feedId);
        const card = await this.store.readCard(feedId, work.cardId);
        card.status = "to_review_updated";
        card.readyForPass = config.currentPass + 1;
        appendHistory(card, "codex.failed", work.error);
        await this.store.writeCard(card);
      } else if (work.intent === "recollect_sources") {
        const sweep = await this.store.readSweepState(feedId);
        if (sweep.currentBatchId === work.startingBatchId) {
          await this.store.writeSweepState(feedId, { ...sweep, recollectionOffered: true, statusMessage: "Source search failed" });
          await this.store.appendEvent({ feedId, workId, type: "sweep.recollection_offered", detail: { feedbackId: work.feedbackId, reason: "recollection_failed" } });
        }
      } else if (work.intent === "sweep_rejudge" && work.feedbackId) {
        const sweep = await this.store.readSweepState(feedId);
        if (sweep.lastFeedbackId === work.feedbackId) {
          await this.restoreAbandonedSweepFeedback(feedId, sweep.currentBatchId, work);
          await this.store.appendEvent({ feedId, workId, type: "sweep.feedback_failed", detail: { feedbackId: work.feedbackId } });
        }
      }
      await this.store.appendEvent({ feedId, cardId: work.cardId, workId, type: "work.failed", detail: { error: work.error } });
      return work;
    });
  }

  async blockApprovedWork(feedId: string, workId: string, token: string, error: string): Promise<WorkItem> {
    return this.store.serialize(async () => {
      const work = await this.store.readWork(feedId, workId);
      if (work.status !== "working") throw new Error("Work item is not currently claimed.");
      if (work.kind !== "execute_approved_action" || !work.approvalDigest) throw new Error("Only approved actions can wait for a retry.");
      if (work.capabilityToken !== token) throw new Error("Invalid scoped work capability token.");
      const card = await this.store.readCard(feedId, work.cardId);
      if (work.approvalDigest !== actionDigest(card, work.cardActionId)) {
        work.status = "stale";
        work.error = "Approval stale - the proposed action or artifact changed after approval.";
        card.status = "to_review_updated";
        card.readyForPass = (await this.store.readConfig(feedId)).currentPass + 1;
        appendHistory(card, "codex.stale_approval", work.id);
        await this.store.writeWork(work);
        await this.store.writeCard(card);
        await this.store.appendEvent({ feedId, cardId: card.id, workId, type: "action.stale" });
        throw new Error(work.error);
      }
      work.status = "approved_blocked";
      work.error = error.trim() || "The approved action is waiting for Codex to retry.";
      work.updatedAt = isoNow();
      card.status = "approved_blocked";
      appendHistory(card, "codex.approved_action_blocked", work.error);
      await this.store.writeWork(work);
      await this.store.writeCard(card);
      await this.store.appendEvent({ feedId, cardId: work.cardId, workId, type: "work.approved_action_blocked", detail: { error: work.error } });
      return work;
    });
  }

  async retryApprovedWork(feedId: string, workId: string): Promise<WorkItem> {
    return this.store.serialize(async () => {
      const work = await this.store.readWork(feedId, workId);
      if ((work.status !== "approved_blocked" && work.status !== "failed") || work.kind !== "execute_approved_action" || !work.approvalDigest) {
        throw new Error("Only an approved blocked action can be retried.");
      }
      const card = await this.store.readCard(feedId, work.cardId);
      requiredSourceMailbox(feedId, card, configuredApprovalAction(card, work.cardActionId));
      if (work.approvalDigest !== actionDigest(card, work.cardActionId)) {
        work.status = "stale";
        work.error = "Approval stale - the proposed action or artifact changed after approval.";
        card.status = "to_review_updated";
        card.readyForPass = (await this.store.readConfig(feedId)).currentPass + 1;
        appendHistory(card, "codex.stale_approval", work.id);
        await this.store.writeWork(work);
        await this.store.writeCard(card);
        await this.store.appendEvent({ feedId, cardId: card.id, workId, type: "action.stale" });
        throw new Error(work.error);
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
      await this.store.writeWork(work);
      await this.store.writeCard(card);
      await this.store.appendEvent({ feedId, cardId: work.cardId, workId, type: "work.approved_action_retry_queued" });
      return work;
    });
  }

  async createFeedFromBrief(brief: string, currentThreadId: string | null): Promise<FeedConfig> {
    if (!brief.trim()) throw new Error("Describe the feed you want.");
    const normalizedBrief = brief.replace(/\\n/g, "\n").trim();
    const firstLine = normalizedBrief.split("\n")[0].replace(/^#+\s*/, "");
    const name = firstLine.length <= 60 ? firstLine : firstLine.slice(0, 57).trimEnd() + "...";
    const config = feedConfig({ id: slugify(name), name, purpose: normalizedBrief, defaultCleanup: "Dismiss this card and perform the feed's configured cleanup." });
    await this.store.createFeed(config, currentThreadId);
    const now = isoNow();
    await this.store.writeCard({
      id: "guided-source-setup",
      feedId: config.id,
      kind: "feed_improvement",
      status: "to_review_new",
      eyebrow: "Feed setup",
      title: `Teach ${config.name} where to look.`,
      why: "The feed exists. Codex should now propose the smallest useful source recipe and a heartbeat cadence for review.",
      blocks: [
        { id: "brief", type: "memo", label: "Your brief", text: normalizedBrief },
        { id: "clarify", type: "clarification", label: "Next step", text: "Wake this feed's Codex thread or use the dock. Codex will propose sources in plain English before collecting." },
      ],
      proposedAction: { label: "Propose source recipe", instruction: "Based on this feed brief, propose the smallest useful real source recipe and a heartbeat cadence. Return the proposal for review before collecting." },
      actions: [{ id: "propose-source-recipe", label: "Propose source recipe", behavior: "queue_instruction", instruction: "Based on this feed brief, propose the smallest useful real source recipe and a heartbeat cadence. Return the proposal for review before collecting.", variant: "primary", shortcut: "p" }],
      readyForPass: 1,
      createdAt: now,
      updatedAt: now,
      history: [],
    });
    return config;
  }

  async addSourceFromBrief(feedId: string, brief: string): Promise<SourceRecipe> {
    if (!brief.trim()) throw new Error("Describe the source you want to add.");
    const { recipe, markdown } = sourceRecipeFromBrief(brief);
    await this.store.serialize(() => this.store.addSource(feedId, recipe, markdown));
    return recipe;
  }

  async removeSource(feedId: string, sourceId: string): Promise<void> {
    await this.store.serialize(() => this.store.removeSource(feedId, sourceId));
  }

  async updateSourceRecipe(feedId: string, sourceId: string, content: string): Promise<void> {
    if (!content.trim()) throw new Error("Source recipe content is required.");
    await this.store.serialize(() => this.store.writeSourceRecipe(feedId, sourceId, content.trim()));
  }

  async upsertCard(feedId: string, input: Partial<Card> & Pick<Card, "id" | "title" | "why" | "blocks">): Promise<Card> {
    validateCardBlocks(input.blocks);
    return this.store.serialize(async () => {
      const config = await this.store.readConfig(feedId);
      const now = isoNow();
      const existing = (await this.store.hasCard(feedId, input.id)) ? await this.store.readCard(feedId, input.id) : null;
      const resurfaced = input.status === "to_review_new" || input.status === "to_review_updated";
      const card: Card = {
        id: input.id,
        feedId,
        kind: input.kind ?? existing?.kind ?? "attention",
        status: input.status ?? existing?.status ?? "to_review_new",
        eyebrow: input.eyebrow ?? existing?.eyebrow ?? config.name,
        title: input.title,
        why: input.why,
        sourceMailbox: input.sourceMailbox ?? existing?.sourceMailbox,
        blocks: input.blocks,
        proposedAction: input.proposedAction,
        actions: input.actions,
        readyForPass: input.readyForPass ?? existing?.readyForPass ?? config.currentPass,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        completedAt: input.completedAt,
        routineActionGroupId: input.routineActionGroupId ?? (resurfaced ? undefined : existing?.routineActionGroupId),
        history: existing?.history ?? [],
      };
      await this.store.writeCard(card);
      await this.store.appendEvent({ feedId, cardId: card.id, type: existing ? "card.updated" : "card.created" });
      return card;
    });
  }

  async createImprovementCard(feedId: string, title: string, brief: string, instruction: string): Promise<Card> {
    const config = await this.store.readConfig(feedId);
    const now = isoNow();
    const card: Card = {
      id: makeId("proposal"),
      feedId,
      kind: "feed_improvement",
      status: "to_review_updated",
      eyebrow: "Feed improvement",
      title: title.trim(),
      why: "Codex found a structural improvement worth reviewing explicitly before it changes the feed.",
      blocks: [{ id: "proposal", type: "memo", label: "Proposal", text: brief.trim() }],
      proposedAction: { label: "Apply this improvement", instruction: instruction.trim() },
      actions: [{ id: "apply-improvement", label: "Apply improvement", behavior: "approve_action", instruction: instruction.trim(), variant: "primary", shortcut: "a" }],
      readyForPass: config.currentPass + 1,
      createdAt: now,
      updatedAt: now,
      history: [],
    };
    await this.store.writeCard(card);
    await this.store.appendEvent({ feedId, cardId: card.id, type: "proposal.created" });
    return card;
  }

  async recordAppFeedback(feedId: string, title: string, detail: string, sourceThreadId?: string): Promise<AppFeedback> {
    if (!title.trim()) throw new Error("Feedback title is required.");
    if (!detail.trim()) throw new Error("Feedback detail is required.");
    return this.store.serialize(async () => {
      await this.store.readConfig(feedId);
      const feedback: AppFeedback = {
        id: makeId("feedback"),
        feedId,
        title: title.trim(),
        detail: detail.trim(),
        ...(sourceThreadId?.trim() ? { sourceThreadId: sourceThreadId.trim() } : {}),
        status: "open",
        createdAt: isoNow(),
      };
      await this.store.writeAppFeedback(feedback);
      await this.store.appendEvent({ feedId, type: "app.feedback_recorded", detail: { feedbackId: feedback.id, title: feedback.title, sourceThreadId: feedback.sourceThreadId } });
      return feedback;
    });
  }

  async resolveAppFeedback(feedbackId: string, resolution: string): Promise<AppFeedback> {
    if (!resolution.trim()) throw new Error("Feedback resolution is required.");
    return this.store.serialize(async () => {
      const feedback = await this.store.readAppFeedbackItem(feedbackId);
      feedback.status = "resolved";
      feedback.resolution = resolution.trim();
      feedback.resolvedAt = isoNow();
      await this.store.writeAppFeedback(feedback);
      await this.store.appendEvent({ feedId: feedback.feedId, type: "app.feedback_resolved", detail: { feedbackId, resolution: feedback.resolution } });
      return feedback;
    });
  }

  async applyPolicyRevision(feedId: string, next: string, reason: string, source: PolicyRevision["source"]): Promise<PolicyRevision> {
    if (!next.trim()) throw new Error("Policy content is required.");
    return this.store.serialize(() => this.store.writePolicy(feedId, next.replace(/\\n/g, "\n").trim(), reason.trim(), source));
  }

  async revertPolicyRevision(feedId: string, revisionId: string): Promise<PolicyRevision> {
    return this.store.serialize(() => this.store.revertPolicy(feedId, revisionId));
  }

  async seedDemo(onlyFeedId?: string): Promise<void> {
    for (const feedId of onlyFeedId ? [onlyFeedId] : ["inbox", "company-attention"]) {
      for (const card of await this.demoReplayCards(feedId)) {
        if (!(await this.store.hasCard(feedId, card.id))) await this.store.writeCard(card);
      }
    }
  }

  async clearDemo(onlyFeedId?: string): Promise<void> {
    await this.store.serialize(async () => {
      for (const feedId of onlyFeedId ? [onlyFeedId] : ["inbox", "company-attention"]) {
        for (const card of demoCards(feedId)) await this.store.removeCard(feedId, card.id);
        await this.store.appendEvent({ feedId, type: "demo.cleared" });
      }
    });
  }

  async archiveFeed(feedId: string): Promise<void> {
    await this.store.archiveFeed(feedId);
  }

  private async demoReplayCards(feedId: string): Promise<Card[]> {
    const cards = demoCards(feedId);
    if (feedId !== "inbox") return cards;
    return Promise.all(cards.map(async (card) => {
      const sourceId = INBOX_DEMO_REPLAY_SOURCE_IDS[card.id];
      if (!sourceId) return card;
      try {
        const source = await this.store.readCard(feedId, sourceId);
        return {
          ...card,
          eyebrow: `Demo replay · ${source.eyebrow}`,
          title: source.title,
          why: source.why,
          blocks: [
            ...source.blocks,
            { id: "demo", type: "receipt", label: "Demo replay", text: "Local replay of a previously handled email. Buttons below simulate the workflow only; they do not touch Gmail or Calendar." },
          ],
        };
      } catch {
        return card;
      }
    }));
  }

  async recordSourceRun(feedId: string, sourceId: string, snapshots: unknown[], judgments: unknown[], checkpoint: unknown, triggerWorkId?: string): Promise<string> {
    return this.store.serialize(async () => {
      const feed = await this.store.readFeed(feedId);
      if (!feed.sources.some((source) => source.id === sourceId)) throw new Error(`Source recipe not found: ${sourceId}`);
      if (triggerWorkId) await this.assertClaimedRecollectionWork(feedId, triggerWorkId);
      const runId = makeId("run");
      for (const [index, snapshot] of snapshots.entries()) await this.store.writeRawSnapshot(feedId, runId, sourceId, `snapshot-${index + 1}`, snapshot);
      await this.store.writeRun({ id: runId, feedId, sourceId, snapshots: snapshots.length, judgments, ...(triggerWorkId ? { triggerWorkId } : {}), completedAt: isoNow() });
      await this.store.writeSourceCheckpoint(feedId, sourceId, checkpoint);
      await this.store.appendEvent({ feedId, workId: triggerWorkId, type: "source.run_completed", detail: { runId, sourceId, triggerWorkId, snapshots: snapshots.length, judgments: judgments.length } });
      return runId;
    });
  }

  async recordSweepBatch(feedId: string, sourceRunIds: string[], triggerWorkId?: string): Promise<string> {
    return this.store.serialize(async () => {
      if (!Array.isArray(sourceRunIds) || sourceRunIds.some((runId) => typeof runId !== "string" || !runId.trim())) {
        throw new Error("Sweep batch source run IDs must be non-empty strings.");
      }
      if (new Set(sourceRunIds).size !== sourceRunIds.length) throw new Error("Sweep batch source run IDs must be unique.");
      const triggerWork = triggerWorkId ? await this.assertClaimedRecollectionWork(feedId, triggerWorkId) : null;
      if (triggerWork && sourceRunIds.length === 0) throw new Error("Source recollection must record at least one source run.");
      for (const runId of sourceRunIds) {
        let run: { id: string; feedId: string; triggerWorkId?: string; completedAt?: string };
        try {
          run = await this.store.readRun(feedId, runId);
        } catch {
          throw new Error(`Source run not found for this feed: ${runId}`);
        }
        if (run.id !== runId || run.feedId !== feedId) throw new Error(`Source run does not belong to this feed: ${runId}`);
        if (triggerWork && run.triggerWorkId !== triggerWork.id) throw new Error(`Source run was not recorded for this recollection work: ${runId}`);
        if (triggerWork && (!run.completedAt || run.completedAt < triggerWork.createdAt)) throw new Error(`Source run predates this recollection work: ${runId}`);
      }
      const batchId = makeId("batch");
      await this.store.writeSweepBatch({ id: batchId, feedId, sourceRunIds, ...(triggerWorkId ? { triggerWorkId } : {}), createdAt: isoNow() });
      await this.store.writeSweepState(feedId, { currentBatchId: batchId, lastFeedbackId: null, recollectionOffered: false, statusMessage: null });
      await this.store.appendEvent({ feedId, workId: triggerWorkId, type: "sweep.batch_recorded", detail: { batchId, sourceRunIds, triggerWorkId } });
      return batchId;
    });
  }

  private async assertClaimedRecollectionWork(feedId: string, workId: string): Promise<WorkItem> {
    const work = await this.store.readWork(feedId, workId);
    if (work.feedId !== feedId || work.intent !== "recollect_sources" || work.status !== "working") {
      throw new Error("Source recollection must be recorded for the claimed same-feed recollection work item.");
    }
    return work;
  }

  private async restoreAbandonedSweepFeedback(feedId: string, currentBatchId: string | null, abandoned: WorkItem): Promise<void> {
    const feed = await this.store.readFeed(feedId);
    const byFeedbackId = new Map(feed.work.filter((work) => work.intent === "sweep_rejudge" && work.feedbackId).map((work) => [work.feedbackId as string, work]));
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
        await this.store.writeSweepState(feedId, { ...previous, currentBatchId });
        return;
      }
      previous = work.previousSweepState;
    }
    await this.store.writeSweepState(feedId, previous ? { ...previous, currentBatchId } : cleared);
  }

  async inspectHowFeedWorks(feedId: string): Promise<Record<string, unknown>> {
    const feed = await this.store.readFeed(feedId);
    const sources = await Promise.all(feed.sources.map(async (source) => ({
      ...source,
      content: await this.store.readSourceContent(feedId, source.id),
      checkpoint: JSON.stringify(await this.store.readSourceCheckpoint(feedId, source.id), null, 2),
    })));
    const prompts = await Promise.all(FEED_PROMPT_NAMES.map(async (name) => ({ name, content: await this.store.readTargetContent({ kind: "prompt_layer", feedId, promptId: name }) })));
    return { feed: feed.config, thread: feed.thread, policy: feed.policy, sources, prompts };
  }

  async inspectGlobalPromptWorkspace() {
    return this.store.readGlobalPromptWorkspace();
  }

  async updateGlobalPolicy(content: string): Promise<void> {
    if (!content.trim()) throw new Error("Global policy content is required.");
    await this.store.serialize(() => this.store.writeGlobalPolicy(content.replace(/\\n/g, "\n").trim()));
  }

  async updateGlobalPrompt(name: string, content: string): Promise<void> {
    if (!content.trim()) throw new Error("Prompt content is required.");
    await this.store.serialize(() => this.store.writeGlobalPrompt(name, content.replace(/\\n/g, "\n").trim()));
  }

  private async assertThread(feedId: string, threadId: string, explicitCrossFeed: boolean): Promise<void> {
    if (!threadId.trim()) throw new Error("A Codex thread ID is required.");
    const thread = await this.store.readThread(feedId);
    if (!thread.homeThreadId) throw new Error("Feed has no bound home thread.");
    if (thread.homeThreadId !== threadId.trim() && !explicitCrossFeed) throw new Error("This Codex thread does not own the feed. Use explicit cross-feed mode to proceed.");
  }
}
