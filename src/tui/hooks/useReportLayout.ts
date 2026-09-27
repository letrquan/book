import { useEffect, useLayoutEffect, useRef } from 'react';

export interface LayoutReport {
  /** The footer's height may have changed: the app re-measures the transcript. */
  onLayoutChange?: () => void;
  /**
   * Whether this surface is holding a text editor's focus right now.
   *
   * A surface with an editor open has taken the readline chords: Ctrl+U clears
   * the editor and Ctrl+D deletes under the cursor, so the transcript must not
   * also read them as half-page scrolls. Reported on the same schedule as
   * {@link LayoutReport.onLayoutChange}, because opening and closing the editor
   * is the same event as the sheet growing and shrinking by a row.
   */
  editorFocused?: boolean;
  /** Called when {@link LayoutReport.editorFocused} changes. */
  onEditorFocusChange?: (focused: boolean) => void;
}

/**
 * Tell the app when a surface's height has changed, so the transcript above it
 * re-measures its viewport instead of being covered by the rows the surface just
 * grew into.
 *
 * `shape` identifies the surface's *rendered size*, not its content. A sheet
 * that grows by a row reports; a sheet that redraws the same number of rows does
 * not. That distinction is the whole contract: a report costs a layout
 * measurement, and a report per keystroke would make typing in a field re-measure
 * the transcript on every character. So the caller joins the facts that change
 * the row count — which question, whether an editor is open, a notice, the
 * width the body wraps to — rather than passing a value.
 *
 * Reports once on mount, once per change of shape, and once on unmount, which is
 * what lets the transcript take the rows back. Not once per render, and not
 * twice per change: a `useLayoutEffect` that reported from its own cleanup
 * fired the callback again as the next shape's effect ran, so every change cost
 * two layout measurements and the reports no longer lined up with the changes.
 */
export function useReportLayout(shape: string, report: LayoutReport = {}): void {
  const { onLayoutChange, editorFocused = false, onEditorFocusChange } = report;
  // Read at unmount through a ref so a caller that passes a new closure each
  // render does not turn the unmount report into one report per render.
  const onLayoutChangeRef = useRef(onLayoutChange);
  onLayoutChangeRef.current = onLayoutChange;
  const onEditorFocusChangeRef = useRef(onEditorFocusChange);
  onEditorFocusChangeRef.current = onEditorFocusChange;

  // `null` rather than the initial shape: the first report is a real one, and a
  // ref seeded with the shape would swallow it.
  const reportedShapeRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (reportedShapeRef.current === shape) return;
    reportedShapeRef.current = shape;
    onLayoutChange?.();
  }, [shape, onLayoutChange]);

  // Empty deps on purpose: this is the unmount report, and it must not re-run
  // when the callback identity changes.
  useEffect(
    () => () => {
      onLayoutChangeRef.current?.();
    },
    [],
  );

  useLayoutEffect(() => {
    onEditorFocusChange?.(editorFocused);
  }, [editorFocused, onEditorFocusChange]);
}
