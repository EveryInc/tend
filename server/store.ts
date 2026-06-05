import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type {
  AppFeedback,
  Card,
  DictationCapability,
  FeedConfig,
  FeedEvent,
  FeedView,
  PolicyRevision,
  RevisionProposal,
  RoutineActionGroup,
  SourceRun,
  SourceRecipe,
  SweepBatch,
  SweepFeedbackTrace,
  SweepState,
  ThreadBinding,
  VoiceTarget,
  WorkItem,
  WorkspaceRevision,
  WorkspaceView,
} from "../shared/types";
import {
  BASE_JUDGE_PROMPT,
  COMPOUND_PROMPT,
  COMPOSE_CARD_PROMPT,
  DISTILL_POLICY_PROMPT,
  EXECUTE_WORK_PROMPT,
  GLOBAL_POLICY,
  companyRecipe,
  feedConfig,
  inboxRecipe,
  setupCard,
  threadBinding,
} from "./templates";
import { isoNow, makeId, readJson, writeJson, writeText } from "./util";
import { defaultDictationCapability } from "./monologue";
import { FileCardRepository, type CardRepository } from "./repositories/cards";
import { FileFeedEventRepository, type FeedEventRepository } from "./repositories/feedEvents";
import { FileRevisionRepository, type RevisionRepository } from "./repositories/revisions";
import { FileRoutineActionGroupRepository, type RoutineActionGroupRepository } from "./repositories/routineActionGroups";
import { FileSourceRunRepository, type SourceRunRepository } from "./repositories/sourceRuns";
import { FileSourceRepository, type SourceRepository } from "./repositories/sources";
import { FileSweepRepository, type SweepRepository } from "./repositories/sweeps";
import { FileTextDocumentRepository, type TextDocumentRepository, type TextDocumentSeed } from "./repositories/textDocuments";
import { FileWorkItemRepository, type WorkItemRepository } from "./repositories/workItems";
import { FileWorkspaceFeedRepository, type WorkspaceFeedRepository } from "./repositories/workspaceFeeds";

export const GLOBAL_PROMPT_NAMES = ["judge.md", "compose-card.md", "execute-work.md", "distill-policy.md", "compound.md"] as const;
export const FEED_PROMPT_NAMES = ["judge.md", "compose-card.md"] as const;
const DEFAULT_FEED_IDS = ["inbox", "company-attention"];

export class AttentionStore {
  readonly dataDir: string;
  private tail = Promise.resolve();
  private readonly cards: CardRepository;
  private readonly events: FeedEventRepository;
  private readonly revisions: RevisionRepository;
  private readonly routineActionGroups: RoutineActionGroupRepository;
  private readonly sourceRuns: SourceRunRepository;
  private readonly sources: SourceRepository;
  private readonly sweeps: SweepRepository;
  private readonly textDocuments: TextDocumentRepository;
  private readonly workItems: WorkItemRepository;
  private readonly workspaceFeeds: WorkspaceFeedRepository;

  constructor(dataDir: string, options: { cards?: CardRepository; events?: FeedEventRepository; revisions?: RevisionRepository; routineActionGroups?: RoutineActionGroupRepository; sourceRuns?: SourceRunRepository; sources?: SourceRepository; sweeps?: SweepRepository; textDocuments?: TextDocumentRepository; workItems?: WorkItemRepository; workspaceFeeds?: WorkspaceFeedRepository } = {}) {
    this.dataDir = dataDir;
    this.cards = options.cards ?? new FileCardRepository(this.dataDir);
    this.events = options.events ?? new FileFeedEventRepository(this.dataDir);
    this.revisions = options.revisions ?? new FileRevisionRepository(this.dataDir);
    this.routineActionGroups = options.routineActionGroups ?? new FileRoutineActionGroupRepository(this.dataDir);
    this.sourceRuns = options.sourceRuns ?? new FileSourceRunRepository(this.dataDir);
    this.sources = options.sources ?? new FileSourceRepository(this.dataDir);
    this.sweeps = options.sweeps ?? new FileSweepRepository(this.dataDir);
    this.textDocuments = options.textDocuments ?? new FileTextDocumentRepository(this.dataDir);
    this.workItems = options.workItems ?? new FileWorkItemRepository(this.dataDir);
    this.workspaceFeeds = options.workspaceFeeds ?? new FileWorkspaceFeedRepository(this.path("workspace.json"));
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const dictationPath = this.path("integrations/dictation.json");
    if (!existsSync(dictationPath)) await writeJson(dictationPath, defaultDictationCapability());
    await this.workspaceFeeds.init(DEFAULT_FEED_IDS);
    const feedIds = await this.workspaceFeeds.listFeedIds();
    await this.textDocuments.init();
    await this.ensureTextDocumentSeeds(this.globalTextDocumentSeeds());
    await this.cards.init(feedIds);
    await this.events.init(feedIds);
    await this.revisions.init(feedIds);
    await this.routineActionGroups.init(feedIds);
    await this.sourceRuns.init(feedIds);
    await this.sources.init(feedIds);
    await this.sweeps.init(feedIds);
    await this.workItems.init(feedIds);
    await this.ensureDefaultFeed("inbox");
    await this.ensureDefaultFeed("company-attention");
    await Promise.all((await this.workspaceFeeds.listFeedIds()).map((feedId) => this.ensureFeedTextDocuments(feedId)));
  }

  path(...parts: string[]): string {
    return path.join(this.dataDir, ...parts);
  }

  feedPath(feedId: string, ...parts: string[]): string {
    return this.path("feeds", feedId, ...parts);
  }

  async readWorkspace(feedId = "inbox"): Promise<WorkspaceView> {
    await this.init();
    const feedIds = await this.workspaceFeeds.listFeedIds();
    const feeds = await Promise.all(feedIds.map(async (id) => {
      const config = await this.readConfig(id);
      return { id: config.id, name: config.name, purpose: config.purpose };
    }));
    const selected = feedIds.includes(feedId) ? feedId : feedIds[0];
    return {
      feeds,
      active: await this.readFeed(selected),
      dictation: await this.readDictationCapability(),
      proposals: await this.readRevisionProposals(selected),
    };
  }

  async readDictationCapability(): Promise<DictationCapability> {
    return readJson<DictationCapability>(this.path("integrations/dictation.json"));
  }

  async writeDictationCapability(capability: DictationCapability): Promise<void> {
    await writeJson(this.path("integrations/dictation.json"), capability);
  }

  async readGlobalPromptWorkspace(): Promise<{ globalPolicy: string; prompts: Array<{ name: string; content: string }> }> {
    return {
      globalPolicy: await this.textDocuments.read("global-policy.md"),
      prompts: await Promise.all(GLOBAL_PROMPT_NAMES.map(async (name) => ({ name, content: await this.textDocuments.read(`prompts/${name}`) }))),
    };
  }

  async writeGlobalPolicy(content: string): Promise<void> {
    await this.textDocuments.write("global-policy.md", content);
  }

  async writeGlobalPrompt(name: string, content: string): Promise<void> {
    if (!GLOBAL_PROMPT_NAMES.includes(name as (typeof GLOBAL_PROMPT_NAMES)[number])) throw new Error(`Unknown global prompt: ${name}`);
    await this.textDocuments.write(`prompts/${name}`, content);
  }

  async readRevisionProposals(anchorFeedId: string): Promise<RevisionProposal[]> {
    const proposals = await this.revisions.listProposals();
    return proposals
      .filter((proposal) =>
        proposal.status === "proposed" &&
        (proposal.anchorFeedId === anchorFeedId || proposal.target.kind === "attention" || proposal.target.kind === "global_prompt")
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async readRevisionProposal(proposalId: string): Promise<RevisionProposal> {
    return this.revisions.getProposal(proposalId);
  }

  async writeRevisionProposal(proposal: RevisionProposal): Promise<void> {
    await this.revisions.writeProposal(proposal);
  }

  async readAppFeedback(): Promise<AppFeedback[]> {
    return (await this.readDirectoryJson<AppFeedback>(this.path("app-feedback")))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async writeAppFeedback(feedback: AppFeedback): Promise<void> {
    await writeJson(this.path("app-feedback", `${feedback.id}.json`), feedback);
  }

  async readAppFeedbackItem(feedbackId: string): Promise<AppFeedback> {
    return readJson<AppFeedback>(this.path("app-feedback", `${feedbackId}.json`));
  }

  async readWorkspaceRevision(revisionId: string): Promise<WorkspaceRevision> {
    return this.revisions.getWorkspaceRevision(revisionId);
  }

  async writeWorkspaceRevision(anchorFeedId: string, target: VoiceTarget, next: string, reason: string, source: WorkspaceRevision["source"]): Promise<WorkspaceRevision> {
    const validated = await this.validateVoiceTarget(target);
    if (validated.kind !== target.kind) throw new Error("The document target is stale. Choose the visible scope and try again.");
    const previous = await this.readTargetContent(validated);
    const revision: WorkspaceRevision = {
      id: makeId("revision"),
      anchorFeedId,
      target: validated,
      previous,
      next,
      reason,
      source,
      status: "applied",
      createdAt: isoNow(),
    };
    await this.writeTargetContent(validated, next);
    await this.revisions.writeWorkspaceRevision(revision);
    await this.appendEvent({ feedId: anchorFeedId, type: "revision.applied", detail: { revisionId: revision.id, target: validated, source } });
    return revision;
  }

  async revertWorkspaceRevision(revisionId: string): Promise<WorkspaceRevision> {
    const revision = await this.readWorkspaceRevision(revisionId);
    if (revision.status !== "applied") throw new Error("Workspace revision is not active.");
    const current = await this.readTargetContent(revision.target);
    if (current.trimEnd() !== revision.next.trimEnd()) throw new Error("Workspace content changed after this revision. Undo the newest revision first.");
    revision.status = "reverted";
    revision.revertedAt = isoNow();
    await this.writeTargetContent(revision.target, revision.previous);
    await this.revisions.writeWorkspaceRevision(revision);
    await this.appendEvent({ feedId: revision.anchorFeedId, type: "revision.reverted", detail: { revisionId, target: revision.target } });
    return revision;
  }

  async validateVoiceTarget(target: VoiceTarget): Promise<VoiceTarget> {
    if (await this.isValidVoiceTarget(target)) {
      if (target.kind !== "sweep") return target;
      const sweep = await this.readSweepState(target.feedId);
      return { kind: "sweep", feedId: target.feedId, ...(sweep.currentBatchId ? { batchId: sweep.currentBatchId } : {}) };
    }
    if (target.kind === "card") return this.validateVoiceTarget({ kind: "sweep", feedId: target.feedId });
    if (target.kind === "sweep" || target.kind === "source_recipe" || target.kind === "prompt_layer") return this.validateVoiceTarget({ kind: "feed", feedId: target.feedId });
    if (target.kind === "feed" || target.kind === "global_prompt") return { kind: "attention" };
    return target;
  }

  async readTargetContent(target: VoiceTarget): Promise<string> {
    if (target.kind === "feed") return this.textDocuments.read(`feeds/${target.feedId}/policy.md`);
    if (target.kind === "source_recipe") {
      return (await this.sources.get(target.feedId, target.sourceId)).content;
    }
    if (target.kind === "prompt_layer") return this.textDocuments.read(`feeds/${target.feedId}/prompts/${target.promptId}`);
    if (target.kind === "global_prompt") return this.textDocuments.read(`prompts/${target.promptId}`);
    if (target.kind === "attention") return this.textDocuments.read("global-policy.md");
    throw new Error("This target does not contain editable prompt content.");
  }

  async writeTargetContent(target: VoiceTarget, content: string): Promise<void> {
    const normalized = content.replace(/\\n/g, "\n").trim();
    if (!normalized) throw new Error("Workspace content is required.");
    if (target.kind === "feed") return this.textDocuments.write(`feeds/${target.feedId}/policy.md`, normalized);
    if (target.kind === "source_recipe") {
      return this.sources.writeContent(target.feedId, target.sourceId, normalized);
    }
    if (target.kind === "prompt_layer") return this.textDocuments.write(`feeds/${target.feedId}/prompts/${target.promptId}`, normalized);
    if (target.kind === "global_prompt") return this.writeGlobalPrompt(target.promptId, normalized);
    if (target.kind === "attention") return this.textDocuments.write("global-policy.md", normalized);
    throw new Error("This target does not contain editable prompt content.");
  }

  async readFeed(feedId: string): Promise<FeedView> {
    const config = await this.readConfig(feedId);
    const [thread, sourceRecords, policy, cards, routineActions, work, sweep] = await Promise.all([
      readJson<ThreadBinding>(this.feedPath(feedId, "thread.json")),
      this.sources.list(feedId),
      this.textDocuments.read(`feeds/${feedId}/policy.md`),
      this.cards.list(feedId),
      this.routineActionGroups.list(feedId),
      this.workItems.list(feedId),
      this.readSweepState(feedId),
    ]);
    cards.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    routineActions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    work.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      config,
      thread,
      sources: sourceRecords.map((record) => record.recipe),
      policy,
      cards,
      routineActions,
      work,
      sweep,
      readyNextPass: cards.filter((card) => card.status === "to_review_updated" && card.readyForPass > config.currentPass).length,
    };
  }

  async readSweepState(feedId: string): Promise<SweepState> {
    return this.sweeps.readState(feedId);
  }

  async writeSweepState(feedId: string, state: SweepState): Promise<void> {
    await this.sweeps.writeState(feedId, state);
  }

  async writeSweepFeedback(trace: SweepFeedbackTrace): Promise<void> {
    await this.sweeps.writeFeedback(trace);
  }

  async readSweepFeedback(feedId: string, feedbackId: string): Promise<SweepFeedbackTrace> {
    return this.sweeps.getFeedback(feedId, feedbackId);
  }

  async writeSweepBatch(batch: SweepBatch): Promise<void> {
    await this.sweeps.writeBatch(batch);
  }

  async readConfig(feedId: string): Promise<FeedConfig> {
    return readJson<FeedConfig>(this.feedPath(feedId, "feed.json"));
  }

  async writeConfig(config: FeedConfig): Promise<void> {
    config.updatedAt = isoNow();
    await writeJson(this.feedPath(config.id, "feed.json"), config);
  }

  async readCard(feedId: string, cardId: string): Promise<Card> {
    return this.cards.get(feedId, cardId);
  }

  async hasCard(feedId: string, cardId: string): Promise<boolean> {
    return this.cards.has(feedId, cardId);
  }

  async writeCard(card: Card): Promise<void> {
    card.updatedAt = isoNow();
    await this.cards.write(card);
  }

  async removeCard(feedId: string, cardId: string): Promise<void> {
    await this.cards.remove(feedId, cardId);
  }

  async readRoutineActionGroup(feedId: string, groupId: string): Promise<RoutineActionGroup> {
    return this.routineActionGroups.get(feedId, groupId);
  }

  async hasRoutineActionGroup(feedId: string, groupId: string): Promise<boolean> {
    return this.routineActionGroups.has(feedId, groupId);
  }

  async writeRoutineActionGroup(group: RoutineActionGroup): Promise<void> {
    group.updatedAt = isoNow();
    await this.routineActionGroups.write(group);
  }

  async readWork(feedId: string, workId: string): Promise<WorkItem> {
    return this.workItems.get(feedId, workId);
  }

  async writeWork(work: WorkItem): Promise<void> {
    work.updatedAt = isoNow();
    await this.workItems.write(work);
  }

  async readThread(feedId: string): Promise<ThreadBinding> {
    return readJson<ThreadBinding>(this.feedPath(feedId, "thread.json"));
  }

  async writeThread(feedId: string, thread: ThreadBinding): Promise<void> {
    await writeJson(this.feedPath(feedId, "thread.json"), thread);
  }

  async appendEvent(event: Omit<FeedEvent, "id" | "at">): Promise<FeedEvent> {
    const full = { ...event, id: makeId("evt"), at: isoNow() };
    await this.events.append(full);
    return full;
  }

  async readEvents(feedId: string): Promise<FeedEvent[]> {
    return this.events.list(feedId);
  }

  async writePolicy(feedId: string, next: string, reason: string, source: PolicyRevision["source"]): Promise<PolicyRevision> {
    const previous = await this.textDocuments.read(`feeds/${feedId}/policy.md`);
    const revision: PolicyRevision = { id: makeId("policy"), feedId, previous, next, reason, source, status: "applied", createdAt: isoNow() };
    await this.textDocuments.write(`feeds/${feedId}/policy.md`, next);
    await this.revisions.writePolicyRevision(revision);
    await this.appendEvent({ feedId, type: "policy.applied", detail: { revisionId: revision.id, source, reason } });
    return revision;
  }

  async revertPolicy(feedId: string, revisionId: string): Promise<PolicyRevision> {
    const revision = await this.revisions.getPolicyRevision(feedId, revisionId);
    if (revision.status !== "applied") throw new Error("Policy revision is not active.");
    revision.status = "reverted";
    revision.revertedAt = isoNow();
    await this.textDocuments.write(`feeds/${feedId}/policy.md`, revision.previous);
    await this.revisions.writePolicyRevision(revision);
    await this.appendEvent({ feedId, type: "policy.reverted", detail: { revisionId } });
    return revision;
  }

  async addSource(feedId: string, recipe: SourceRecipe, markdown: string): Promise<void> {
    await this.sources.write(feedId, recipe, markdown);
    await this.appendEvent({ feedId, type: "source.recipe_added", detail: { sourceId: recipe.id } });
  }

  async removeSource(feedId: string, sourceId: string): Promise<void> {
    await this.sources.remove(feedId, sourceId);
    await this.appendEvent({ feedId, type: "source.recipe_removed", detail: { sourceId } });
  }

  async writeSourceRecipe(feedId: string, sourceId: string, content: string): Promise<void> {
    await this.sources.writeContent(feedId, sourceId, content);
    await this.appendEvent({ feedId, type: "source.recipe_edited", detail: { sourceId } });
  }

  async readSourceContent(feedId: string, sourceId: string): Promise<string> {
    return (await this.sources.get(feedId, sourceId)).content;
  }

  async readSourceCheckpoint(feedId: string, sourceId: string): Promise<unknown> {
    return (await this.sources.get(feedId, sourceId)).checkpoint;
  }

  async writeSourceCheckpoint(feedId: string, sourceId: string, checkpoint: unknown): Promise<void> {
    await this.sources.writeCheckpoint(feedId, sourceId, checkpoint);
  }

  async writeRawSnapshot(feedId: string, runId: string, sourceId: string, snapshotId: string, value: unknown): Promise<void> {
    const file = this.feedPath(feedId, "raw", runId, sourceId, `${snapshotId}.json`);
    if (existsSync(file)) throw new Error("Raw snapshots are immutable.");
    await writeJson(file, value);
  }

  async writeRun(run: SourceRun): Promise<void> {
    await this.sourceRuns.write(run);
  }

  async readRun(feedId: string, runId: string): Promise<SourceRun> {
    return this.sourceRuns.get(feedId, runId);
  }

  async readSweepBatch(feedId: string, batchId: string): Promise<SweepBatch> {
    return this.sweeps.getBatch(feedId, batchId);
  }

  async createFeed(config: FeedConfig, homeThreadId: string | null = null): Promise<FeedView> {
    return this.serialize(async () => {
      const feedIds = await this.workspaceFeeds.listFeedIds();
      if (feedIds.includes(config.id)) throw new Error(`Feed already exists: ${config.id}`);
      await writeJson(this.feedPath(config.id, "feed.json"), config);
      await writeText(this.feedPath(config.id, "feed.md"), `# ${config.name}\n\n${config.purpose}\n`);
      await this.textDocuments.write(`feeds/${config.id}/policy.md`, `# ${config.name} policy\n\n- Start with a high attention bar. Learn from explicit corrections and outcomes.\n`);
      await writeJson(this.feedPath(config.id, "thread.json"), { ...threadBinding(), homeThreadId, boundAt: homeThreadId ? isoNow() : null });
      await writeJson(this.feedPath(config.id, "sources.json"), []);
      await this.ensureFeedTextDocuments(config.id);
      await this.workspaceFeeds.addFeedId(config.id);
      await this.appendEvent({ feedId: config.id, type: "feed.created", detail: { homeThreadId } });
      return this.readFeed(config.id);
    });
  }

  async archiveFeed(feedId: string): Promise<void> {
    await this.serialize(async () => {
      if (feedId === "inbox" || feedId === "company-attention") throw new Error("Default feeds cannot be archived.");
      const feedIds = await this.workspaceFeeds.listFeedIds();
      if (!feedIds.includes(feedId)) throw new Error(`Feed not found: ${feedId}`);
      await this.appendEvent({ feedId, type: "feed.archived" });
      await this.workspaceFeeds.removeFeedId(feedId);
      await mkdir(this.path("archived-feeds"), { recursive: true });
      await rename(this.feedPath(feedId), this.path("archived-feeds", `${feedId}-${Date.now()}`));
    });
  }

  async serialize<T>(callback: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(() => this.withFilesystemLock(callback));
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async withFilesystemLock<T>(callback: () => Promise<T>): Promise<T> {
    const lockPath = this.path(".mutation-lock");
    for (let attempt = 0; attempt < 400; attempt += 1) {
      try {
        await mkdir(lockPath);
        try {
          return await callback();
        } finally {
          await rm(lockPath, { recursive: true, force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    }
    throw new Error("Timed out waiting for the filesystem mutation lock.");
  }

  private async ensureDefaultFeed(feedId: "inbox" | "company-attention"): Promise<void> {
    if (existsSync(this.feedPath(feedId, "feed.json"))) return;
    const inbox = feedId === "inbox";
    const config = inbox
      ? feedConfig({ id: "inbox", name: "Inbox", purpose: "Turn email into a calm, actionable sweep with exact approval before any external send.", defaultCleanup: "Archive the email thread." })
      : feedConfig({ id: "company-attention", name: "Company Attention", purpose: "Surface a small number of exceptional company signals with enough evidence to decide or act.", defaultCleanup: "Dismiss this card and suppress unchanged repeats." });
    await writeJson(this.feedPath(feedId, "feed.json"), config);
    await writeText(this.feedPath(feedId, "feed.md"), `# ${config.name}\n\n${config.purpose}\n`);
    await this.textDocuments.write(`feeds/${feedId}/policy.md`, `# ${config.name} policy\n\n- Start with a high attention bar.\n- Preserve provenance and do not pad.\n`);
    await writeJson(this.feedPath(feedId, "thread.json"), threadBinding());
    await writeJson(this.feedPath(feedId, "sources.json"), []);
    const source = inbox ? inboxRecipe() : companyRecipe();
    await this.addSource(feedId, source.recipe, source.markdown);
    await this.writeCard(setupCard(feedId, inbox ? "inbox" : "company"));
  }

  private async ensureFeedTextDocuments(feedId: string): Promise<void> {
    await this.ensureTextDocumentSeeds(await this.feedTextDocumentSeeds(feedId));
  }

  private async isValidVoiceTarget(target: VoiceTarget): Promise<boolean> {
    if (target.kind === "attention") return true;
    if (target.kind === "global_prompt") return GLOBAL_PROMPT_NAMES.includes(target.promptId as (typeof GLOBAL_PROMPT_NAMES)[number]);
    if (!existsSync(this.feedPath(target.feedId, "feed.json"))) return false;
    if (target.kind === "feed" || target.kind === "sweep") return true;
    if (target.kind === "card") return this.hasCard(target.feedId, target.cardId);
    if (target.kind === "prompt_layer") return FEED_PROMPT_NAMES.includes(target.promptId as (typeof FEED_PROMPT_NAMES)[number]);
    return (await this.sources.list(target.feedId)).some((record) => record.recipe.id === target.sourceId);
  }

  private async ensureTextDocumentSeeds(seeds: TextDocumentSeed[]): Promise<void> {
    for (const seed of seeds) await this.textDocuments.ensure(seed);
  }

  private globalTextDocumentSeeds(): TextDocumentSeed[] {
    return [
      { key: "global-policy.md", content: GLOBAL_POLICY },
      { key: "prompts/judge.md", content: BASE_JUDGE_PROMPT },
      { key: "prompts/compose-card.md", content: COMPOSE_CARD_PROMPT },
      { key: "prompts/execute-work.md", content: EXECUTE_WORK_PROMPT },
      { key: "prompts/distill-policy.md", content: DISTILL_POLICY_PROMPT },
      { key: "prompts/compound.md", content: COMPOUND_PROMPT },
    ];
  }

  private async feedTextDocumentSeeds(feedId: string): Promise<TextDocumentSeed[]> {
    const config = await this.readConfig(feedId);
    return [
      { key: `feeds/${feedId}/policy.md`, content: `# ${config.name} policy\n\n- Start with a high attention bar.\n- Preserve provenance and do not pad.\n` },
      { key: `feeds/${feedId}/prompts/judge.md`, content: "# Feed judge prompt layer\n\nAdd feed-specific judging refinements here. Global policy and the global judge prompt remain in force.\n" },
      { key: `feeds/${feedId}/prompts/compose-card.md`, content: "# Feed card prompt layer\n\nAdd feed-specific card composition refinements here. Keep the outer card calm and compact.\n" },
    ];
  }

  private async readDirectoryJson<T>(directory: string): Promise<T[]> {
    if (!existsSync(directory)) return [];
    const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
    return Promise.all(files.map((file) => readJson<T>(path.join(directory, file))));
  }
}
