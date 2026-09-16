import { describe, expect, test } from "bun:test";
import { emptyReadingExposure, sampleReadingExposure } from "../src/state/readingExposure";
import { engagementDwellDelta } from "../src/state/readingEngagement";
import { createReadingAssignment, orderAssignedGroup, usableReadingAssignment } from "../src/state/readingAssignment";
import type { Card } from "../shared/types";

const visible = { foreground: true, meaningful: true, passed: false, forwardScroll: false };

describe("conservative reading exposure", () => {
  test("one meaningful view does not mark read; a subsequent deliberate pass does", () => {
    const state = sampleReadingExposure(emptyReadingExposure(), visible).state;
    expect(state.qualified).toBe(true);
    expect(sampleReadingExposure(state, visible).markRead).toBe(false);
    expect(sampleReadingExposure(state, { ...visible, meaningful: false, passed: true, forwardScroll: true }).markRead).toBe(true);
  });

  test("load, reverse scrolling, programmatic movement and unseen cards do not count", () => {
    const seen = sampleReadingExposure(emptyReadingExposure(), visible).state;
    expect(sampleReadingExposure(seen, { ...visible, passed: true, forwardScroll: false }).markRead).toBe(false);
    expect(sampleReadingExposure(emptyReadingExposure(), { ...visible, meaningful: false, passed: true, forwardScroll: true }).markRead).toBe(false);
  });

  test("backgrounding resets eligibility", () => {
    const seen = sampleReadingExposure(emptyReadingExposure(), visible).state;
    const blurred = sampleReadingExposure(seen, { ...visible, foreground: false }).state;
    expect(blurred).toEqual(emptyReadingExposure());
    expect(sampleReadingExposure(blurred, { ...visible, meaningful: false, passed: true, forwardScroll: true }).markRead).toBe(false);
  });

  test("an active selection pauses without erasing exposure, then a later forward pass completes", () => {
    const qualified = sampleReadingExposure(emptyReadingExposure(), visible).state;
    const paused = sampleReadingExposure(qualified, {
      ...visible, paused: true, passed: true, forwardScroll: true,
    });
    expect(paused.markRead).toBe(false);
    expect(paused.state).toEqual(qualified);
    expect(sampleReadingExposure(paused.state, {
      ...visible, meaningful: false, passed: true, forwardScroll: true,
    }).markRead).toBe(true);
  });

  test("an observed card survives a paused focus interval until the next trusted pass", () => {
    const seen = sampleReadingExposure(emptyReadingExposure(), visible).state;
    const paused = sampleReadingExposure(seen, { ...visible, meaningful: false, paused: true }).state;
    expect(paused).toEqual(seen);
    expect(sampleReadingExposure(paused, {
      ...visible, meaningful: false, passed: true, forwardScroll: true,
    }).markRead).toBe(true);
  });

  test("selection pauses qualification while a true foreground loss resets it", () => {
    let state = sampleReadingExposure(emptyReadingExposure(), { ...visible, meaningful: false }).state;
    state = sampleReadingExposure(state, { ...visible, paused: true }).state;
    expect(state.qualified).toBe(false);
    state = sampleReadingExposure(state, visible).state;
    expect(state.qualified).toBe(true);
    expect(sampleReadingExposure(state, { ...visible, foreground: false }).state).toEqual(emptyReadingExposure());
  });

  test("a meaningful slice of a tall face qualifies, but a headline alone cannot", () => {
    expect(sampleReadingExposure(emptyReadingExposure(), visible).state.qualified).toBe(true);
    expect(sampleReadingExposure(emptyReadingExposure(), { ...visible, meaningful: false }).state.qualified).toBe(false);
  });
});

test("engagement dwell counts foreground exposure but not first samples, hidden, idle or stalled intervals", () => {
  const visible = { at: 1_000, visible: true, lastActivity: 1_000 };
  expect(engagementDwellDelta(undefined, visible)).toBe(0);
  expect(engagementDwellDelta(visible, { ...visible, at: 1_250 })).toBe(250);
  expect(engagementDwellDelta({ ...visible, visible: false }, { ...visible, at: 1_250 })).toBe(0);
  expect(engagementDwellDelta(visible, { ...visible, at: 1_250, visible: false })).toBe(0);
  expect(engagementDwellDelta(visible, { ...visible, at: 2_001 })).toBe(0);
  expect(engagementDwellDelta({ ...visible, at: 61_000 }, { ...visible, at: 61_250 })).toBe(0);
  expect(engagementDwellDelta({ ...visible, at: 61_000 }, { ...visible, at: 61_250, lastActivity: 61_100 })).toBe(250);
});

test("either reader can lead an unseen pair, and a seen assignment survives polling, reload and a late alternate", () => {
  const card = (id: string): Card => ({ id, feedId: "fixture", kind: "attention", status: "to_review_new", title: id,
    eyebrow: "Fixture", why: "Fixture observation", blocks: [], readyForPass: 1, history: [],
    createdAt: "2026-09-16T12:00:00Z", updatedAt: "2026-09-16T12:00:00Z",
    readingPresentation: { mode: "passive", contentRevision: id === "first" ? "a".repeat(64) : "b".repeat(64) } });
  const first = card("first");
  const second = card("second");
  const singleton = { id: "fixture-group", cards: [first] };
  const pair = { id: singleton.id, cards: [first, second] };
  const left = createReadingAssignment(pair, { random: () => 0, id: "left" });
  const right = createReadingAssignment(pair, { random: () => 0.99, id: "right" });
  expect(left.firstCardId).toBe(first.id);
  expect(right.firstCardId).toBe(second.id);
  expect(left.reason).toBe("randomized_pair");
  expect(orderAssignedGroup(pair, right).cards.map((item) => item.id)).toEqual([second.id, first.id]);
  const reloaded = JSON.parse(JSON.stringify(right));
  expect(usableReadingAssignment({ ...pair, cards: [second, first] }, reloaded)).toBe(true);
  expect(orderAssignedGroup({ ...pair, cards: [second, first] }, reloaded).cards[0].id).toBe(second.id);
  // Mounting an unseen singleton creates no saved assignment. A pair can still draw either reader.
  expect(createReadingAssignment(pair, { random: () => 0.99 }).firstCardId).toBe(second.id);
  const seenSingle = createReadingAssignment(singleton);
  expect(usableReadingAssignment(pair, seenSingle)).toBe(true);
  expect(orderAssignedGroup(pair, seenSingle).cards[0].id).toBe(first.id);
  expect(seenSingle.reason).toBe("single_available");
  expect(seenSingle.members).toHaveLength(1);
  expect(createReadingAssignment(pair, { selectedId: first.id, random: () => 0.99 }).reason).toBe("restored_selection");
  expect(createReadingAssignment(pair, { preferredId: second.id }).firstCardId).toBe(second.id);
  expect(createReadingAssignment(pair, { previouslyReviewed: true }).reason).toBe("previously_reviewed");
  expect(usableReadingAssignment({ ...pair, cards: [{ ...first, readingPresentation: { mode: "passive", contentRevision: "c".repeat(64) } }, second] }, left)).toBe(false);
  expect(usableReadingAssignment(pair, null as never)).toBe(false);
  expect(usableReadingAssignment(pair, { ...left, members: [null] } as never)).toBe(false);
  expect(usableReadingAssignment(pair, { ...left, reason: "made-up" } as never)).toBe(false);
});
