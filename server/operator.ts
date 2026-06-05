import type { Card, WorkItem } from "../shared/types";

export interface IdleWorkHandshake {
  status: "idle";
  next: "offer_compound_if_sweep_finished";
  message: string;
  compound: {
    meaning: string;
    ifApproved: string;
    ifApprovedWithSearch: string;
  };
}

export interface ClaimedWorkOutput extends WorkItem {
  operatorGuidance?: {
    replyDraftSender: string;
  };
}

export function idleWorkHandshake(feedId: string): IdleWorkHandshake {
  return {
    status: "idle",
    next: "offer_compound_if_sweep_finished",
    message: 'If you completed or refreshed this feed during this turn, ask the user: "Want me to compound what I learned from this sweep?" If this wake began idle, stop quietly rather than repeating the question.',
    compound: {
      meaning: "Review this sweep's cards, feedback, outcomes, and prior policy. Distill an editable feed-policy proposal. Never apply it without user approval.",
      ifApproved: `Run \`attention cli learning:request --feed ${feedId}\`, drain the resulting compound_learnings job, and return the editable proposal for review.`,
      ifApprovedWithSearch: "Compound first. Recollect only after the reviewed policy proposal is applied, or after the user explicitly says to continue without applying it.",
    },
  };
}

export function formatWorkListOutput(feedId: string, work: WorkItem[]): WorkItem[] | IdleWorkHandshake {
  return work.length > 0 ? work : idleWorkHandshake(feedId);
}

export function formatWorkClaimOutput(feedId: string, work: WorkItem | null, card?: Card): ClaimedWorkOutput | IdleWorkHandshake {
  if (!work) return idleWorkHandshake(feedId);
  if (feedId !== "inbox" || !card?.sourceMailbox) return work;
  return {
    ...work,
    operatorGuidance: {
      replyDraftSender: `Write any reply draft as the owner of sourceMailbox (${card.sourceMailbox}). Preserve that sender's voice and signature. Do not sign as an assistant or delegate unless the user's instruction explicitly changes sender.`,
    },
  };
}
