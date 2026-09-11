import { describe, expect, test } from "bun:test";
import { cardDispositionUndoPath, sameCardReference, sameUndoRegistration } from "../src/state/cardDispositionUndo";

describe("browser card disposition undo", () => {
  test("keeps local dismissal and source-cleanup undo routes distinct", () => {
    const card = { feedId: "inbox", cardId: "shared-card" };

    expect(cardDispositionUndoPath("dismiss", card)).toBe("/api/feeds/inbox/cards/shared-card/return-to-review");
    expect(cardDispositionUndoPath("cleanup", card)).toBe("/api/feeds/inbox/cards/shared-card/undo-cleanup-source");
  });

  test("an older timer cannot clear the same card id in another feed", () => {
    const current = { feedId: "company-attention", cardId: "shared-card" };

    expect(sameCardReference(current, { feedId: "inbox", cardId: "shared-card" })).toBe(false);
    expect(sameCardReference(current, { feedId: "company-attention", cardId: "shared-card" })).toBe(true);
  });

  test("an older timer cannot clear a newer operation on the same card", () => {
    const newer = { kind: "dismiss" as const, feedId: "inbox", cardId: "shared-card", operationId: "dismiss-2" };

    expect(sameUndoRegistration(newer, { ...newer, operationId: "dismiss-1" })).toBe(false);
    expect(sameUndoRegistration(newer, newer)).toBe(true);
  });

  test("cleanup and dismissal registrations cannot match each other", () => {
    const dismissal = { kind: "dismiss" as const, feedId: "inbox", cardId: "shared-card", operationId: "operation-1" };

    expect(sameUndoRegistration({ ...dismissal, kind: "cleanup" }, dismissal)).toBe(false);
  });
});
