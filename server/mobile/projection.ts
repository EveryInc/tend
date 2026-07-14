import type {
  Card,
  CardAction,
  CardBlock,
  FeedView,
  MindContextHistoryItem,
  MindContextUpdate,
  ProposedAction,
  RoutineActionGroup,
  WorkItemView,
} from "../../shared/types";
import { safeConfiguredCardActions } from "../../shared/cardActions";
import {
  MOBILE_SCHEMA_VERSION,
  type MobileActionConfirmation,
  type MobileActionProjection,
  type MobileCardBlock,
  type MobileCardProjection,
  type MobileFeedProjection,
  type MobileMindProjection,
  type MobileMindUpdate,
  type MobileWorkspaceSnapshot,
  type MobileWorkProjection,
} from "../../shared/mobile";
import type { AttentionStore } from "../store";
import { digest, isoNow } from "../util";
import { actionDigest, cleanupDigest, routineActionDigest } from "../workflow/approvals";

const ACTIVE_WORK_STATUSES = new Set(["queued", "working", "approved_blocked"]);

export async function projectMobileWorkspace(store: AttentionStore, now = new Date()): Promise<MobileWorkspaceSnapshot> {
  const feedIds = await store.listFeedIds();
  const feeds = await Promise.all(feedIds.map((feedId) => store.readFeed(feedId)));
  const cards = feeds.flatMap((feed) => projectFeedItems(feed));
  const feedProjections = feeds.map((feed, position) => projectFeed(feed, cards, position));
  const mind = await projectMind(store, now);
  const generatedAt = isoNow();
  const generation = digest({
    schemaVersion: MOBILE_SCHEMA_VERSION,
    feeds: feedProjections,
    cards: cards.map((card) => ({ key: card.key, digest: card.cardDigest })),
    mind,
  });
  return {
    schemaVersion: MOBILE_SCHEMA_VERSION,
    generation,
    generatedAt,
    feeds: feedProjections,
    cards,
    mind,
  };
}

export async function projectMobileCard(
  store: AttentionStore,
  feedId: string,
  cardId: string,
): Promise<MobileCardProjection | null> {
  const feed = await store.readFeed(feedId);
  return projectFeedItems(feed).find((card) => card.cardId === cardId) ?? null;
}

export async function projectMobileRoutineAction(
  store: AttentionStore,
  feedId: string,
  groupId: string,
): Promise<MobileCardProjection | null> {
  const feed = await store.readFeed(feedId);
  return projectFeedItems(feed).find((card) => card.routineActionGroupId === groupId) ?? null;
}

function projectFeed(feed: FeedView, cards: MobileCardProjection[], position: number): MobileFeedProjection {
  const feedCards = cards.filter((card) => card.feedId === feed.config.id);
  const review = feedCards.filter((card) => card.reviewable).sort(reviewSort);
  const latest = review[0] ?? [...feedCards].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  return {
    id: feed.config.id,
    name: sanitizeText(feed.config.name),
    purpose: sanitizeText(feed.config.purpose),
    position,
    currentPass: feed.config.currentPass,
    generation: feedGeneration(feed),
    reviewCount: review.length,
    queuedCount: feedCards.filter((card) => card.status === "queued" || card.status === "approved_blocked").length,
    workingCount: feedCards.filter((card) => card.status === "working").length,
    doneCount: feedCards.filter((card) => card.status === "done" || card.status === "completed").length,
    ...(latest ? { latestCardTitle: latest.title, latestCardUpdatedAt: latest.updatedAt } : {}),
    updatedAt: feed.config.updatedAt,
  };
}

function projectFeedItems(feed: FeedView): MobileCardProjection[] {
  const generation = feedGeneration(feed);
  const proposedGroups = feed.routineActions
    .filter((group) => group.status === "proposed")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const cards = feed.cards
    .filter((card) => !card.sweep?.hidden)
    .sort(cardSort);
  const routineCards = proposedGroups.map((group, index) => projectRoutineGroup(feed, group, generation, index));
  const projectedCards = cards.map((card, index) => projectCard(feed, card, generation, proposedGroups.length + index));
  return [...routineCards, ...projectedCards];
}

function projectCard(feed: FeedView, card: Card, generation: string, reviewIndex: number): MobileCardProjection {
  const reviewable = isReviewableCard(feed, card);
  const actions = visibleCardActions(card).map((action) => projectCardAction(feed, card, action));
  const activeWork = latestActiveWork(feed.work, card.id);
  const base = {
    key: `${feed.config.id}:${card.id}`,
    itemKind: card.kind,
    feedId: feed.config.id,
    cardId: card.id,
    feedGeneration: generation,
    status: card.status,
    ...(reviewable ? { reviewPosition: reviewIndex } : {}),
    reviewable,
    title: sanitizeText(card.title),
    eyebrow: sanitizeText(card.eyebrow),
    why: sanitizeText(card.why),
    ...(card.sourceMailbox ? { sourceMailbox: card.sourceMailbox } : {}),
    ...(card.contextInfluence ? { contextInfluence: sanitizeContextInfluence(card.contextInfluence) } : {}),
    blocks: card.blocks.map(sanitizeBlock),
    actions,
    ...(activeWork ? { activeWork: projectWork(activeWork) } : {}),
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    ...(card.completedAt ? { completedAt: card.completedAt } : {}),
    ...(card.completionDisposition ? { completionDisposition: card.completionDisposition } : {}),
  } satisfies Omit<MobileCardProjection, "cardDigest">;
  return { ...base, cardDigest: digest(base) };
}

function projectRoutineGroup(
  feed: FeedView,
  group: RoutineActionGroup,
  generation: string,
  reviewIndex: number,
): MobileCardProjection {
  const action: MobileActionProjection = {
    id: "approve-routine-action",
    label: sanitizeText(group.proposedAction.label),
    behavior: "approve_action",
    digest: routineActionDigest(group),
    externalMutation: group.proposedAction.externalMutation,
    variant: "primary",
    ...(mobileActionConfirmation(undefined, group.proposedAction) ? { confirmation: mobileActionConfirmation(undefined, group.proposedAction) } : {}),
  };
  const activeWork = group.workId ? feed.work.find((work) => work.id === group.workId) : undefined;
  const base = {
    key: `${feed.config.id}:routine:${group.id}`,
    itemKind: "routine_action_group" as const,
    feedId: feed.config.id,
    cardId: `routine:${group.id}`,
    routineActionGroupId: group.id,
    feedGeneration: generation,
    status: group.status,
    reviewPosition: reviewIndex,
    reviewable: group.status === "proposed",
    title: sanitizeText(group.label),
    eyebrow: "Routine review",
    why: sanitizeText(group.summary),
    blocks: [
      {
        id: "routine-items",
        type: "checklist" as const,
        label: `${group.items.length} ${group.items.length === 1 ? "item" : "items"}`,
        items: group.items.map((item) => ({
          label: sanitizeText(item.title),
          detail: sanitizeText(item.reason),
          checked: false,
        })),
      },
    ],
    actions: [action],
    ...(activeWork ? { activeWork: projectWork(activeWork) } : {}),
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    ...(group.completedAt ? { completedAt: group.completedAt } : {}),
  } satisfies Omit<MobileCardProjection, "cardDigest">;
  return { ...base, cardDigest: digest(base) };
}

function projectCardAction(feed: FeedView, card: Card, action: CardAction): MobileActionProjection {
  const proposed = action.behavior === "approve_action" && action.instruction
    ? {
        label: action.label,
        instruction: action.instruction,
        ...(action.artifactBlockId ? { artifactBlockId: action.artifactBlockId } : {}),
        ...(action.externalMutation !== undefined ? { externalMutation: action.externalMutation } : {}),
        ...(action.mailboxPolicy ? { mailboxPolicy: action.mailboxPolicy } : {}),
      } satisfies ProposedAction
    : undefined;
  const confirmation = proposed ? mobileActionConfirmation(card, proposed) : undefined;
  return {
    id: action.id,
    label: sanitizeText(action.label),
    behavior: action.behavior,
    digest: action.behavior === "default_cleanup"
      ? cleanupDigest(card, feed.config.defaultCleanup)
      : action.behavior === "approve_action"
        ? actionDigest(card, action.id === "proposed-action" ? undefined : action.id)
        : digest({ feedId: feed.config.id, cardId: card.id, action }),
    ...(action.artifactBlockId ? { artifactBlockId: action.artifactBlockId } : {}),
    ...(action.externalMutation !== undefined ? { externalMutation: action.externalMutation } : {}),
    ...(action.variant ? { variant: action.variant } : {}),
    ...(confirmation ? { confirmation } : {}),
  };
}

function visibleCardActions(card: Card): CardAction[] {
  const dismiss: CardAction = {
    id: "dismiss-card",
    label: "Dismiss card",
    behavior: "dismiss_card",
    variant: "secondary",
    shortcut: "d",
  };
  const configuredActions = safeConfiguredCardActions(card.actions);
  if (configuredActions.length) {
    // Local dismissal is always available unless the card author supplied a custom local-dismiss
    // control. Source cleanup remains a separate, explicitly configured action.
    return configuredActions.some((action) => action.behavior === "dismiss_card") ? configuredActions : [dismiss, ...configuredActions];
  }
  if (!card.proposedAction || card.proposedAction.label === "Decide disposition") return [dismiss];
  if (card.proposedAction.label === "Archive" || card.proposedAction.label === "Archive this thread") {
    // The card explicitly proposes archiving the source, so surface the connector cleanup.
    return [dismiss, { id: "default-cleanup", label: "Archive", behavior: "default_cleanup", variant: "primary", shortcut: "x" }];
  }
  return [
    dismiss,
    {
      id: "proposed-action",
      label: card.proposedAction.label,
      behavior: "approve_action",
      instruction: card.proposedAction.instruction,
      artifactBlockId: card.proposedAction.artifactBlockId,
      externalMutation: card.proposedAction.externalMutation,
      mailboxPolicy: card.proposedAction.mailboxPolicy,
      variant: "primary",
      shortcut: "a",
    },
  ];
}

function isReviewableCard(feed: FeedView, card: Card): boolean {
  return (card.status === "to_review_new" || card.status === "to_review_updated")
    && card.readyForPass <= feed.config.currentPass
    && !card.sweep?.hidden
    && !card.routineActionGroupId;
}

function latestActiveWork(work: WorkItemView[], cardId: string): WorkItemView | undefined {
  return work
    .filter((item) => item.cardId === cardId && ACTIVE_WORK_STATUSES.has(item.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function projectWork(work: WorkItemView): MobileWorkProjection {
  const safe = {
    id: work.id,
    kind: work.kind,
    status: work.status,
    ...(work.kind === "instruction" || work.kind === "scoped_instruction" ? { instruction: sanitizeText(work.instruction) } : {}),
    createdAt: work.createdAt,
    updatedAt: work.updatedAt,
    ...(work.response ? { response: sanitizeText(work.response) } : {}),
    ...(work.error ? { error: sanitizeText(work.error) } : {}),
  };
  return { ...safe, digest: digest(safe) };
}

function sanitizeBlock(block: CardBlock): MobileCardBlock {
  const common: MobileCardBlock = {
    id: block.id,
    type: block.type,
    ...(block.label !== undefined ? { label: sanitizeText(block.label) } : {}),
    ...(block.title !== undefined ? { title: sanitizeText(block.title) } : {}),
    ...(block.text !== undefined ? { text: sanitizeText(block.text) } : {}),
    ...(block.value !== undefined ? { value: sanitizeText(block.value) } : {}),
    ...(block.before !== undefined ? { before: sanitizeText(block.before) } : {}),
    ...(block.after !== undefined ? { after: sanitizeText(block.after) } : {}),
    ...(block.editable !== undefined ? { editable: block.editable } : {}),
  };
  if (block.items) {
    common.items = block.items.map((item) => {
      if (typeof item === "string") return sanitizeText(item);
      const link = sanitizeHref(item.href);
      return {
        label: sanitizeText(item.label),
        ...(item.detail !== undefined ? { detail: sanitizeText(item.detail) } : {}),
        ...(item.checked !== undefined ? { checked: item.checked } : {}),
        ...(link.href ? { href: link.href } : {}),
        ...(link.availability ? { linkAvailability: link.availability } : {}),
      };
    });
  }
  if (block.profile) {
    const href = sanitizeHref(block.profile.href);
    const image = sanitizeHref(block.profile.imageUrl);
    const fallback = sanitizeHref(block.profile.fallbackImageUrl);
    common.profile = {
      name: sanitizeText(block.profile.name),
      ...(block.profile.subtitle ? { subtitle: sanitizeText(block.profile.subtitle) } : {}),
      ...(href.href ? { href: href.href } : {}),
      ...(image.href ? { imageUrl: image.href } : {}),
      ...(fallback.href ? { fallbackImageUrl: fallback.href } : {}),
      ...(block.profile.links ? {
        links: block.profile.links.map((link) => {
          const safe = sanitizeHref(link.href);
          return {
            label: sanitizeText(link.label),
            ...(safe.href ? { href: safe.href } : {}),
            ...(safe.availability ? { linkAvailability: safe.availability } : {}),
          };
        }),
      } : {}),
    };
  }
  if (block.video) {
    const href = sanitizeHref(block.video.href);
    common.video = {
      title: sanitizeText(block.video.title),
      ...(href.href ? { href: href.href } : {}),
      ...(href.availability ? { linkAvailability: href.availability } : {}),
    };
  }
  if (block.chart) {
    common.chart = {
      ...(block.chart.unit !== undefined ? { unit: sanitizeText(block.chart.unit) } : {}),
      max: block.chart.max,
      series: [
        { label: sanitizeText(block.chart.series[0].label) },
        { label: sanitizeText(block.chart.series[1].label) },
      ],
      rows: block.chart.rows.map((row) => ({
        label: sanitizeText(row.label),
        values: row.values,
        ...(row.detail !== undefined ? { detail: sanitizeText(row.detail) } : {}),
      })),
      ...(block.chart.note !== undefined ? { note: sanitizeText(block.chart.note) } : {}),
    };
  }
  return common;
}

function sanitizeContextInfluence(value: NonNullable<Card["contextInfluence"]>): NonNullable<Card["contextInfluence"]> {
  return {
    ...value,
    summary: sanitizeText(value.summary),
    ...(value.researchQuestion ? { researchQuestion: sanitizeText(value.researchQuestion) } : {}),
  };
}

export function sanitizeText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer [REDACTED SECRET]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED SECRET]")
    .replace(/\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*\S+/gi, "[REDACTED SECRET]")
    .replace(/\[([^\]]+)\]\(\/api\/artifacts\/[^)]+\)/g, "$1 (available on Mac)")
    .replace(/file:\/\/\S+/g, "[local file available on Mac]")
    .replace(/\/Users\/[^/\s]+/g, "/Users/[REDACTED]")
    .replaceAll(String.fromCharCode(0), "");
}

function sanitizeHref(value?: string): { href?: string; availability?: "external" | "mac_only" } {
  if (!value) return {};
  if (value.startsWith("/api/artifacts/") || value.startsWith("file:") || value.startsWith("/")) {
    return { availability: "mac_only" };
  }
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return {};
    if (
      [...url.searchParams.keys()].some((key) =>
        /(?:^|[_-])(?:access[_-]?token|auth|code|key|secret|sig|signature|token)(?:$|[_-])/i.test(key)
      )
      || /(?:access[_-]?token|auth|code|key|secret|sig|signature|token)=/i.test(url.hash)
    ) {
      return { availability: "mac_only" };
    }
    return { href: url.toString(), availability: "external" };
  } catch {
    return {};
  }
}

export function mobileActionConfirmation(card: Card | undefined, action: ProposedAction): MobileActionConfirmation | undefined {
  if (!action.externalMutation) return undefined;
  const sourceMailbox = card?.sourceMailbox?.trim().toLowerCase();
  const artifact = action.artifactBlockId ? card?.blocks.find((block) => block.id === action.artifactBlockId) : undefined;
  const recipients = uniqueEmails(action.label, action.instruction, artifact?.value, artifact?.text)
    .filter((email) => email !== sourceMailbox);
  if (!recipients.length) return undefined;
  return {
    kind: "external_recipient",
    title: /\bforward/i.test(`${action.label} ${action.instruction}`) ? "Confirm forward" : "Confirm recipients",
    message: `This will authorize one exact external mutation involving ${recipients.join(", ")}. No second chat confirmation will be requested while the card remains unchanged.`,
    recipients,
  };
}

function uniqueEmails(...values: Array<unknown>): string[] {
  const emails = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const match of value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
      emails.add(match[0].toLowerCase());
    }
  }
  return [...emails];
}

function feedGeneration(feed: FeedView): string {
  return digest({
    feedId: feed.config.id,
    createdAt: feed.config.createdAt,
    currentPass: feed.config.currentPass,
  });
}

function cardSort(left: Card, right: Card): number {
  if (left.sweep?.rank !== undefined || right.sweep?.rank !== undefined) {
    return (left.sweep?.rank ?? Number.MAX_SAFE_INTEGER) - (right.sweep?.rank ?? Number.MAX_SAFE_INTEGER);
  }
  if (left.status !== right.status) return left.status === "to_review_updated" ? -1 : 1;
  return (right.completedAt ?? right.updatedAt).localeCompare(left.completedAt ?? left.updatedAt);
}

function reviewSort(left: MobileCardProjection, right: MobileCardProjection): number {
  return (left.reviewPosition ?? Number.MAX_SAFE_INTEGER) - (right.reviewPosition ?? Number.MAX_SAFE_INTEGER);
}

async function projectMind(store: AttentionStore, now: Date): Promise<MobileMindProjection> {
  const updates = await store.listMindContextUpdates();
  const latest = updates.at(-1);
  const lastFresh = [...updates].reverse().find((update) => update.state === "fresh") ?? null;
  const health = mindHealth(latest, now);
  return {
    health,
    current: health === "fresh" && latest?.state === "fresh" ? mobileMindUpdate(latest) : null,
    lastFresh: lastFresh ? mindHistoryItem(lastFresh) : null,
    history: [...updates].reverse().map(mindHistoryItem),
  };
}

function mobileMindUpdate(update: MindContextUpdate): MobileMindUpdate {
  if (
    update.state !== "fresh"
    || !update.observedFrom
    || !update.observedTo
    || !update.summary
    || !update.signals
    || !update.observations
  ) {
    throw new Error("Fresh On Your Mind update is incomplete.");
  }
  return {
    id: update.id,
    state: "fresh",
    publishedAt: update.publishedAt,
    observedFrom: update.observedFrom,
    observedTo: update.observedTo,
    summary: update.summary,
    signals: update.signals,
    observations: update.observations.map(({ href, ...observation }) => {
      const safe = sanitizeHref(href);
      return {
        ...observation,
        ...(safe.href ? { href: safe.href } : {}),
      };
    }),
    contentDigest: update.contentDigest,
    ...(update.freshUntil ? { freshUntil: update.freshUntil } : {}),
  };
}

function mindHealth(latest: MindContextUpdate | undefined, now: Date): MobileMindProjection["health"] {
  if (!latest) return "never_published";
  if (latest.state !== "fresh") return latest.state;
  return latest.freshUntil && new Date(latest.freshUntil) > now ? "fresh" : "stale";
}

function mindHistoryItem(update: MindContextUpdate): MindContextHistoryItem {
  return {
    id: update.id,
    state: update.state,
    publishedAt: update.publishedAt,
    ...(update.observedFrom ? { observedFrom: update.observedFrom } : {}),
    ...(update.observedTo ? { observedTo: update.observedTo } : {}),
    ...(update.summary ? { summary: update.summary } : {}),
    ...(update.reason ? { reason: update.reason } : {}),
    signalCount: update.signals?.length ?? 0,
    sourceCount: update.observations?.length ?? 0,
  };
}
