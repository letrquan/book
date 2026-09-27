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

export function getTranscriptWheelDrainRows(pendingRows: number, viewportRows: number): number {
  const pending = Math.trunc(pendingRows);
  if (pending === 0) return 0;

  const maxRows = Math.max(3, getTranscriptHalfPageRows(viewportRows));
  return Math.sign(pending) * Math.min(Math.abs(pending), maxRows);
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
