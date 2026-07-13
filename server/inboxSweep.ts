import { containsFullEmail } from "../shared/emailThread";
import type {
  Card,
  CardAction,
  CardBlock,
  InboxCollectionReceipt,
  InboxCoverageReceipt,
  ProposedAction,
  WorkItem,
} from "../shared/types";
import { validateCardActions, validateCardBlocks } from "./cardBlocks";
import type { AttentionStore } from "./store";
import { isoNow, makeId, safeIdentifier } from "./util";

const INBOX_FEED_ID = "inbox";
const EMAIL_THREAD_DISPLAY_LIMIT = 200_000;

export class InboxThreadSnapshotNotFoundError extends Error {}

export interface InboxSnapshotInput {
  threadId: string;
  threadText: string;
  value: Record<string, unknown>;
}

export interface InboxCardDraft {
  id: string;
  sourceItemId: string;
  title: string;
  why: string;
  eyebrow?: string;
  sourceMailbox?: string;
  blocks: CardBlock[];
  proposedAction: ProposedAction;
  actions: CardAction[];
}

export interface InboxSweepResult {
  runId: string;
  batchId: string;
  threadCount: number;
  cardCount: number;
  removedCardIds: string[];
}

export interface InboxCollectionAbandonment {
  collectionId: string;
  abandonedAt: string;
  reason: string;
}

interface InboxSweepDependencies {
  assertRecollectionWork(feedId: string, workId: string): Promise<WorkItem>;
  assertAbandonableRecollectionWork(feedId: string, workId: string): Promise<WorkItem>;
  supersedeRoutineGroups(feedId: string, reason: string): Promise<string[]>;
}

interface NormalizedInboxSweep {
  snapshots: InboxSnapshotInput[];
  cards: InboxCardDraft[];
  collection: InboxCollectionReceipt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, label);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function parseProposedAction(value: unknown, cardId: string): ProposedAction {
  if (!isRecord(value)) throw new Error(`Inbox card ${cardId} needs a concrete proposedAction.`);
  const label = requiredText(value.label, `Inbox card ${cardId} proposedAction label`);
  if (["approve", "decide disposition"].includes(label.toLowerCase())) {
    throw new Error(`Inbox card ${cardId} needs a specific proposedAction label.`);
  }
  const mailboxPolicy = value.mailboxPolicy;
  if (mailboxPolicy !== undefined && mailboxPolicy !== "reply_from_source") {
    throw new Error(`Inbox card ${cardId} proposedAction has an invalid mailboxPolicy.`);
  }
  return {
    label,
    instruction: requiredText(value.instruction, `Inbox card ${cardId} proposedAction instruction`),
    ...(optionalText(value.artifactBlockId, `Inbox card ${cardId} proposedAction artifactBlockId`) ? { artifactBlockId: String(value.artifactBlockId).trim() } : {}),
    ...(optionalBoolean(value.externalMutation, `Inbox card ${cardId} proposedAction externalMutation`) !== undefined ? { externalMutation: Boolean(value.externalMutation) } : {}),
    ...(mailboxPolicy ? { mailboxPolicy } : {}),
  };
}

function parseCardAction(value: unknown, cardId: string, index: number): CardAction {
  if (!isRecord(value)) throw new Error(`Inbox card ${cardId} action ${index + 1} is invalid.`);
  const behavior = value.behavior;
  if (behavior !== "queue_instruction" && behavior !== "approve_action" && behavior !== "default_cleanup") {
    throw new Error(`Inbox card ${cardId} action ${index + 1} has an invalid behavior.`);
  }
  const mailboxPolicy = value.mailboxPolicy;
  if (mailboxPolicy !== undefined && mailboxPolicy !== "reply_from_source") {
    throw new Error(`Inbox card ${cardId} action ${index + 1} has an invalid mailboxPolicy.`);
  }
  const variant = value.variant;
  if (variant !== undefined && variant !== "primary" && variant !== "secondary") {
    throw new Error(`Inbox card ${cardId} action ${index + 1} has an invalid variant.`);
  }
  return {
    id: requiredText(value.id, `Inbox card ${cardId} action ${index + 1} id`),
    label: requiredText(value.label, `Inbox card ${cardId} action ${index + 1} label`),
    behavior,
    ...(optionalText(value.instruction, `Inbox card ${cardId} action ${index + 1} instruction`) ? { instruction: String(value.instruction).trim() } : {}),
    ...(optionalText(value.artifactBlockId, `Inbox card ${cardId} action ${index + 1} artifactBlockId`) ? { artifactBlockId: String(value.artifactBlockId).trim() } : {}),
    ...(optionalBoolean(value.externalMutation, `Inbox card ${cardId} action ${index + 1} externalMutation`) !== undefined ? { externalMutation: Boolean(value.externalMutation) } : {}),
    ...(mailboxPolicy ? { mailboxPolicy } : {}),
    ...(variant ? { variant } : {}),
    ...(optionalText(value.shortcut, `Inbox card ${cardId} action ${index + 1} shortcut`) ? { shortcut: String(value.shortcut).trim() } : {}),
  };
}

function parseSnapshots(value: unknown): InboxSnapshotInput[] {
  if (!Array.isArray(value)) throw new Error("Inbox snapshots must be an array.");
  const seen = new Set<string>();
  return value.map((snapshot, index) => {
    if (!isRecord(snapshot)) throw new Error(`Inbox snapshot ${index + 1} must be an object.`);
    const threadId = safeIdentifier(requiredText(snapshot.threadId, `Inbox snapshot ${index + 1} threadId`), `Inbox snapshot ${index + 1} threadId`);
    const threadText = requiredText(snapshot.threadText, `Inbox snapshot ${index + 1} threadText`);
    if (!containsFullEmail(threadText)) throw new Error(`Inbox snapshot ${index + 1} threadText needs From, To, and Subject headers.`);
    if (seen.has(threadId)) throw new Error(`Inbox snapshot threadId is duplicated: ${threadId}`);
    seen.add(threadId);
    return { threadId, threadText, value: snapshot };
  });
}

function parseCards(value: unknown, snapshots: Map<string, InboxSnapshotInput>): InboxCardDraft[] {
  if (!Array.isArray(value)) throw new Error("Inbox cards must be an array.");
  const seenCards = new Set<string>();
  const seenThreads = new Set<string>();
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`Inbox card ${index + 1} must be an object.`);
    const sourceItemId = safeIdentifier(requiredText(candidate.sourceItemId, `Inbox card ${index + 1} sourceItemId`), `Inbox card ${index + 1} sourceItemId`);
    const id = safeIdentifier(requiredText(candidate.id, `Inbox card ${index + 1} id`), `Inbox card ${index + 1} id`);
    if (id !== `inbox-thread-${sourceItemId}`) throw new Error(`Inbox card ${id} must use the deterministic id inbox-thread-${sourceItemId}.`);
    if (seenCards.has(id)) throw new Error(`Inbox card id is duplicated: ${id}`);
    if (seenThreads.has(sourceItemId)) throw new Error(`Inbox thread ${sourceItemId} maps to more than one card.`);
    seenCards.add(id);
    seenThreads.add(sourceItemId);

    validateCardBlocks(candidate.blocks);
    const emailBlocks = candidate.blocks.filter((block) => block.type === "email_thread");
    const email = emailBlocks[0];
    if (emailBlocks.length !== 1 || !email || email.sourceSnapshot || !email.text) {
      throw new Error(`Inbox card ${id} needs exactly one inline full email_thread block.`);
    }
    const snapshot = snapshots.get(sourceItemId);
    if (!snapshot) throw new Error(`Inbox card ${id} references threadId ${sourceItemId}, which is absent from snapshots.`);
    if (email.text !== snapshot.threadText) throw new Error(`Inbox card ${id} email_thread must match authoritative snapshot threadText.`);
    if (!Array.isArray(candidate.actions) || candidate.actions.length === 0) throw new Error(`Inbox card ${id} needs at least one concrete action.`);

    const actions = candidate.actions.map((action, actionIndex) => parseCardAction(action, id, actionIndex));
    validateCardActions(actions);
    return {
      id,
      sourceItemId,
      title: requiredText(candidate.title, `Inbox card ${id} title`),
      why: requiredText(candidate.why, `Inbox card ${id} why`),
      eyebrow: optionalText(candidate.eyebrow, `Inbox card ${id} eyebrow`),
      sourceMailbox: optionalText(candidate.sourceMailbox, `Inbox card ${id} sourceMailbox`),
      blocks: candidate.blocks,
      proposedAction: parseProposedAction(candidate.proposedAction, id),
      actions,
    };
  });
}

function parseCollection(value: unknown, snapshotIds?: Set<string>, allowIncomplete = false): InboxCollectionReceipt {
  if (!isRecord(value) || value.query !== "in:inbox" || !Array.isArray(value.pages) || value.pages.length === 0) {
    throw new Error("Inbox finalization needs an ordered Gmail page ledger for query in:inbox.");
  }
  const id = safeIdentifier(requiredText(value.id, "Inbox collection id"), "Inbox collection id");
  const sourceId = safeIdentifier(requiredText(value.sourceId, "Inbox collection sourceId"), "Inbox collection sourceId");
  const triggerWorkId = value.triggerWorkId === undefined
    ? undefined
    : safeIdentifier(requiredText(value.triggerWorkId, "Inbox collection triggerWorkId"), "Inbox collection triggerWorkId");
  const rawPages = value.pages;
  const collectedAt = requiredText(value.collectedAt, "Inbox collection collectedAt");
  if (!Number.isFinite(Date.parse(collectedAt))) throw new Error("Inbox collection collectedAt must be an ISO timestamp.");

  const observedIds = new Set<string>();
  let expectedRequestToken: string | null = null;
  const pages = rawPages.map((page, index) => {
    if (!isRecord(page) || !Array.isArray(page.threadIds)) throw new Error(`Inbox page ${index + 1} is invalid.`);
    const receiptId = safeIdentifier(requiredText(page.receiptId, `Inbox page ${index + 1} receiptId`), `Inbox page ${index + 1} receiptId`);
    const requestPageToken = page.requestPageToken;
    const nextPageToken = page.nextPageToken;
    if (requestPageToken !== null && typeof requestPageToken !== "string") throw new Error(`Inbox page ${index + 1} requestPageToken is invalid.`);
    if (nextPageToken !== null && (typeof nextPageToken !== "string" || !nextPageToken.trim())) throw new Error(`Inbox page ${index + 1} nextPageToken is invalid.`);
    if (requestPageToken !== expectedRequestToken) throw new Error(`Inbox page ${index + 1} does not continue the previous page token.`);
    if (index < rawPages.length - 1 && nextPageToken === null) throw new Error(`Inbox page ${index + 1} ends before the recorded final page.`);
    if (!allowIncomplete && index === rawPages.length - 1 && nextPageToken !== null) throw new Error("Inbox page ledger is incomplete because the final page still has a nextPageToken.");
    const threadIds = page.threadIds.map((threadId, threadIndex) => safeIdentifier(requiredText(threadId, `Inbox page ${index + 1} thread ${threadIndex + 1}`), `Inbox page ${index + 1} thread id`));
    for (const threadId of threadIds) {
      if (observedIds.has(threadId)) throw new Error(`Inbox page ledger repeats threadId ${threadId}.`);
      observedIds.add(threadId);
    }
    expectedRequestToken = nextPageToken;
    return { receiptId, requestPageToken, nextPageToken, threadIds };
  });

  if (snapshotIds) {
    const missing = [...snapshotIds].filter((threadId) => !observedIds.has(threadId));
    const unexpected = [...observedIds].filter((threadId) => !snapshotIds.has(threadId));
    if (missing.length || unexpected.length) {
      throw new Error(`Inbox page ledger does not match snapshots. Missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}.`);
    }
  }
  return { id, sourceId, ...(triggerWorkId ? { triggerWorkId } : {}), query: "in:inbox", collectedAt, pages };
}

function normalizeInboxSweep(snapshotsValue: unknown, cardsValue: unknown, collection: InboxCollectionReceipt): NormalizedInboxSweep {
  const snapshots = parseSnapshots(snapshotsValue);
  const snapshotsByThread = new Map(snapshots.map((snapshot) => [snapshot.threadId, snapshot]));
  const cards = parseCards(cardsValue, snapshotsByThread);
  if (cards.length !== snapshots.length) {
    throw new Error(`Inbox coverage is incomplete: ${snapshots.length} threads require exactly ${snapshots.length} cards, not ${cards.length}.`);
  }
  return {
    snapshots,
    cards,
    collection: parseCollection(collection, new Set(snapshotsByThread.keys())),
  };
}

export class InboxSweepService {
  constructor(
    private readonly store: AttentionStore,
    private readonly dependencies: InboxSweepDependencies,
  ) {}

  async recordPage(input: {
    feedId: string;
    sourceId: string;
    collectionId?: string;
    triggerWorkId?: string;
    requestPageToken: unknown;
    nextPageToken: unknown;
    threadIds: unknown;
  }): Promise<InboxCollectionReceipt> {
    const feedId = safeIdentifier(input.feedId, "Feed id");
    const sourceId = safeIdentifier(input.sourceId, "Source id");
    if (feedId !== INBOX_FEED_ID) throw new Error("Inbox page receipts are available only for the Inbox feed.");
    const collectionId = input.collectionId
      ? safeIdentifier(input.collectionId, "Inbox collection id")
      : makeId("inbox-collection");
    const requestPageToken = input.requestPageToken;
    const nextPageToken = input.nextPageToken;
    if (requestPageToken !== null && typeof requestPageToken !== "string") throw new Error("Inbox requestPageToken must be a string or null.");
    if (nextPageToken !== null && (typeof nextPageToken !== "string" || !nextPageToken.trim())) throw new Error("Inbox nextPageToken must be a non-empty string or null.");
    if (!Array.isArray(input.threadIds)) throw new Error("Inbox page threadIds must be an array.");
    const threadIds = input.threadIds.map((threadId, index) => safeIdentifier(requiredText(threadId, `Inbox page thread ${index + 1}`), `Inbox page thread ${index + 1}`));
    if (new Set(threadIds).size !== threadIds.length) throw new Error("Inbox page repeats a threadId.");

    return this.store.serializeAtomic(async () => {
      const feed = await this.store.readFeed(feedId);
      if (!feed.sources.some((source) => source.id === sourceId)) throw new Error(`Source recipe not found: ${sourceId}`);
      if (input.triggerWorkId) await this.dependencies.assertRecollectionWork(feedId, input.triggerWorkId);
      const sweep = await this.store.readSweepState(feedId);
      if (!input.collectionId && sweep.inboxCollection) {
        const finalizedCollectionId = sweep.currentBatchId
          ? (await this.store.readSweepBatch(feedId, sweep.currentBatchId)).inboxCoverage?.collection.id
          : undefined;
        if (finalizedCollectionId !== sweep.inboxCollection.id) {
          throw new Error(`Inbox collection ${sweep.inboxCollection.id} is still active; continue or finalize it before starting another.`);
        }
      }
      const existing = sweep.inboxCollection?.id === collectionId ? sweep.inboxCollection : null;
      if (input.collectionId && !existing) throw new Error(`Inbox collection receipt not found: ${collectionId}`);
      if ((existing?.triggerWorkId ?? undefined) !== input.triggerWorkId && existing) {
        throw new Error("Inbox collection pages must preserve the same recollection work lineage.");
      }
      const priorPages = existing?.pages ?? [];
      const expectedRequestToken = priorPages.at(-1)?.nextPageToken ?? null;
      if (priorPages.length && expectedRequestToken === null) throw new Error("Inbox collection already reached its terminal page.");
      if (requestPageToken !== expectedRequestToken) throw new Error("Inbox page requestPageToken does not continue the recorded collection.");
      const priorThreadIds = new Set(priorPages.flatMap((page) => page.threadIds));
      const duplicate = threadIds.find((threadId) => priorThreadIds.has(threadId));
      if (duplicate) throw new Error(`Inbox collection repeats threadId ${duplicate}.`);

      const collectedAt = existing?.collectedAt ?? isoNow();
      const page = {
        receiptId: makeId("inbox-page"),
        requestPageToken,
        nextPageToken,
        threadIds,
      };
      await this.store.appendEvent({
        feedId,
        type: "inbox.page_collected",
        detail: {
          collectionId,
          sourceId,
          ...(input.triggerWorkId ? { triggerWorkId: input.triggerWorkId } : {}),
          query: "in:inbox",
          collectedAt,
          pageNumber: priorPages.length + 1,
          page,
        },
      });
      const collection = { id: collectionId, sourceId, ...(input.triggerWorkId ? { triggerWorkId: input.triggerWorkId } : {}), query: "in:inbox" as const, collectedAt, pages: [...priorPages, page] };
      await this.store.writeSweepState(feedId, { ...sweep, inboxCollection: collection });
      return collection;
    });
  }

  async abandonCollection(input: {
    feedId: string;
    sourceId: string;
    collectionId: string;
    triggerWorkId?: string;
    reason: string;
  }): Promise<InboxCollectionAbandonment> {
    const feedId = safeIdentifier(input.feedId, "Feed id");
    const sourceId = safeIdentifier(input.sourceId, "Source id");
    const collectionId = safeIdentifier(input.collectionId, "Inbox collection id");
    const reason = requiredText(input.reason, "Inbox collection abandonment reason");
    if (feedId !== INBOX_FEED_ID) throw new Error("Inbox collection abandonment is available only for the Inbox feed.");

    return this.store.serializeAtomic(async () => {
      const feed = await this.store.readFeed(feedId);
      if (!feed.sources.some((source) => source.id === sourceId)) throw new Error(`Source recipe not found: ${sourceId}`);
      if (input.triggerWorkId) await this.dependencies.assertAbandonableRecollectionWork(feedId, input.triggerWorkId);
      const sweep = await this.store.readSweepState(feedId);
      const collection = sweep.inboxCollection;
      if (!collection || collection.id !== collectionId) throw new Error(`Inbox collection receipt not found: ${collectionId}`);
      if (collection.sourceId !== sourceId) throw new Error("Inbox collection receipt belongs to a different source.");
      if ((collection.triggerWorkId ?? undefined) !== input.triggerWorkId) {
        throw new Error("Inbox collection receipt does not belong to this recollection work.");
      }
      if (sweep.currentBatchId) {
        const batch = await this.store.readSweepBatch(feedId, sweep.currentBatchId);
        if (batch.inboxCoverage?.collection.id === collectionId) {
          throw new Error(`Finalized Inbox collection cannot be abandoned: ${collectionId}`);
        }
      }

      const abandonedAt = isoNow();
      await this.store.appendEvent({
        feedId,
        type: "inbox.collection_abandoned",
        detail: { collectionId, sourceId, ...(input.triggerWorkId ? { triggerWorkId: input.triggerWorkId } : {}), reason, abandonedAt, pageCount: collection.pages.length },
      });
      const { inboxCollection: _abandoned, ...nextSweep } = sweep;
      await this.store.writeSweepState(feedId, nextSweep);
      return { collectionId, abandonedAt, reason };
    });
  }

  async finalize(input: {
    feedId: string;
    sourceId: string;
    snapshots: unknown;
    cards: unknown;
    checkpoint: unknown;
    collection: unknown;
    triggerWorkId?: string;
  }): Promise<InboxSweepResult> {
    const feedId = safeIdentifier(input.feedId, "Feed id");
    const sourceId = safeIdentifier(input.sourceId, "Source id");
    if (feedId !== INBOX_FEED_ID) throw new Error("The exhaustive Inbox finalizer is only available for the Inbox feed.");
    const collectionId = safeIdentifier(requiredText(input.collection, "Inbox collection id"), "Inbox collection id");
    const collection = await this.readRecordedCollection(feedId, sourceId, collectionId);
    if (!collection) throw new Error(`Inbox collection receipt not found: ${collectionId}`);
    if ((collection.triggerWorkId ?? undefined) !== input.triggerWorkId) {
      throw new Error("Inbox collection receipt does not belong to this recollection work.");
    }
    const normalized = normalizeInboxSweep(input.snapshots, input.cards, collection);

    return this.store.serializeAtomic(async () => {
      const feed = await this.store.readFeed(feedId);
      if (!feed.sources.some((source) => source.id === sourceId)) throw new Error(`Source recipe not found: ${sourceId}`);
      if (input.triggerWorkId) await this.dependencies.assertRecollectionWork(feedId, input.triggerWorkId);

      const activeSweep = await this.store.readSweepState(feedId);
      if (activeSweep.inboxCollection?.id !== normalized.collection.id) throw new Error("Inbox collection is no longer current.");
      if (activeSweep.currentBatchId) {
        const activeBatch = await this.store.readSweepBatch(feedId, activeSweep.currentBatchId);
        if (activeBatch.inboxCoverage?.collection.id === normalized.collection.id) {
          throw new Error(`Inbox collection receipt has already been finalized: ${normalized.collection.id}`);
        }
      }

      const existingBySourceItem = new Map<string, Card>();
      for (const existing of feed.cards) {
        if (!existing.sourceItemId) continue;
        const prior = existingBySourceItem.get(existing.sourceItemId);
        if (prior && prior.id !== existing.id) throw new Error(`Existing Inbox state duplicates sourceItemId ${existing.sourceItemId}.`);
        existingBySourceItem.set(existing.sourceItemId, existing);
      }
      for (const card of normalized.cards) {
        const prior = existingBySourceItem.get(card.sourceItemId);
        if (prior && prior.id !== card.id) throw new Error(`Stable Inbox mapping changed for thread ${card.sourceItemId}: expected card ${prior.id}, received ${card.id}.`);
      }

      const cardIds = new Set(normalized.cards.map((card) => card.id));
      const sweep = await this.store.readSweepState(feedId);
      const priorBatch = sweep.currentBatchId ? await this.store.readSweepBatch(feedId, sweep.currentBatchId) : null;
      const priorRunIds = new Set(priorBatch?.sourceRunIds ?? []);
      const removedCards = feed.cards.filter((card) =>
        card.status !== "done"
        && !cardIds.has(card.id)
        && Boolean(card.sourceRunIds?.some((runId) => priorRunIds.has(runId))),
      );
      const activeWorkByCard = new Map<string, typeof feed.work>();
      const verifiedMutation = feed.work.find((work) =>
        work.status === "working"
        && Boolean(work.approvalDigest)
        && work.verifiedApprovalDigest === work.approvalDigest
        && (work.kind === "execute_approved_action" || work.kind === "default_cleanup" || work.kind === "routine_action_batch"),
      );
      if (verifiedMutation) {
        throw new Error(`Inbox finalization is blocked while verified external work ${verifiedMutation.id} is in flight.`);
      }
      for (const work of feed.work.filter((item) => item.status === "queued" || item.status === "working" || item.status === "approved_blocked")) {
        activeWorkByCard.set(work.cardId, [...(activeWorkByCard.get(work.cardId) ?? []), work]);
      }
      const removedCleanupRecovery = removedCards.flatMap((card) => activeWorkByCard.get(card.id) ?? []).find((work) =>
        work.status === "approved_blocked"
        && work.kind === "execute_approved_action"
        && work.postAction?.cleanup.status === "blocked",
      );
      if (removedCleanupRecovery) {
        throw new Error(`Inbox finalization is blocked until successful action ${removedCleanupRecovery.id} records its cleanup-only reconciliation.`);
      }

      const now = isoNow();
      const runId = makeId("run");
      const batchId = makeId("batch");
      for (const [index, snapshot] of normalized.snapshots.entries()) {
        await this.store.writeRawSnapshot(feedId, runId, sourceId, `snapshot-${index + 1}`, snapshot.value);
      }
      const snapshotIndex = new Map(normalized.snapshots.map((snapshot, index) => [snapshot.threadId, index + 1]));
      const threadCardMap = normalized.cards.map((card) => ({ threadId: card.sourceItemId, cardId: card.id }));
      await this.store.writeRun({
        id: runId,
        feedId,
        sourceId,
        snapshots: normalized.snapshots.length,
        itemIds: normalized.snapshots.map((snapshot) => snapshot.threadId),
        judgments: threadCardMap.map((item) => ({ ...item, decision: "review" })),
        ...(input.triggerWorkId ? { triggerWorkId: input.triggerWorkId } : {}),
        completedAt: now,
      });

      for (const draft of normalized.cards) {
        const existing = feed.cards.find((card) => card.id === draft.id);
        const preservesSuccessfulAction = (activeWorkByCard.get(draft.id) ?? []).some((work) =>
          work.status === "approved_blocked"
          && work.kind === "execute_approved_action"
          && work.postAction?.cleanup.status === "blocked",
        );
        for (const work of activeWorkByCard.get(draft.id) ?? []) {
          if (
            work.status === "approved_blocked"
            && work.kind === "execute_approved_action"
            && work.postAction?.cleanup.status === "blocked"
          ) continue;
          const staleWork = await this.store.readWork(feedId, work.id);
          staleWork.status = "stale";
          staleWork.error = `Superseded by finalized Inbox sweep ${batchId}; the source thread was refreshed.`;
          staleWork.updatedAt = now;
          await this.store.writeWork(staleWork);
          await this.store.appendEvent({ feedId, cardId: draft.id, workId: staleWork.id, type: "work.stale", detail: { reason: staleWork.error, batchId } });
        }
        const blocks: CardBlock[] = draft.blocks.map((block) => {
          if (block.type !== "email_thread") return block;
          const index = snapshotIndex.get(draft.sourceItemId);
          if (!index) throw new Error(`Inbox snapshot index is missing for ${draft.sourceItemId}.`);
          const { text: _text, ...metadata } = block;
          return { ...metadata, type: "email_thread", sourceSnapshot: { runId, sourceId, snapshotId: `snapshot-${index}` } };
        });
        const card: Card = {
          id: draft.id,
          feedId,
          kind: existing?.kind ?? "attention",
          status: preservesSuccessfulAction ? "approved_blocked" : existing ? "to_review_updated" : "to_review_new",
          title: draft.title,
          eyebrow: draft.eyebrow ?? existing?.eyebrow ?? feed.config.name,
          why: draft.why,
          sourceMailbox: draft.sourceMailbox,
          sourceRunIds: [runId],
          sourceItemId: draft.sourceItemId,
          blocks,
          proposedAction: draft.proposedAction,
          actions: draft.actions,
          readyForPass: feed.config.currentPass,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          history: existing?.history ?? [],
        };
        card.history.push({ at: now, type: "source.reconciled", detail: `${sourceId}:${card.sourceItemId}` });
        await this.store.writeCard(card);
      }
      for (const card of removedCards) {
        const activeWork = activeWorkByCard.get(card.id) ?? [];
        for (const work of activeWork) {
          const staleWork = await this.store.readWork(feedId, work.id);
          staleWork.status = "stale";
          staleWork.error = `Superseded by finalized Inbox sweep ${batchId}; the source thread left the Inbox.`;
          staleWork.updatedAt = now;
          await this.store.writeWork(staleWork);
          await this.store.appendEvent({
            feedId,
            cardId: card.id,
            workId: staleWork.id,
            type: "work.stale",
            detail: { reason: staleWork.error, batchId },
          });
        }
        card.status = "done";
        card.completedAt = now;
        card.history.push({ at: now, type: "source.left_inbox", detail: batchId });
        await this.store.writeCard(card);
      }

      const supersededRoutineGroups = await this.dependencies.supersedeRoutineGroups(feedId, `Superseded by finalized Inbox sweep ${batchId}.`);
      const coverage: InboxCoverageReceipt = {
        sourceId,
        threadCount: normalized.snapshots.length,
        cardCount: normalized.cards.length,
        removedCardIds: removedCards.map((card) => card.id),
        threadCardMap,
        collection: normalized.collection,
        verifiedAt: now,
      };
      await this.store.writeSourceCheckpoint(feedId, sourceId, input.checkpoint);
      await this.store.writeSweepBatch({
        id: batchId,
        feedId,
        sourceRunIds: [runId],
        ...(input.triggerWorkId ? { triggerWorkId: input.triggerWorkId } : {}),
        inboxCoverage: coverage,
        createdAt: now,
      });
      await this.store.writeSweepState(feedId, { currentBatchId: batchId, lastFeedbackId: null, recollectionOffered: false, statusMessage: null, inboxCollection: normalized.collection });
      await this.store.appendEvent({
        feedId,
        workId: input.triggerWorkId,
        type: "inbox.sweep_finalized",
        detail: {
          batchId,
          runId,
          threads: normalized.snapshots.length,
          cards: normalized.cards.length,
          removedCardIds: removedCards.map((card) => card.id),
          supersededRoutineGroups,
          collection: normalized.collection,
        },
      });
      return { runId, batchId, threadCount: normalized.snapshots.length, cardCount: normalized.cards.length, removedCardIds: removedCards.map((card) => card.id) };
    });
  }

  private async readRecordedCollection(
    feedId: string,
    sourceId: string,
    collectionId: string,
    allowMissing = false,
  ): Promise<InboxCollectionReceipt | null> {
    const sweep = await this.store.readSweepState(feedId);
    const consumed = sweep.currentBatchId
      ? (await this.store.readSweepBatch(feedId, sweep.currentBatchId)).inboxCoverage?.collection.id === collectionId
      : false;
    if (consumed) throw new Error(`Inbox collection receipt has already been finalized: ${collectionId}`);
    if (sweep.inboxCollection?.id !== collectionId) {
      if (allowMissing) return null;
      throw new Error(`Inbox collection receipt not found: ${collectionId}`);
    }
    const events = await this.store.readEvents(feedId);
    const pages: Record<string, unknown>[] = [];
    for (const event of events) {
      if (event.type === "inbox.page_collected" && isRecord(event.detail) && event.detail.collectionId === collectionId) {
        pages.push(event.detail);
      }
    }
    if (!pages.length) {
      if (allowMissing) return null;
      throw new Error(`Inbox collection receipt not found: ${collectionId}`);
    }
    const first = pages[0];
    const collection = {
      id: collectionId,
      sourceId: first.sourceId,
      ...(typeof first.triggerWorkId === "string" ? { triggerWorkId: first.triggerWorkId } : {}),
      query: first.query,
      collectedAt: first.collectedAt,
      pages: pages.map((detail, index) => {
        if (
          detail.sourceId !== sourceId
          || detail.triggerWorkId !== first.triggerWorkId
          || detail.pageNumber !== index + 1
          || !isRecord(detail.page)
        ) {
          throw new Error(`Inbox collection ${collectionId} has an invalid immutable page receipt.`);
        }
        return detail.page;
      }),
    };
    const parsed = parseCollection(collection, undefined, allowMissing);
    if (parsed.sourceId !== sourceId) throw new Error("Inbox collection source does not match finalization source.");
    return parsed;
  }

  async readThreadSnapshot(feedIdValue: string, runIdValue: string, sourceIdValue: string, snapshotIdValue: string): Promise<{ text: string; truncated: boolean }> {
    const feedId = safeIdentifier(feedIdValue, "Feed id");
    const runId = safeIdentifier(runIdValue, "Source run id");
    const sourceId = safeIdentifier(sourceIdValue, "Source id");
    const snapshotId = safeIdentifier(snapshotIdValue, "Snapshot id");
    if (feedId !== INBOX_FEED_ID) throw new InboxThreadSnapshotNotFoundError("Email thread snapshots are available only for the Inbox feed.");
    let run;
    try {
      run = await this.store.readRun(feedId, runId);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Source run not found:")) {
        throw new InboxThreadSnapshotNotFoundError(error.message);
      }
      throw error;
    }
    if (run.sourceId !== sourceId) throw new InboxThreadSnapshotNotFoundError("Source snapshot does not belong to this run.");
    if (!(await this.store.hasRawSnapshot(feedId, runId, sourceId, snapshotId))) {
      throw new InboxThreadSnapshotNotFoundError(`Raw snapshot not found: ${snapshotId}`);
    }
    const snapshot = await this.store.readRawSnapshot(feedId, runId, sourceId, snapshotId);
    if (!isRecord(snapshot) || typeof snapshot.threadText !== "string" || !snapshot.threadText.trim()) {
      throw new Error("Source snapshot does not contain a displayable email thread.");
    }
    const truncated = snapshot.threadText.length > EMAIL_THREAD_DISPLAY_LIMIT;
    return {
      text: truncated
        ? `${snapshot.threadText.slice(0, EMAIL_THREAD_DISPLAY_LIMIT)}\n\n[Thread display truncated; the complete immutable snapshot remains in local authority.]`
        : snapshot.threadText,
      truncated,
    };
  }

  async assertReferencedBlocks(feedId: string, cardId: string, sourceItemId: string | undefined, sourceRunIds: string[] | undefined, blocks: CardBlock[]): Promise<void> {
    const emailBlocks = blocks.filter((block) => block.type === "email_thread");
    const sourceBackedInboxCard = feedId === INBOX_FEED_ID && Boolean(sourceItemId && sourceRunIds?.length);
    if (sourceBackedInboxCard && (emailBlocks.length !== 1 || !emailBlocks[0].sourceSnapshot)) {
      throw new Error(`Card ${cardId} must preserve exactly one authoritative snapshot-backed email thread.`);
    }
    const references = emailBlocks.flatMap((block) => block.sourceSnapshot ? [block.sourceSnapshot] : []);
    if (!references.length) return;
    if (!sourceBackedInboxCard || !sourceItemId || !sourceRunIds?.length) {
      throw new Error(`Card ${cardId} snapshot-backed email blocks require Inbox source identity and current source runs.`);
    }
    if (cardId !== `inbox-thread-${sourceItemId}`) {
      throw new Error(`Card ${cardId} must preserve the deterministic Inbox identity inbox-thread-${sourceItemId}.`);
    }
    const duplicate = (await this.store.readFeed(feedId)).cards.find((card) => card.id !== cardId && card.sourceItemId === sourceItemId);
    if (duplicate) throw new Error(`Inbox source item ${sourceItemId} already belongs to card ${duplicate.id}.`);
    for (const reference of references) {
      if (!sourceRunIds.includes(reference.runId)) throw new Error(`Card ${cardId} email snapshot run is not one of the card's source runs.`);
      const run = await this.store.readRun(feedId, reference.runId);
      if (run.sourceId !== reference.sourceId) throw new Error(`Card ${cardId} email snapshot source does not match its source run.`);
      const itemIndex = run.itemIds?.indexOf(sourceItemId) ?? -1;
      if (itemIndex < 0 || reference.snapshotId !== `snapshot-${itemIndex + 1}`) {
        throw new Error(`Card ${cardId} email snapshot does not match source item ${sourceItemId}.`);
      }
      await this.store.readRawSnapshot(feedId, reference.runId, reference.sourceId, reference.snapshotId);
    }
  }
}
