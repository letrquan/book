export interface TranscriptMetrics {
  contentRows: number;
  viewportRows: number;
}

export interface TranscriptScrollState {
  scrollTop: number;
  followBottom: boolean;
}

export function createTranscriptScrollState(): TranscriptScrollState {
  return { scrollTop: 0, followBottom: true };
}

export function getMaxScrollTop(metrics: TranscriptMetrics): number {
  const contentRows = Math.max(0, Math.floor(metrics.contentRows));
  const viewportRows = Math.max(1, Math.floor(metrics.viewportRows));
  return Math.max(0, contentRows - viewportRows);
}

export function reconcileTranscriptScroll(
  state: TranscriptScrollState,
  metrics: TranscriptMetrics,
): TranscriptScrollState {
  const maxScrollTop = getMaxScrollTop(metrics);
  const scrollTop = state.followBottom
    ? maxScrollTop
    : Math.max(0, Math.min(Math.floor(state.scrollTop), maxScrollTop));

  return scrollTop === state.scrollTop ? state : { ...state, scrollTop };
}

export function scrollTranscriptBy(
  state: TranscriptScrollState,
  metrics: TranscriptMetrics,
  rows: number,
): TranscriptScrollState {
  const maxScrollTop = getMaxScrollTop(metrics);
  const scrollTop = Math.max(0, Math.min(state.scrollTop + Math.trunc(rows), maxScrollTop));
  const followBottom = rows > 0 && scrollTop === maxScrollTop;

  if (scrollTop === state.scrollTop && followBottom === state.followBottom) return state;
  return { scrollTop, followBottom };
}

export function scrollTranscriptToStart(): TranscriptScrollState {
  return { scrollTop: 0, followBottom: false };
}

export function scrollTranscriptToEnd(metrics: TranscriptMetrics): TranscriptScrollState {
  return { scrollTop: getMaxScrollTop(metrics), followBottom: true };
}

export function getTranscriptPageRows(viewportRows: number): number {
  return Math.max(1, Math.floor(viewportRows) - 2);
}

export function getTranscriptHalfPageRows(viewportRows: number): number {
  return Math.max(1, Math.floor(viewportRows / 2));
}

/** Rows one wheel notch moves on its own: a notch after a pause, or the first of a run. */
export const WHEEL_NOTCH_ROWS = 3;
/** A notch this long after the one before starts a new run at `WHEEL_NOTCH_ROWS`. */
const WHEEL_RUN_GAP_MS = 100;
/** What a long, fast run of notches approaches per notch. */
const WHEEL_RUN_ROWS = 27;
/** How much of the remaining climb to `WHEEL_RUN_ROWS` each further notch leaves. */
const WHEEL_RUN_RAMP = 0.8;
/**
 * The fastest the wheel may move the transcript. Reports closer together than a notch can be
 * turned — a trackpad, a free-spinning wheel — each move only their share of it.
 */
const WHEEL_MAX_ROWS_PER_SECOND = 900;
/** Share of the distance still to go that each animation frame covers. */
const WHEEL_EASE = 0.75;

/** What the wheel remembers between reports: which way the run goes and how long it is. */
export interface WheelMotion {
  direction: -1 | 0 | 1;
  lastAt: number;
  run: number;
}

export function createWheelMotion(): WheelMotion {
  return { direction: 0, lastAt: Number.NEGATIVE_INFINITY, run: 0 };
}

/**
 * Rows one wheel report moves the transcript, and the motion it leaves behind.
 *
 * Fitted to what Claude Code does with the same reports: a notch on its own moves three rows, and
 * notches turned in a run move further each time, so a quick spin covers a long transcript instead
 * of crawling through it three rows at a time. Measured there: a second notch within 100 ms moves
 * seven to nine rows, and a run at 60 ms climbs 3, 7, 12, 14, 16, 17, 20. Reports that arrive faster
 * than a notch can be turned share `WHEEL_MAX_ROWS_PER_SECOND` between them instead. The result can
 * be fractional; the caller keeps the remainder for the next report.
 */
export function wheelRows(
  motion: WheelMotion,
  direction: -1 | 1,
  now: number,
): { rows: number; motion: WheelMotion } {
  const gap = now - motion.lastAt;
  if (direction !== motion.direction || !(gap < WHEEL_RUN_GAP_MS)) {
    return { rows: direction * WHEEL_NOTCH_ROWS, motion: { direction, lastAt: now, run: 0 } };
  }
  const run = motion.run + 1;
  const climb = (WHEEL_RUN_ROWS - WHEEL_NOTCH_ROWS) * (1 - WHEEL_RUN_RAMP ** run);
  const ceiling = (WHEEL_MAX_ROWS_PER_SECOND * Math.max(0, gap)) / 1000;
  const rows = Math.max(1, Math.min(WHEEL_NOTCH_ROWS + climb, ceiling));
  return { rows: direction * rows, motion: { direction, lastAt: now, run } };
}

/**
 * Rows the wheel animation moves this frame: three quarters of what is left, rounded up, so a lone
 * notch lands in one frame and a long run glides in over two or three, the way Claude Code draws
 * it. Always whole rows and never past the target; zero once less than a row is left.
 */
export function wheelEaseStep(remainingRows: number): number {
  const distance = Math.abs(remainingRows);
  if (distance < 1) return 0;
  return (
    Math.sign(remainingRows) * Math.min(Math.floor(distance), Math.ceil(distance * WHEEL_EASE))
  );
}

/**
 * Which way a readline chord scrolls the transcript, or `null` for a key that is
 * not one. Ctrl+U scrolls back half a page, Ctrl+D forward — the pager pair of
 * every terminal.
 *
 * The composer owns these keys while it accepts input and reports them here only
 * when it had no draft to edit, so the caller is the one place that knows which
 * of the two it is looking at.
 */
export function halfPageScrollDirection(
  input: string,
  key: { ctrl?: boolean },
): 'up' | 'down' | null {
  if (!key.ctrl) return null;
  const chord = input.toLowerCase();
  if (chord === 'u') return 'up';
  if (chord === 'd') return 'down';
  return null;
}

/**
 * Whether the transcript's own Ctrl+U / Ctrl+D branch may scroll, or has to
 * leave the keys to whoever has them.
 *
 * The transcript may act only when *nothing* on screen is taking these keys.
 * An editor that has one spends the chord itself: the composer's Ctrl+U kills
 * the text before the cursor, and a sheet editor's kills its own field. When an
 * editor is live and has nothing to edit it reports the chord as a scroll
 * request instead, because by the time the transcript's handler runs the editor
 * has already spent the key and a draft that Ctrl+U itself emptied looks
 * exactly like one that was empty all along.
 *
 * So: true only when the composer is *not* accepting input and no sheet editor
 * holds the focus. Reading this as "the composer is free" instead of "no editor
 * is taking the keys" is the inversion that let a draft-clearing Ctrl+U scroll
 * the transcript as well, which is why the whole rule is this one function and
 * the four cases it has are tabulated in `transcript-scroll.test.ts`.
 */
export function pagerChordsAvailable(editors: {
  /** Whether the composer is accepting keys at all. */
  composerAcceptsInput: boolean;
  /** Whether a sheet's own text editor currently holds the focus. */
  sheetEditorFocused: boolean;
}): boolean {
  return !editors.composerAcceptsInput && !editors.sheetEditorFocused;
}
