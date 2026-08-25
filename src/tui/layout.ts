/**
 * The transcript grid.
 *
 * Every row the TUI draws — an agent paragraph, a tool row, a turn rule, the
 * composer, the status line — resolves its horizontal position through this
 * module. Before it existed each component picked its own `marginLeft` and its
 * own `width - N` budget, so content landed on columns 1, 2, 4 and 5 with
 * nothing to scan down.
 *
 * The rule: a row is `[gutter][content]`. The gutter is exactly
 * {@link GUTTER_WIDTH} columns wide and carries status (a glyph, a rail, a
 * spinner); content always begins at {@link CONTENT_COLUMN}. Bordered surfaces
 * sit flush at column 0 so their one column of padding lands their text on the
 * same content column.
 *
 * Tool rows are the one deliberate step off that column. They carry their own
 * gutter one level in ({@link indentedGrid}) so the work a turn did reads as
 * nested under the prose that ordered it, instead of hanging a column of status
 * glyphs to the left of every sentence.
 */

/** Status glyph plus its trailing space: `"✓ "`, `"│ "`, `"  "`. */
export const GUTTER_WIDTH = 2;

/**
 * Widest measure the transcript will use, however wide the terminal is.
 *
 * Two things break without a cap. Prose set to 190 columns is genuinely hard to
 * read — the eye loses the line on the return sweep. And right-aligned
 * metadata stops meaning anything: a `67ms` sitting 170 columns from the
 * command it belongs to is not aligned with that command, it is merely far
 * away from it. Wide enough for diffs and code, narrow enough that a row still
 * reads as one row.
 */
export const MAX_MEASURE = 120;

/** Column where content begins on every row, nested or not. */
export const CONTENT_COLUMN = GUTTER_WIDTH;

/** Below this width the label column collapses and rows render inline. */
const LABEL_COLUMN_MIN_WIDTH = 76;

/** Widest label the aligned tool column holds without truncating. */
export const LABEL_COLUMN_WIDTH = 10;

/** A target column narrower than this is not worth aligning around. */
export const MIN_TARGET_WIDTH = 12;

export interface TranscriptGrid {
  /** Full terminal width in columns. */
  width: number;
  /** Columns available to content, measured from {@link CONTENT_COLUMN}. */
  content: number;
  /** Width of the fixed label column; `0` when labels render inline. */
  label: number;
  /** Columns the middle (target) column may occupy. */
  target: number;
  /** Columns reserved for right-aligned metadata. */
  meta: number;
}

/** Resolve the transcript grid for a terminal width. */
export function transcriptGrid(terminalWidth: number): TranscriptGrid {
  // One trailing column stays empty: writing the last cell makes some
  // terminals emit a spurious wrap, which shears the row below.
  const width = Math.min(MAX_MEASURE, Math.max(20, Math.floor(terminalWidth)));
  const content = Math.max(8, width - CONTENT_COLUMN - 1);
  const label = width >= LABEL_COLUMN_MIN_WIDTH ? LABEL_COLUMN_WIDTH : 0;
  const meta = Math.max(0, Math.min(20, Math.floor(content * 0.3)));
  const target = Math.max(MIN_TARGET_WIDTH, content - label - meta - 1);
  return { width, content, label, target, meta };
}

/**
 * A grid indented `depth` gutters, keeping its label column.
 *
 * The model says something, then shows its work; the work should sit under the
 * sentence that ordered it. Hanging the status glyph in a column to the *left*
 * of the prose made a turn read as a list of tool calls with text wedged
 * between them, the sentences pushed in from the margin rather than owning it.
 *
 * Indenting spends two columns, so the grid narrows as it shifts and the row's
 * right edge stays where the prose's is — right-aligned metadata still lines up
 * all the way down the transcript. Unlike {@link nestedGrid} the label column
 * survives: a top-level tool row is still the row that names its verb.
 */
export function indentedGrid(grid: TranscriptGrid, depth = 1): TranscriptGrid {
  const content = railContentWidth(grid, depth);
  const meta = Math.max(0, Math.min(20, Math.floor(content * 0.3)));
  const label = Math.min(grid.label, Math.max(0, content - meta - MIN_TARGET_WIDTH - 1));
  return {
    ...grid,
    content,
    label,
    target: Math.max(MIN_TARGET_WIDTH, content - label - meta - 1),
    meta,
  };
}

/** Content width inside a rail nested `depth` levels under a transcript row. */
export function railContentWidth(grid: TranscriptGrid, depth = 1): number {
  return Math.max(8, grid.content - GUTTER_WIDTH * depth);
}

/**
 * A grid for rows nested under a transcript row (a rail, a mutation child).
 *
 * Nested rows drop the label column: the parent row already named the verb, and
 * at this depth the columns left over are better spent on the target.
 */
export function nestedGrid(grid: TranscriptGrid, depth = 1): TranscriptGrid {
  const content = railContentWidth(grid, depth);
  const meta = Math.max(0, Math.min(20, Math.floor(content * 0.3)));
  return {
    ...grid,
    content,
    label: 0,
    target: Math.max(MIN_TARGET_WIDTH, content - meta - 1),
    meta,
  };
}

/**
 * Narrow the label column to what a specific run of rows actually needs.
 *
 * The column is sized per message, not globally: a turn of `Bash` / `Read` /
 * `Grep` rows needs four columns, and padding those to fit a hypothetical
 * `Git status` opens a visible gulf between every verb and its target. A label
 * too wide for the measured column is not truncated — {@link composeToolRow}
 * runs it inline instead, so an under-measured column costs alignment on that
 * one row and never legibility.
 */
export function withLabelColumn(grid: TranscriptGrid, labelWidth: number): TranscriptGrid {
  if (grid.label === 0) return grid;
  const label = Math.max(1, Math.min(LABEL_COLUMN_WIDTH, Math.floor(labelWidth)));
  if (label === grid.label) return grid;
  return {
    ...grid,
    label,
    target: Math.max(MIN_TARGET_WIDTH, grid.content - label - grid.meta - 1),
  };
}

export interface FrameGrid {
  /** Outer width of the bordered box. */
  width: number;
  /** Horizontal margin outside the border. Always 0: boxes sit flush left. */
  marginX: number;
}

/**
 * Metrics for a bordered surface (composer, menu, permission prompt).
 *
 * The box is flush at column 0 so that its border plus one column of padding
 * places its text on {@link CONTENT_COLUMN}, matching every transcript row.
 */
export function frameGrid(terminalWidth: number): FrameGrid {
  const outer = Math.min(MAX_MEASURE, Math.max(20, Math.floor(terminalWidth)));
  if (outer < 32) return { width: outer, marginX: 0 };
  return { width: outer - 1, marginX: 0 };
}
