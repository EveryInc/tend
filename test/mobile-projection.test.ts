import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { projectMobileWorkspace } from "../server/mobile/projection";
import { createLocalRuntime } from "../server/runtime";
import { AttentionStore } from "../server/store";
import type { MindContextPublicationInput } from "../shared/types";

const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "attention-mobile-projection-"));
  roots.push(root);
  const store = new AttentionStore(root);
  await store.init();
  return { store, domain: new AttentionDomain(store) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("mobile workspace projection", () => {
  test("discovers every feed and keeps identical card ids isolated by feed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "attention-mobile-sqlite-"));
    roots.push(root);
    const runtime = await createLocalRuntime(path.join(root, "data"), path.join(root, "attention.db"));
    try {
      const domain = new AttentionDomain(runtime.store);
      await domain.createFeedFromBrief("Every\nSurface the most useful Every signals.", null);
      await domain.upsertCard("inbox", {
        id: "shared-id",
        title: "Inbox version",
        why: "Needs an email decision.",
        blocks: [{ id: "memo", type: "memo", text: "Inbox content." }],
      });
      await domain.upsertCard("every", {
        id: "shared-id",
        title: "Every version",
        why: "Needs a company decision.",
        blocks: [{ id: "memo", type: "memo", text: "Every content." }],
      });

      const snapshot = await projectMobileWorkspace(runtime.store);

      expect(snapshot.feeds.map((feed) => feed.id)).toEqual(["inbox", "company-attention", "every"]);
      expect(snapshot.cards.find((card) => card.key === "inbox:shared-id")?.title).toBe("Inbox version");
      expect(snapshot.cards.find((card) => card.key === "every:shared-id")?.title).toBe("Every version");
    } finally {
      runtime.sqlite.close();
    }
  });

  test("reflects feed creation, renaming, reordering, and removal without mobile changes", async () => {
    const { store, domain } = await setup();
    await domain.createFeedFromBrief("Research Watch\nTrack useful research.", null);

    const created = await projectMobileWorkspace(store);
    expect(created.feeds.map((feed) => feed.id)).toEqual(["inbox", "company-attention", "research-watch"]);

    const config = await store.readConfig("research-watch");
    await store.writeConfig({ ...config, name: "Ideas Watch" });
    await store.setFeedOrder(["research-watch", "inbox", "company-attention"]);

    const changed = await projectMobileWorkspace(store);
    expect(changed.feeds.map((feed) => `${feed.id}:${feed.name}`)).toEqual([
      "research-watch:Ideas Watch",
      "inbox:Inbox",
      "company-attention:Company Attention",
    ]);

    await domain.archiveFeed("research-watch");
    expect((await projectMobileWorkspace(store)).feeds.map((feed) => feed.id)).toEqual([
      "inbox",
      "company-attention",
    ]);
  });

  test("projects review ordering, routine groups, safe actions, and no work capabilities", async () => {
    const { store, domain } = await setup();
    await domain.bindFeed("inbox", "thread-inbox");
    await domain.upsertCard("inbox", {
      id: "mobile-card",
      title: "Review the agreement.",
      why: "The current draft needs an exact decision.",
      sourceMailbox: "dan@every.to",
      blocks: [
        {
          id: "evidence",
          type: "evidence",
          label: "Sources",
          items: [
            { label: "External", href: "https://example.com/agreement" },
            { label: "Local PDF", href: "/api/artifacts/private.pdf" },
            { label: "Signed URL", href: "https://example.com/agreement?access_token=private" },
          ],
        },
        { id: "draft", type: "editable_text", label: "Draft", value: "Reply to syd@example.com.", editable: true },
        {
          id: "chart",
          type: "chart",
          chart: {
            unit: "% from /Users/dan/private",
            max: 100,
            series: [{ label: "Current /Users/dan" }, { label: "Proposed" }],
            rows: [{ label: "D1", values: [48, 62], detail: "Source: /Users/dan/retention.csv" }],
            note: "Private workbook: file:///Users/dan/retention.csv",
          },
        },
      ],
      actions: [
        {
          id: "send",
          label: "Send reply",
          behavior: "approve_action",
          instruction: "Send this exact reply to syd@example.com.",
          artifactBlockId: "draft",
          externalMutation: true,
          mailboxPolicy: "reply_from_source",
          variant: "primary",
        },
      ],
    });
    await domain.queueInstruction("inbox", "inbox-ready-to-collect", "Collect a fresh Inbox sweep.");
    await domain.upsertRoutineActionGroup("inbox", {
      id: "cleanup",
      label: "Likely archive",
      summary: "Two notices need no reply.",
      proposedAction: { label: "Archive all", instruction: "Archive the listed notices.", externalMutation: true },
      items: [{ id: "notice-1", title: "Routine notice", reason: "No action required." }],
    });

    const snapshot = await projectMobileWorkspace(store);
    const card = snapshot.cards.find((item) => item.cardId === "mobile-card");
    const routine = snapshot.cards.find((item) => item.routineActionGroupId === "cleanup");
    const serialized = JSON.stringify(snapshot);

    expect(card?.reviewable).toBe(true);
    expect(card?.actions.map((action) => action.label)).toEqual(["Dismiss card", "Send reply"]);
    expect(card?.actions.find((action) => action.id === "dismiss-card")?.behavior).toBe("dismiss_card");
    expect(card?.actions.find((action) => action.id === "send")?.confirmation?.recipients).toEqual(["syd@example.com"]);
    const evidenceItems = card?.blocks[0].items ?? [];
    expect((evidenceItems[0] as any).href).toBe("https://example.com/agreement");
    expect((evidenceItems[1] as any)).toMatchObject({ label: "Local PDF", linkAvailability: "mac_only" });
    expect((evidenceItems[2] as any)).toMatchObject({ label: "Signed URL", linkAvailability: "mac_only" });
    expect(serialized).not.toContain("access_token");
    expect(routine).toMatchObject({ itemKind: "routine_action_group", reviewable: true, title: "Likely archive" });
    expect(serialized).not.toContain("capabilityToken");
    expect(serialized).not.toContain("thread-inbox");
    expect(serialized).not.toContain("/Users/dan");
    expect(serialized).not.toContain("file:///Users");
    expect(card?.feedGeneration).not.toBe(`pass:${snapshot.feeds[0].currentPass}`);

    const beforePass = card?.feedGeneration;
    await domain.beginNextPass("inbox");
    const afterPass = (await projectMobileWorkspace(store)).cards.find((item) => item.cardId === "mobile-card");
    expect(afterPass?.feedGeneration).not.toBe(beforePass);
  });

  test("includes filtered On Your Mind sources without publisher ownership", async () => {
    const { store, domain } = await setup();
    await domain.bindMindContextPublisher("thread-chronicle");
    const publication: MindContextPublicationInput = {
      id: "mind-mobile",
      sourceThreadId: "thread-chronicle",
      state: "fresh",
      publishedAt: "2026-06-13T18:00:00.000Z",
      observedFrom: "2026-06-13T17:45:00.000Z",
      observedTo: "2026-06-13T17:55:00.000Z",
      summary: "Paywall work is active for dan@example.com.",
      signals: [{
        id: "paywall",
        kind: "changed_now",
        title: "Paywall diagnosis",
        summary: "The mobile experience is the current focus.",
        observationIds: ["window"],
      }],
      observations: [{
        id: "window",
        kind: "chronicle_ocr",
        title: "Paywall session",
        observedFrom: "2026-06-13T17:45:00.000Z",
        observedTo: "2026-06-13T17:55:00.000Z",
        excerpt: "Reviewing the mobile CTA.",
        fullText: "Reviewing the mobile CTA with secret=private-value.",
        href: "https://example.com/session?access_token=private-link",
      }],
    };
    await domain.publishMindContext("thread-chronicle", publication);

    const snapshot = await projectMobileWorkspace(store, new Date("2026-06-13T18:05:00.000Z"));
    const serialized = JSON.stringify(snapshot.mind);

    expect(snapshot.mind.current?.observations[0].fullText).toContain("[REDACTED SECRET]");
    expect(snapshot.mind.current?.observations[0].href).toBeUndefined();
    expect(serialized).not.toContain("private-value");
    expect(serialized).not.toContain("private-link");
    expect(serialized).not.toContain("thread-chronicle");
  });
});
