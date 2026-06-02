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
});
