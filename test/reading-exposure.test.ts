import { describe, expect, test } from "bun:test";
import { emptyReadingExposure, sampleReadingExposure } from "../src/state/readingExposure";
import { engagementDwellDelta } from "../src/state/readingEngagement";

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
