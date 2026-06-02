import { describe, expect, test } from "bun:test";
import { FeedService } from "../src/hosted/services/feed-service";
import { defaultFeedState, feedView } from "../src/hosted/services/feed-state-service";

describe("hosted feed card normalization", () => {
  test("serves old cards with missing blocks as an empty block list", () => {
    const state = defaultFeedState("inbox");
    state.cards["done-without-blocks"] = {
      id: "done-without-blocks",
      feedId: "inbox",
      kind: "attention",
      status: "done",
      eyebrow: "Inbox",
      title: "Old completed card",
      why: "Stored before the hosted block schema was strict.",
      blocks: undefined as any,
      readyForPass: 1,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      completedAt: state.updatedAt,
      history: [],
    };

    const card = feedView(state).cards.find((item) => item.id === "done-without-blocks");
    expect(card?.blocks).toEqual([]);
  });

  test("normalizes malformed MCP card blocks before storing", () => {
    const state = defaultFeedState("inbox");
    const service = new FeedService(state);

    service.upsertCard({
      id: "mcp-card",
      title: "MCP card",
      why: "MCP omitted a block id.",
      blocks: [{ type: "memo", text: "Useful context." } as any],
    });

    expect(state.cards["mcp-card"].blocks).toEqual([
      { id: "block-1", type: "memo", text: "Useful context." },
    ]);
  });

  test("renders agent-shaped result cards with summary and evidence blocks", () => {
    const state = defaultFeedState("inbox");
    const service = new FeedService(state);

    service.upsertCard({
      id: "gmail-search:dictly",
      title: "Dictly mail search results",
      status: "done",
      done: true,
      summary: "Found 40 recent Dictly messages across support, admin, and outreach.",
      suggestedAction: "Review support threads first.",
      evidence: ["Two Gmail search pages were read.", "No Gmail mutations were performed."],
      provenance: { query: "Dictly -in:spam -in:trash", resultCount: 40 },
    } as any);

    expect((state.cards["gmail-search:dictly"] as any).summary).toBe("Found 40 recent Dictly messages across support, admin, and outreach.");
    expect((state.cards["gmail-search:dictly"] as any).evidence).toHaveLength(2);
    const card = feedView(state).cards.find((item) => item.id === "gmail-search:dictly");
    expect(card?.status).toBe("done");
    expect(card?.why).toBe("Found 40 recent Dictly messages across support, admin, and outreach.");
    expect(card?.blocks.map((block) => block.label)).toEqual(["Summary", "Suggested action", "Evidence", "Provenance"]);
  });

  test("persists Dan's sweep, action, and routine action fields in hosted state", () => {
    const state = defaultFeedState("inbox");
    const service = new FeedService(state);

    service.upsertCard({
      id: "reply-card",
      title: "Reply to customer",
      why: "A real reply needs the mailbox-bound approval flow.",
      sourceMailbox: "owner@example.com",
      blocks: [{ id: "draft", type: "editable_text", value: "Thanks!", editable: true }],
      actions: [{ id: "send-reply", label: "Send reply", behavior: "approve_action", instruction: "Send the approved draft.", artifactBlockId: "draft", externalMutation: true, mailboxPolicy: "reply_from_source" }],
    });
    service.upsertRoutineActionGroup({
      id: "routine-cleanup",
      label: "Archive routine mail",
      summary: "A batch of low-risk cleanup.",
      proposedAction: { label: "Archive", instruction: "Archive all listed threads." },
      items: [{ id: "item-1", cardId: "reply-card", title: "Archive thread", reason: "Routine cleanup." }],
    });
    state.sweep = { currentBatchId: "batch-1", lastFeedbackId: "feedback-1", recollectionOffered: true, statusMessage: "Cards reranked" };

    const view = feedView(state);
    expect(view.cards.find((card) => card.id === "reply-card")?.actions?.[0].mailboxPolicy).toBe("reply_from_source");
    expect(view.routineActions).toHaveLength(1);
    expect(view.sweep.recollectionOffered).toBe(true);
  });
});
