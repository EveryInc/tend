/** Conservative, client-side attention heuristic. A read receipt is never a taste vote. */
export const READING_DWELL_MS = 2_000;
export const READING_INPUT_WINDOW_MS = 1_500;

export interface ReadingExposureSample {
  now: number;
  foreground: boolean;
  meaningful: boolean;
  sawStart: boolean;
  sawEnd: boolean;
  passed: boolean;
  forwardScroll: boolean;
}

export interface ReadingExposure {
  visibleMs: number;
  lastAt?: number;
  wasMeaningful: boolean;
  sawStart: boolean;
  sawEnd: boolean;
  qualified: boolean;
}

export function emptyReadingExposure(): ReadingExposure {
  return { visibleMs: 0, wasMeaningful: false, sawStart: false, sawEnd: false, qualified: false };
}

/** Cap gaps so sleeping tabs and stalled timers cannot become reading time. */
export function sampleReadingExposure(state: ReadingExposure, sample: ReadingExposureSample): { state: ReadingExposure; markRead: boolean } {
  if (!sample.foreground) return { state: emptyReadingExposure(), markRead: false };
  const elapsed = state.lastAt === undefined ? 0 : sample.now - state.lastAt;
  const continuous = elapsed >= 0 && elapsed <= 600;
  const visibleMs = sample.meaningful
    ? (continuous && state.wasMeaningful ? state.visibleMs + elapsed : 0)
    : 0;
  const next = {
    visibleMs,
    lastAt: sample.now,
    wasMeaningful: sample.meaningful,
    sawStart: state.sawStart || (sample.meaningful && sample.sawStart),
    sawEnd: state.sawEnd || (sample.meaningful && sample.sawEnd),
    qualified: state.qualified,
  };
  next.qualified ||= visibleMs >= READING_DWELL_MS && next.sawStart && next.sawEnd;
  return { state: next, markRead: next.qualified && sample.passed && sample.forwardScroll };
}
