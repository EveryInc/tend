import type { RevisionProposal, VoiceTarget, WorkspaceRevision, WorkspaceView } from "../../types";
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
import { isoNow, makeId, slugify } from "../util";

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
    revisionProposals: {},
    workspaceRevisions: {},
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

function revisionLabel(target: VoiceTarget): string {
  if (target.kind === "global_prompt") return `Global prompt · ${target.promptId}`;
  return "Attention policy";
}

function validateGlobalRevisionTarget(target: VoiceTarget): VoiceTarget {
  if (target.kind === "attention") return target;
  if (target.kind === "global_prompt" && GLOBAL_PROMPT_NAMES.includes(target.promptId)) return target;
  throw new Error("Global revision proposals can only target the attention policy or an allowlisted global prompt.");
}

function readGlobalTargetContent(state: AccountWorkspaceState, target: VoiceTarget): string {
  if (target.kind === "attention") return state.globalPolicy;
  if (target.kind === "global_prompt") return state.prompts[target.promptId] ?? "";
  throw new Error("This target does not contain account content.");
}

function writeGlobalTargetContent(state: AccountWorkspaceState, target: VoiceTarget, content: string): AccountWorkspaceState {
  const normalized = content.replace(/\\n/g, "\n").trim();
  if (!normalized) throw new Error("Workspace content is required.");
  if (target.kind === "attention") return { ...state, globalPolicy: normalized, updatedAt: isoNow() };
  if (target.kind === "global_prompt") return { ...state, prompts: { ...state.prompts, [target.promptId]: normalized }, updatedAt: isoNow() };
  throw new Error("This target does not contain account content.");
}

export function proposeGlobalRevision(state: AccountWorkspaceState, anchorFeedId: string, target: VoiceTarget, instruction: string, next: string, source: RevisionProposal["source"] = "voice") {
  if (!instruction.trim()) throw new Error("Revision instruction is required.");
  if (!next.trim()) throw new Error("Proposed revision content is required.");
  const validated = validateGlobalRevisionTarget(target);
  const proposal: RevisionProposal = {
    id: makeId("proposal"),
    anchorFeedId,
    target: validated,
    label: revisionLabel(validated),
    instruction: instruction.trim(),
    previous: readGlobalTargetContent(state, validated),
    next: next.trim(),
    source,
    status: "proposed",
    createdAt: isoNow(),
  };
  return { state: { ...state, revisionProposals: { ...(state.revisionProposals ?? {}), [proposal.id]: proposal }, updatedAt: isoNow() }, proposal };
}

export function updateGlobalRevisionProposal(state: AccountWorkspaceState, proposalId: string, next: string) {
  if (!next.trim()) throw new Error("Proposed revision content is required.");
  const proposal = state.revisionProposals?.[proposalId];
  if (!proposal) throw new Error("Revision proposal not found.");
  if (proposal.status !== "proposed") throw new Error("Revision proposal is no longer pending.");
  const updated: RevisionProposal = { ...proposal, next: next.trim(), updatedAt: isoNow() };
  return { state: { ...state, revisionProposals: { ...state.revisionProposals, [proposalId]: updated }, updatedAt: isoNow() }, proposal: updated };
}

export function applyGlobalRevisionProposal(state: AccountWorkspaceState, proposalId: string) {
  const proposal = state.revisionProposals?.[proposalId];
  if (!proposal) throw new Error("Revision proposal not found.");
  if (proposal.status !== "proposed") throw new Error("Revision proposal is no longer pending.");
  const current = readGlobalTargetContent(state, proposal.target);
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
  const applied = writeGlobalTargetContent(state, proposal.target, proposal.next);
  const updatedProposal: RevisionProposal = { ...proposal, status: "applied", appliedAt: isoNow(), appliedRevisionId: revision.id };
  return {
    state: {
      ...applied,
      revisionProposals: { ...applied.revisionProposals, [proposalId]: updatedProposal },
      workspaceRevisions: { ...(applied.workspaceRevisions ?? {}), [revision.id]: revision },
      updatedAt: isoNow(),
    },
    revision,
  };
}

export function rejectGlobalRevisionProposal(state: AccountWorkspaceState, proposalId: string) {
  const proposal = state.revisionProposals?.[proposalId];
  if (!proposal) throw new Error("Revision proposal not found.");
  if (proposal.status !== "proposed") throw new Error("Revision proposal is no longer pending.");
  const updated: RevisionProposal = { ...proposal, status: "rejected", rejectedAt: isoNow() };
  return { state: { ...state, revisionProposals: { ...state.revisionProposals, [proposalId]: updated }, updatedAt: isoNow() }, proposal: updated };
}

export function revertGlobalWorkspaceRevision(state: AccountWorkspaceState, revisionId: string) {
  const revision = state.workspaceRevisions?.[revisionId];
  if (!revision) throw new Error("Workspace revision not found.");
  if (revision.status !== "applied") throw new Error("Workspace revision is not active.");
  const current = readGlobalTargetContent(state, revision.target);
  if (current.trimEnd() !== revision.next.trimEnd()) throw new Error("Workspace content changed after this revision. Undo the newest revision first.");
  const reverted = writeGlobalTargetContent(state, revision.target, revision.previous);
  const updated: WorkspaceRevision = { ...revision, status: "reverted", revertedAt: isoNow() };
  return { state: { ...reverted, workspaceRevisions: { ...reverted.workspaceRevisions, [revisionId]: updated }, updatedAt: isoNow() }, revision: updated };
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

export function workspaceFromFeeds(state: AccountWorkspaceState, feedViews: WorkspaceView["active"][], selectedFeedId: string, feedProposals: RevisionProposal[] = []): WorkspaceView {
  const selected = state.feedIds.includes(selectedFeedId) ? selectedFeedId : state.feedIds[0];
  const proposals = [
    ...Object.values(state.revisionProposals ?? {}),
    ...feedProposals,
  ].filter((proposal) =>
    proposal.status === "proposed" &&
    (proposal.anchorFeedId === selected || proposal.target.kind === "attention" || proposal.target.kind === "global_prompt")
  ).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
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
    proposals,
  };
}
