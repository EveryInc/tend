import { describe, expect, test } from "bun:test";
import { emptyReadingExposure, sampleReadingExposure, type ReadingExposureSample } from "../src/state/readingExposure";
import { engagementDwellDelta } from "../src/state/readingEngagement";

const visible = { foreground: true, meaningful: true, sawStart: true, sawEnd: true, passed: false, forwardScroll: false };
function dwell(overrides: Partial<ReadingExposureSample> = {}) {
  let state = emptyReadingExposure();
  for (let now = 0; now <= 2_250; now += 250) state = sampleReadingExposure(state, { now, ...visible, ...overrides }).state;
  return state;
}

describe("conservative reading exposure", () => {
  test("lingering alone does not mark read; a subsequent deliberate pass does", () => {
    const state = dwell();
    expect(state.qualified).toBe(true);
    expect(sampleReadingExposure(state, { now: 2_500, ...visible }).markRead).toBe(false);
    expect(sampleReadingExposure(state, { now: 2_500, ...visible, meaningful: false, passed: true, forwardScroll: true }).markRead).toBe(true);
  });

  test("load, fast flick, reverse scrolling and programmatic movement do not count", () => {
    const start = sampleReadingExposure(emptyReadingExposure(), { now: 0, ...visible }).state;
    expect(sampleReadingExposure(start, { now: 250, ...visible, meaningful: false, passed: true, forwardScroll: true }).markRead).toBe(false);
    expect(sampleReadingExposure(dwell(), { now: 2_500, ...visible, passed: true, forwardScroll: false }).markRead).toBe(false);
    expect(sampleReadingExposure(emptyReadingExposure(), { now: 2_500, ...visible, meaningful: false, passed: true, forwardScroll: true }).markRead).toBe(false);
  });

  test("backgrounding resets eligibility; a stalled timer cannot fabricate dwell", () => {
    const blurred = sampleReadingExposure(dwell(), { now: 2_500, ...visible, foreground: false }).state;
    expect(sampleReadingExposure(blurred, { now: 2_750, ...visible, passed: true, forwardScroll: true }).markRead).toBe(false);
    let state = sampleReadingExposure(emptyReadingExposure(), { now: 0, ...visible }).state;
    state = sampleReadingExposure(state, { now: 60_000, ...visible }).state;
    expect(state.qualified).toBe(false);
    expect(state.visibleMs).toBe(0);
  });

  test("a tall face can qualify in parts, but a headline alone cannot", () => {
    let state = dwell({ sawEnd: false });
    expect(state.qualified).toBe(false);
    state = sampleReadingExposure(state, { now: 2_500, ...visible, sawStart: false }).state;
    expect(state.qualified).toBe(true);
    expect(dwell({ sawStart: false }).qualified).toBe(false);
    expect(dwell({ meaningful: false }).qualified).toBe(false);
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
