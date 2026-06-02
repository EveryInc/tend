import type { Card, CardBlock, CardStatus, FeedConfig, FeedView, SourceRecipe } from "../../types";
import {
  companyRecipe,
  feedConfig,
  inboxRecipe,
  setupCard,
  threadBinding,
} from "../../../server/templates";
import type { FeedState } from "../env";
import { isoNow, slugify } from "../util";

type AgentCardShape = Partial<Card> & {
  done?: unknown;
  evidence?: unknown;
  provenance?: unknown;
  source?: unknown;
  sourceId?: unknown;
  status?: unknown;
  suggestedAction?: unknown;
  summary?: unknown;
};

const CARD_STATUSES: CardStatus[] = ["to_review_new", "to_review_updated", "queued", "working", "approved_blocked", "done"];

export const FEED_PROMPT_DEFAULTS: Record<string, string> = {
  "judge.md": "# Feed judge prompt layer\n\nAdd feed-specific judging refinements here. Global policy and the global judge prompt remain in force.\n",
  "compose-card.md": "# Feed card prompt layer\n\nAdd feed-specific card composition refinements here. Keep the outer card calm and compact.\n",
};

export const FEED_PROMPT_NAMES = Object.keys(FEED_PROMPT_DEFAULTS);

function defaultSweepState() {
  return {
    currentBatchId: null,
    lastFeedbackId: null,
    recollectionOffered: false,
    statusMessage: null,
  };
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function evidenceItems(value: unknown): CardBlock["items"] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => typeof item === "string" ? item : { label: JSON.stringify(item) });
}

function provenanceText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return text(value);
  return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${key}: ${typeof item === "string" || typeof item === "number" || typeof item === "boolean" ? String(item) : JSON.stringify(item)}`)
    .join("\n");
}

function generatedBlocks(card: AgentCardShape, fallback: CardBlock[] = []): CardBlock[] {
  const normalized = normalizeCardBlocks(card.blocks, fallback);
  if (normalized.length > 0) return normalized;

  const blocks: CardBlock[] = [];
  const summary = text(card.summary);
  const suggestedAction = text(card.suggestedAction);
  const evidence = evidenceItems(card.evidence);
  const provenance = provenanceText(card.provenance);

  if (summary) blocks.push({ id: "summary", type: "memo", label: "Summary", text: summary });
  if (suggestedAction) blocks.push({ id: "suggested-action", type: "clarification", label: "Suggested action", text: suggestedAction });
  if (evidence?.length) blocks.push({ id: "evidence", type: "evidence", label: "Evidence", items: evidence });
  if (provenance) blocks.push({ id: "provenance", type: "memo", label: "Provenance", text: provenance });

  return blocks;
}

export function normalizeCardStatus(status: unknown, done: unknown, fallback: CardStatus = "to_review_new"): CardStatus {
  if (CARD_STATUSES.includes(status as CardStatus)) return status as CardStatus;
  if (done === true || status === "done" || status === "completed") return "done";
  if (status === "open") return "to_review_new";
  return fallback;
}

export function normalizeCardBlocks(blocks: unknown, fallback: CardBlock[] = []): CardBlock[] {
  const value = Array.isArray(blocks) ? blocks : fallback;
  return value.map((block, index): CardBlock => {
    if (block && typeof block === "object") {
      const item = block as Partial<CardBlock>;
      return {
        ...item,
        id: typeof item.id === "string" && item.id.trim() ? item.id : `block-${index + 1}`,
        type: typeof item.type === "string" && item.type.trim() ? item.type as CardBlock["type"] : "memo",
      };
    }
    return { id: `block-${index + 1}`, type: "memo", text: String(block ?? "") };
  });
}

export function normalizeCard(card: Card): Card {
  const agentCard = card as AgentCardShape;
  return {
    ...card,
    status: normalizeCardStatus(agentCard.status, agentCard.done, card.status),
    why: text(card.why) ?? text(agentCard.summary) ?? "",
    blocks: generatedBlocks(agentCard),
  };
}

export function defaultFeedState(feedId: string): FeedState {
  const inbox = feedId === "inbox";
  const config = inbox
    ? feedConfig({ id: "inbox", name: "Inbox", purpose: "Turn email into a calm, actionable sweep with exact approval before any external send.", defaultCleanup: "Archive the email thread." })
    : feedId === "company-attention"
      ? feedConfig({ id: "company-attention", name: "Company Attention", purpose: "Surface a small number of exceptional company signals with enough evidence to decide or act.", defaultCleanup: "Dismiss this card and suppress unchanged repeats." })
      : feedConfig({ id: feedId, name: feedId, purpose: "Hosted attention feed.", defaultCleanup: "Dismiss this card and perform the feed's configured cleanup." });
  const source = inbox ? inboxRecipe() : companyRecipe();
  const card = setupCard(feedId, inbox ? "inbox" : "company");
  const now = isoNow();
  return {
    config,
    thread: threadBinding(),
    policy: `# ${config.name} policy\n\n- Start with a high attention bar.\n- Preserve provenance and do not pad.\n`,
    sources: [{ ...source.recipe, content: source.markdown } as SourceRecipe],
    cards: { [card.id]: card },
    routineActions: {},
    work: {},
    events: [],
    policyRevisions: {},
    checkpoints: { [source.recipe.id]: { sourceId: source.recipe.id, updatedAt: null, cursor: null } },
    runs: {},
    sweep: defaultSweepState(),
    sweepFeedback: {},
    sweepBatches: {},
    revisionProposals: {},
    workspaceRevisions: {},
    prompts: { ...FEED_PROMPT_DEFAULTS },
    createdAt: now,
    updatedAt: now,
  };
}

export function feedView(state: FeedState): FeedView {
  const cards = Object.values(state.cards).map(normalizeCard).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const routineActions = Object.values(state.routineActions ?? {}).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const work = Object.values(state.work).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    config: state.config,
    thread: state.thread,
    sources: state.sources,
    policy: state.policy,
    cards,
    routineActions,
    work,
    sweep: state.sweep ?? defaultSweepState(),
    readyNextPass: cards.filter((card) => card.status === "to_review_updated" && card.readyForPass > state.config.currentPass).length,
  };
}

export function inspectFeed(state: FeedState) {
  return {
    feed: state.config,
    thread: state.thread,
    policy: state.policy,
    runner: feedRunnerSetup(state),
    prompts: FEED_PROMPT_NAMES.map((name) => ({ name, content: state.prompts?.[name] ?? FEED_PROMPT_DEFAULTS[name] ?? "" })),
    sources: state.sources.map((source) => ({
      ...source,
      content: (source as SourceRecipe & { content?: string }).content ?? source.summary,
      checkpoint: JSON.stringify(state.checkpoints[source.id] ?? null, null, 2),
    })),
  };
}

function feedRunnerSetup(state: FeedState) {
  const threadId = state.thread.homeThreadId ?? "<local-codex-thread-id>";
  return {
    recommendedAutomationName: `${state.config.name} feed runner`,
    recommendedCadence: "every 30 minutes",
    threadId,
    phases: [
      "Confirm this Codex thread is bound to the feed.",
      "List queued work for this feed and thread.",
      "Claim queued work before using local connectors for that instruction.",
      "Execute claimed work, upsert canonical cards only after the claim is held, and complete or fail each item with a response and evidence.",
      "Use id, title, why, and blocks with stable block ids/types when upserting cards.",
      "Include response plus done: true when completing close, ignore, dismiss, or already-handled instructions.",
      "Call verify_action immediately before approved external mutations.",
      "Refresh configured sources opportunistically only when no queued work is being handled.",
    ],
    heartbeatPrompt: `Run the Attention feed ${state.config.id} as its local feed runner. Use threadId ${threadId}. Confirm binding, inspect feed setup/state, then list queued work before using local connectors. If queued work exists, claim a small batch first; for each claimed instruction, execute allowed work with local tools/connectors, upsert cards only after the relevant claim is held, and use the canonical card shape: id, title, why, and blocks with stable block ids/types. Verify approved external mutations immediately before acting, and complete or fail the claim with response and evidence. For close, ignore, dismiss, or already-handled instructions, update the card to status "done" and include response plus done: true in complete_work. When no queued work is being handled, refresh configured sources with local Codex connectors when available, upsert only useful cards with provenance in blocks, and record source runs/checkpoints when supported. Do not create a second runner thread unless the user explicitly asks.`,
  };
}

export function createCustomFeedState(config: FeedConfig, brief: string, currentThreadId: string | null): FeedState {
  const now = isoNow();
  const state: FeedState = {
    config,
    thread: { ...threadBinding(), homeThreadId: currentThreadId || null, boundAt: currentThreadId ? now : null },
    policy: `# ${config.name} policy\n\n- Start with a high attention bar. Learn from explicit corrections and outcomes.\n`,
    sources: [],
    cards: {},
    work: {},
    events: [],
    policyRevisions: {},
    checkpoints: {},
    runs: {},
    routineActions: {},
    sweep: defaultSweepState(),
    sweepFeedback: {},
    sweepBatches: {},
    revisionProposals: {},
    workspaceRevisions: {},
    prompts: { ...FEED_PROMPT_DEFAULTS },
    createdAt: now,
    updatedAt: now,
  };
  state.cards["guided-source-setup"] = {
    id: "guided-source-setup",
    feedId: config.id,
    kind: "feed_improvement",
    status: "to_review_new",
    eyebrow: "Feed setup",
    title: `Teach ${config.name} where to look.`,
    why: "The feed exists. Codex should now propose the smallest useful source recipe and a heartbeat cadence for review.",
    blocks: [
      { id: "brief", type: "memo", label: "Your brief", text: brief },
      { id: "clarify", type: "clarification", label: "Next step", text: "Wake this feed's Codex thread or use the dock. Codex will propose sources in plain English before collecting." },
    ],
    proposedAction: { label: "Propose source recipe", instruction: "Based on this feed brief, propose the smallest useful real source recipe and a heartbeat cadence. Return the proposal for review before collecting." },
    readyForPass: 1,
    createdAt: now,
    updatedAt: now,
    history: [],
  };
  return state;
}

export function createFeedConfigFromBrief(brief: string): { config: FeedConfig; normalizedBrief: string } {
  if (!brief.trim()) throw new Error("Describe the feed you want.");
  const normalizedBrief = brief.replace(/\\n/g, "\n").trim();
  const firstLine = normalizedBrief.split("\n")[0].replace(/^#+\s*/, "");
  const name = firstLine.length <= 60 ? firstLine : `${firstLine.slice(0, 57).trimEnd()}...`;
  return {
    normalizedBrief,
    config: feedConfig({ id: slugify(name), name, purpose: normalizedBrief, defaultCleanup: "Dismiss this card and perform the feed's configured cleanup." }),
  };
}

export function sourceRecipeFromBrief(brief: string): { recipe: SourceRecipe; markdown: string } {
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

Preserve timestamps, locators, and content hashes in immutable hosted raw snapshots. Advance the
checkpoint only after the run record is durable. Return no candidate rather than padding.
`,
  };
}
