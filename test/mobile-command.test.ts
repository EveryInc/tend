import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { projectMobileWorkspace } from "../server/mobile/projection";
import { AttentionStore } from "../server/store";
import type { MobileCommand } from "../shared/mobile";

const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "attention-mobile-command-"));
  roots.push(root);
  const store = new AttentionStore(root);
  await store.init();
  const domain = new AttentionDomain(store);
  await domain.bindFeed("inbox", "thread-inbox");
  await domain.upsertCard("inbox", {
    id: "reply",
    title: "Send the reply.",
    why: "The exact draft is ready.",
    sourceMailbox: "dan@every.to",
    blocks: [{ id: "draft", type: "editable_text", label: "Draft", value: "Original.", editable: true }],
    actions: [{
      id: "send",
      label: "Send reply",
      behavior: "approve_action",
      instruction: "Send the exact approved reply.",
      artifactBlockId: "draft",
      externalMutation: true,
      mailboxPolicy: "reply_from_source",
      variant: "primary",
    }],
  });
  return { store, domain };
}

function command(
  projection: Awaited<ReturnType<typeof projectMobileWorkspace>>["cards"][number],
  overrides: Partial<MobileCommand> = {},
): MobileCommand {
  return {
    id: "10000000-0000-0000-0000-000000000001",
    userId: "user-1",
    clientRequestId: "request-1",
    deviceId: "iphone-1",
    feedId: projection.feedId,
    cardId: projection.cardId,
    feedGeneration: projection.feedGeneration,
    expectedCardDigest: projection.cardDigest,
    kind: "instruction",
    instruction: "Research this and bring it back.",
    state: "claimed",
    createdAt: "2026-06-13T18:00:00.000Z",
    availableAt: "2026-06-13T18:00:00.000Z",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("mobile commands", () => {
  test("applies a command exactly once", async () => {
    const { store, domain } = await setup();
    const projection = (await projectMobileWorkspace(store)).cards.find((card) => card.cardId === "reply")!;
    const input = command(projection);

    const first = await domain.applyMobileCommand(input);
    const replay = await domain.applyMobileCommand(input);
    const work = (await store.readWorkItems("inbox")).filter((item) => item.sourceMobileCommandId === input.id);

    expect(replay).toEqual(first);
    expect(work).toHaveLength(1);
    expect(first.workId).toBe(work[0].id);
  });

  test("rejects a stale card snapshot before queuing work", async () => {
    const { store, domain } = await setup();
    const projection = (await projectMobileWorkspace(store)).cards.find((card) => card.cardId === "reply")!;
    await domain.updateBlock("inbox", "reply", "draft", "Changed locally.");

    await expect(domain.applyMobileCommand(command(projection))).rejects.toThrow("stale");
    expect((await store.readWorkItems("inbox")).filter((item) => item.sourceMobileCommandId === "10000000-0000-0000-0000-000000000001")).toHaveLength(0);
  });

  test("atomically edits and approves the exact visible artifact", async () => {
    const { store, domain } = await setup();
    const projection = (await projectMobileWorkspace(store)).cards.find((card) => card.cardId === "reply")!;
    const action = projection.actions.find((item) => item.id === "send")!;
    const input = command(projection, {
      kind: "approve_action",
      actionId: "send",
      expectedActionDigest: action.digest,
      instruction: undefined,
      edits: { draft: "Corrected on iPhone." },
    });

    const result = await domain.applyMobileCommand(input);
    const card = await store.readCard("inbox", "reply");
    const work = await store.readWork("inbox", result.workId!);

    expect(card.blocks.find((block) => block.id === "draft")?.value).toBe("Corrected on iPhone.");
    expect(work.kind).toBe("execute_approved_action");
    expect(work.sourceMobileCommandId).toBe(input.id);
    expect(work.approvalDigest).toBeTruthy();
  });

  test("never allows a command to cross feed boundaries", async () => {
    const { store, domain } = await setup();
    await domain.createFeedFromBrief("Every\nCompany and product attention.", null);
    await domain.upsertCard("every", {
      id: "reply",
      title: "Different feed card.",
      why: "Same id, different feed.",
      blocks: [{ id: "memo", type: "memo", text: "Different." }],
    });
    const projection = (await projectMobileWorkspace(store)).cards.find((card) => card.key === "inbox:reply")!;

    await expect(domain.applyMobileCommand(command(projection, { feedId: "every" }))).rejects.toThrow();
    expect((await store.readWorkItems("every")).filter((item) => item.sourceMobileCommandId === "10000000-0000-0000-0000-000000000001")).toHaveLength(0);
  });

  test("revalidates external recipients after applying an exact artifact edit", async () => {
    const { store, domain } = await setup();
    await domain.updateBlock("inbox", "reply", "draft", "Send this to original@example.com.");
    const projection = (await projectMobileWorkspace(store)).cards.find((card) => card.cardId === "reply")!;
    const action = projection.actions.find((item) => item.id === "send")!;

    await expect(domain.applyMobileCommand(command(projection, {
      kind: "approve_action",
      actionId: "send",
      expectedActionDigest: action.digest,
      instruction: undefined,
      edits: { draft: "Send this to changed@example.com." },
      riskConfirmation: {
        kind: "external_recipient",
        recipients: ["original@example.com"],
      },
    }))).rejects.toThrow("recipients changed");
    expect((await store.readCard("inbox", "reply")).blocks[0].value).toContain("original@example.com");
  });

  test("rejects malformed command ids before resolving receipt storage", async () => {
    const { store, domain } = await setup();
    const projection = (await projectMobileWorkspace(store)).cards.find((card) => card.cardId === "reply")!;

    await expect(domain.applyMobileCommand(command(projection, {
      id: "../../outside",
    }))).rejects.toThrow("command id");
  });

  test("applies a local dismiss command with no work item and marks the card dismissed", async () => {
    const { store, domain } = await setup();
    const projection = (await projectMobileWorkspace(store)).cards.find((card) => card.cardId === "reply")!;
    const dismissAction = projection.actions.find((action) => action.id === "dismiss-card")!;
    expect(dismissAction.behavior).toBe("dismiss_card");

    const input = command(projection, {
      id: "10000000-0000-0000-0000-000000000009",
      clientRequestId: "request-dismiss",
      kind: "dismiss",
      actionId: "dismiss-card",
      expectedActionDigest: dismissAction.digest,
    });

    const result = await domain.applyMobileCommand(input);

    expect(result.receipt.state).toBe("applied");
    expect(result.workId).toBeUndefined();

    const card = await store.readCard("inbox", "reply");
    expect(card.status).toBe("done");
    expect(card.completionDisposition).toBe("dismissed");
    expect((await store.readWorkItems("inbox")).filter((item) => item.cardId === "reply")).toHaveLength(0);

    // Idempotent replay returns the same receipt and still creates no work.
    const replay = await domain.applyMobileCommand(input);
    expect(replay).toEqual(result);
    expect((await store.readWorkItems("inbox")).filter((item) => item.cardId === "reply")).toHaveLength(0);
  });

  test("rejects a dismiss command whose action digest is stale", async () => {
    const { store, domain } = await setup();
    const projection = (await projectMobileWorkspace(store)).cards.find((card) => card.cardId === "reply")!;

    await expect(domain.applyMobileCommand(command(projection, {
      id: "10000000-0000-0000-0000-00000000000a",
      clientRequestId: "request-dismiss-stale",
      kind: "dismiss",
      actionId: "dismiss-card",
      expectedActionDigest: "stale-digest",
    }))).rejects.toThrow("stale");
  });

  test("rejects stale mobile commands for legacy cards with reserved action ids", async () => {
    const { store, domain } = await setup();
    const legacy = await store.readCard("inbox", "reply");
    legacy.proposedAction = {
      label: "Send the proposed reply",
      instruction: "Send the separate proposed reply.",
      externalMutation: true,
    };
    legacy.actions = [{
      id: "proposed-action",
      label: "Prepare a harmless note",
      behavior: "approve_action",
      instruction: "Prepare a harmless note only.",
    }];
    await store.writeCard(legacy);

    const projection = (await projectMobileWorkspace(store)).cards.find((card) => card.cardId === "reply")!;
    const projected = projection.actions.find((action) => action.id === "proposed-action")!;
    expect(projected.label).toBe("Send the proposed reply");

    await expect(domain.applyMobileCommand(command(projection, {
      id: "10000000-0000-0000-0000-00000000000b",
      clientRequestId: "request-legacy-reserved",
      kind: "approve_action",
      actionId: "proposed-action",
      expectedActionDigest: projected.digest,
      instruction: undefined,
    }))).rejects.toThrow("reserved by Tend");
    expect((await store.readWorkItems("inbox")).filter((work) => work.cardId === "reply")).toHaveLength(0);
  });
});
