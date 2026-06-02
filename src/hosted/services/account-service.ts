import type { WorkspaceView } from "../../types";
import {
  BASE_JUDGE_PROMPT,
  COMPOUND_PROMPT,
  COMPOSE_CARD_PROMPT,
  DISTILL_POLICY_PROMPT,
  EXECUTE_WORK_PROMPT,
  GLOBAL_POLICY,
} from "../../../server/templates";
import type { AccountWorkspaceState } from "../env";
import { feedConfig } from "../../../server/templates";
import { isoNow, slugify } from "../util";

export const PROMPT_DEFAULTS: Record<string, string> = {
  "judge.md": BASE_JUDGE_PROMPT,
  "compose-card.md": COMPOSE_CARD_PROMPT,
  "execute-work.md": EXECUTE_WORK_PROMPT,
  "distill-policy.md": DISTILL_POLICY_PROMPT,
  "compound.md": COMPOUND_PROMPT,
};

export const GLOBAL_PROMPT_NAMES = Object.keys(PROMPT_DEFAULTS);

export function defaultAccountState(accountId: string): AccountWorkspaceState {
  const now = isoNow();
  return {
    version: 1,
    accountId,
    feedIds: ["inbox", "company-attention"],
    globalPolicy: GLOBAL_POLICY,
    prompts: PROMPT_DEFAULTS,
    createdAt: now,
    updatedAt: now,
  };
}

export function globalPromptWorkspace(state: AccountWorkspaceState) {
  return {
    globalPolicy: state.globalPolicy,
    prompts: GLOBAL_PROMPT_NAMES.map((name) => ({ name, content: state.prompts[name] ?? "" })),
  };
}

export function updateGlobalPolicy(state: AccountWorkspaceState, content: string): AccountWorkspaceState {
  if (!content.trim()) throw new Error("Global policy content is required.");
  return { ...state, globalPolicy: content.replace(/\\n/g, "\n").trim(), updatedAt: isoNow() };
}

export function updateGlobalPrompt(state: AccountWorkspaceState, name: string, content: string): AccountWorkspaceState {
  if (!GLOBAL_PROMPT_NAMES.includes(name)) throw new Error(`Unknown global prompt: ${name}`);
  if (!content.trim()) throw new Error("Prompt content is required.");
  return {
    ...state,
    prompts: { ...state.prompts, [name]: content.replace(/\\n/g, "\n").trim() },
    updatedAt: isoNow(),
  };
}

export function createFeedFromBrief(state: AccountWorkspaceState, brief: string) {
  if (!brief.trim()) throw new Error("Describe the feed you want.");
  const normalizedBrief = brief.replace(/\\n/g, "\n").trim();
  const firstLine = normalizedBrief.split("\n")[0].replace(/^#+\s*/, "");
  const name = firstLine.length <= 60 ? firstLine : `${firstLine.slice(0, 57).trimEnd()}...`;
  const config = feedConfig({ id: slugify(name), name, purpose: normalizedBrief, defaultCleanup: "Dismiss this card and perform the feed's configured cleanup." });
  if (state.feedIds.includes(config.id)) throw new Error(`Feed already exists: ${config.id}`);
  return {
    config,
    normalizedBrief,
    state: { ...state, feedIds: [...state.feedIds, config.id], updatedAt: isoNow() },
  };
}

export function removeFeed(state: AccountWorkspaceState, feedId: string): AccountWorkspaceState {
  if (feedId === "inbox" || feedId === "company-attention") throw new Error("Default feeds cannot be archived.");
  return { ...state, feedIds: state.feedIds.filter((id) => id !== feedId), updatedAt: isoNow() };
}

export function workspaceFromFeeds(state: AccountWorkspaceState, feedViews: WorkspaceView["active"][], selectedFeedId: string): WorkspaceView {
  const selected = state.feedIds.includes(selectedFeedId) ? selectedFeedId : state.feedIds[0];
  return {
    feeds: feedViews.map((feed) => ({ id: feed.config.id, name: feed.config.name, purpose: feed.config.purpose })),
    active: feedViews.find((feed) => feed.config.id === selected) ?? feedViews[0],
    dictation: {
      provider: null,
      status: "not_checked",
      activationCode: "AltRight",
      activationLabel: "Right Option",
      source: "fallback",
      detectedAt: null,
      note: "Hosted Attention keeps dictation in the local Codex Desktop runtime.",
    },
    proposals: [],
  };
}
