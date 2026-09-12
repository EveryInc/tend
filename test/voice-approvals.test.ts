import { describe, expect, test } from "bun:test";
import type { Card } from "../shared/types";
import { hasVoiceApprovalCandidate, matchExplicitVoiceApproval } from "../server/workflow/voiceApprovals";

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: "voice-card",
    feedId: "inbox",
    kind: "attention",
    status: "to_review_new",
    title: "Review the exact draft",
    eyebrow: "Inbox",
    why: "One exact reply is ready.",
    blocks: [{ id: "draft", type: "editable_text", label: "Draft", value: "Exact current draft.", editable: true }],
    actions: [{ id: "send", label: "Send reply", behavior: "approve_action", instruction: "Send the exact current draft.", artifactBlockId: "draft", externalMutation: true }],
    readyForPass: 1,
    createdAt: "2026-09-10T12:00:00.000Z",
    updatedAt: "2026-09-10T12:00:00.000Z",
    history: [],
    ...overrides,
  };
}

describe("explicit voice approval matching", () => {
  test("accepts concise generic approval only for one exact visible artifact", () => {
    expect(matchExplicitVoiceApproval(card(), "This is fine")).toEqual({ actionLabel: "Send reply", cardActionId: "send" });
    expect(matchExplicitVoiceApproval(card({ blocks: [], actions: [{ id: "send", label: "Send reply", behavior: "approve_action", instruction: "Send it." }] }), "This is fine")).toBeUndefined();
  });

  test("accepts an action-specific calendar command while respecting a separate reply negation", () => {
    const calendar = card({
      blocks: [{ id: "details", type: "memo", text: "Exact event details." }],
      actions: [{ id: "calendar", label: "Add calendar hold and reminder", behavior: "approve_action", instruction: "Create the exact calendar entries.", externalMutation: true }],
    });
    expect(matchExplicitVoiceApproval(calendar, "dont' reply, just add this to my calendar and set a reminder")).toEqual({
      actionLabel: "Add calendar hold and reminder",
      cardActionId: "calendar",
    });
  });

  test("never treats negation, deferral, questions, or preparation as approval", () => {
    expect(matchExplicitVoiceApproval(card(), "Don't send it; revise the ending.")).toBeUndefined();
    expect(matchExplicitVoiceApproval(card(), "Send this later, after approval.")).toBeUndefined();
    expect(matchExplicitVoiceApproval(card(), "Should I send this?")).toBeUndefined();
    expect(matchExplicitVoiceApproval(card(), "Draft a shorter reply for me.")).toBeUndefined();
  });

  test("refuses ambiguous cards with multiple approval actions", () => {
    const ambiguous = card({
      actions: [
        { id: "send", label: "Send reply", behavior: "approve_action", instruction: "Send it.", artifactBlockId: "draft" },
        { id: "forward", label: "Forward reply", behavior: "approve_action", instruction: "Forward it.", artifactBlockId: "draft" },
      ],
    });
    expect(hasVoiceApprovalCandidate(ambiguous)).toBe(true);
    expect(matchExplicitVoiceApproval(ambiguous, "Send it.")).toBeUndefined();
  });

  test("does not approve actions on cards outside review", () => {
    expect(matchExplicitVoiceApproval(card({ status: "queued" }), "Send it.")).toBeUndefined();
  });
});
