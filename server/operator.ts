import type { Card, SweepFeedbackTrace, WorkItem } from "../shared/types";

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
    replyDraftSender?: string;
    requiredWriteBack?: string;
    completionPrerequisite?: string;
    visibleCardIds?: string[];
    sourceRunRule?: string;
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

export function formatWorkClaimOutput(feedId: string, work: WorkItem | null, card?: Card, sweepFeedback?: Pick<SweepFeedbackTrace, "visibleCardIds">): ClaimedWorkOutput | IdleWorkHandshake {
  if (!work) return idleWorkHandshake(feedId);
  const operatorGuidance: NonNullable<ClaimedWorkOutput["operatorGuidance"]> = {};

  if (feedId === "inbox" && card?.sourceMailbox) {
    operatorGuidance.replyDraftSender = `Write any reply draft as the owner of sourceMailbox (${card.sourceMailbox}). Preserve that sender's voice and signature. Do not sign as an assistant or delegate unless the user's instruction explicitly changes sender.`;
  }

  if (work.intent === "sweep_rejudge") {
    operatorGuidance.requiredWriteBack = "Run `attention cli sweep:rejudge --feed <feed> --feedback <feedbackId> --ordered-cards <json-array-of-original-visible-card-ids> --removed-cards <json-array-of-original-visible-card-ids>` before `work:complete`.";
    operatorGuidance.completionPrerequisite = "The rejudge must account for the feedback trace's original visibleCardIds exactly once. Do not include cards created while handling this work unless they were already in visibleCardIds.";
    operatorGuidance.visibleCardIds = sweepFeedback?.visibleCardIds;
  }

  if (work.intent === "recollect_sources") {
    operatorGuidance.requiredWriteBack = "Record one or more source runs with `source:record-run --work <workId>`, then create a sweep batch with `sweep:record-batch --work <workId>` before `work:complete`.";
    operatorGuidance.sourceRunRule = "Source recollection work must complete with a new sweep batch recorded for this exact work item.";
  }

  return Object.keys(operatorGuidance).length ? { ...work, operatorGuidance } : work;
}
