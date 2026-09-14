/** Conservative, client-side visibility heuristic. A read receipt is never a taste vote. */
export const READING_INPUT_WINDOW_MS = 1_500;

export interface ReadingExposureSample {
  foreground: boolean;
  /** A local interaction pauses qualification without discarding prior visible exposure. */
  paused?: boolean;
  meaningful: boolean;
  passed: boolean;
  forwardScroll: boolean;
}

export interface ReadingExposure {
  qualified: boolean;
}

export function emptyReadingExposure(): ReadingExposure {
  return { qualified: false };
}

/** Require visible coverage plus a deliberate forward pass; dwell is tracked separately. */
export function sampleReadingExposure(state: ReadingExposure, sample: ReadingExposureSample): { state: ReadingExposure; markRead: boolean } {
  if (!sample.foreground) return { state: emptyReadingExposure(), markRead: false };
  if (sample.paused) return { state, markRead: false };
  const next = { qualified: state.qualified || sample.meaningful };
  return { state: next, markRead: next.qualified && sample.passed && sample.forwardScroll };
}
