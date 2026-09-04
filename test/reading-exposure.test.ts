import { describe, expect, test } from "bun:test";
import { emptyReadingExposure, sampleReadingExposure, type ReadingExposureSample } from "../src/state/readingExposure";

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
