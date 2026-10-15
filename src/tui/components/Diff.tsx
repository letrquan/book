import { Text, Box } from 'ink';
import { Fragment, useMemo } from 'react';
import { useTheme } from '../theme.js';
import { displayWidth, hardWrapLine, padDisplay, truncateDisplay } from './word-wrap.js';
import { highlightCode, type StyledSegment } from './syntax-highlight.js';
import type { TranscriptMode } from '../tool-presentation.js';

/**
 * Which rows a collapsed preview keeps. `changes` keeps every hunk's changed rows plus nearby
 * context, and reports what it hides as gap rows and a total. `head` keeps the first content
 * lines, one terminal row each, cut with `…` (a new file). `head-wrap` keeps the diff's first
 * rows in order, wrapped like the full diff (an edit).
 */
export type DiffPreviewKind = 'changes' | 'head' | 'head-wrap';

interface DiffProps {
  output: string;
  filePath?: string;
  /** When true, render a preview of the diff instead of all of it. */
  collapsed?: boolean;
  /**
   * Terminal-row budget for the collapsed preview; defaults to the transcript's. The
   * omission footer row is not counted: it is drawn after the budgeted rows.
   */
  maxRows?: number;
  /** Which rows the collapsed preview keeps; `changes` by default. */
  preview?: DiffPreviewKind;
  /** Key hint shown in the omission footer while collapsed; empty for none. */
  expandHint?: string;
  terminalWidth?: number;
}

const COLLAPSED_ROWS = 80;
/** Content lines the transcript previews of a newly created file. */
export const NEW_FILE_PREVIEW_ROWS = 10;
/** Rendered rows the compact transcript previews of a diff of an existing file. */
export const EDIT_PREVIEW_ROWS = 20;
const COLLAPSED_CONTEXT_ROWS = 2;
const MAX_WORD_TOKENS = 200;
const MAX_WORD_LINE_LENGTH = 2000;

export function isUnifiedDiffLike(output: string): boolean {
  const hasHunk = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/m.test(output);
  const hasChangedLine = /^(?:\+(?!\+\+)|-(?!--))/m.test(output);
  return hasHunk && hasChangedLine;
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'ctx' | 'meta';
export type DiffSpanKind = 'plain' | 'addedWord' | 'removedWord';

export interface DiffSpan {
  text: string;
  kind: DiffSpanKind;
}

export interface ParsedDiffLine {
  /** Original source row, unmodified; it forms the React key of the rendered row. */
  text: string;
  content: string;
  marker: '+' | '-' | ' ' | '@' | '\\';
  kind: DiffLineKind;
  oldLineNumber?: number;
  newLineNumber?: number;
  spans?: DiffSpan[];
}

interface HunkPosition {
  oldLine: number;
  newLine: number;
}

function parseHunkPosition(line: string): HunkPosition | undefined {
  const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
  if (!match) return undefined;
  return { oldLine: Number(match[1]), newLine: Number(match[2]) };
}

/** Parse Claude-style embedded word markers such as `{+new+}` when present. */
function parseEmbeddedWordMarkers(content: string): DiffSpan[] | undefined {
  const spans: DiffSpan[] = [];
  const combined = /\{(\+|\-)(.+?)\1\}/gs;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = combined.exec(content)) !== null) {
    const before = content.slice(lastIndex, match.index);
    if (before) spans.push({ text: before, kind: 'plain' });
    spans.push({
      text: match[2],
      kind: match[1] === '+' ? 'addedWord' : 'removedWord',
    });
    lastIndex = combined.lastIndex;
  }

  if (spans.length === 0) return undefined;
  const after = content.slice(lastIndex);
  if (after) spans.push({ text: after, kind: 'plain' });
  return spans;
}

function tokenizeForDiff(value: string): string[] {
  return value.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

function mergeSpans(spans: DiffSpan[]): DiffSpan[] {
  const merged: DiffSpan[] = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous?.kind === span.kind) previous.text += span.text;
    else if (span.text) merged.push({ ...span });
  }
  return merged;
}

/** Bounded token LCS for adjacent one-line replacements. */
function calculateReplacementSpans(
  removed: string,
  added: string,
): { removed: DiffSpan[]; added: DiffSpan[] } | undefined {
  if (removed.length > MAX_WORD_LINE_LENGTH || added.length > MAX_WORD_LINE_LENGTH)
    return undefined;
  const oldTokens = tokenizeForDiff(removed);
  const newTokens = tokenizeForDiff(added);
  if (
    oldTokens.length === 0 ||
    newTokens.length === 0 ||
    oldTokens.length > MAX_WORD_TOKENS ||
    newTokens.length > MAX_WORD_TOKENS
  ) {
    return undefined;
  }

  const table = Array.from(
    { length: oldTokens.length + 1 },
    () => new Uint16Array(newTokens.length + 1),
  );
  for (let oldIndex = oldTokens.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newTokens.length - 1; newIndex >= 0; newIndex--) {
      table[oldIndex][newIndex] =
        oldTokens[oldIndex] === newTokens[newIndex]
          ? table[oldIndex + 1][newIndex + 1] + 1
          : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
    }
  }

  const removedSpans: DiffSpan[] = [];
  const addedSpans: DiffSpan[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let commonTokens = 0;
  while (oldIndex < oldTokens.length || newIndex < newTokens.length) {
    if (
      oldIndex < oldTokens.length &&
      newIndex < newTokens.length &&
      oldTokens[oldIndex] === newTokens[newIndex]
    ) {
      removedSpans.push({ text: oldTokens[oldIndex], kind: 'plain' });
      addedSpans.push({ text: newTokens[newIndex], kind: 'plain' });
      oldIndex++;
      newIndex++;
      commonTokens++;
    } else if (
      newIndex < newTokens.length &&
      (oldIndex >= oldTokens.length ||
        table[oldIndex][newIndex + 1] >= table[oldIndex + 1][newIndex])
    ) {
      addedSpans.push({ text: newTokens[newIndex], kind: 'addedWord' });
      newIndex++;
    } else {
      removedSpans.push({ text: oldTokens[oldIndex], kind: 'removedWord' });
      oldIndex++;
    }
  }

  // Unrelated long lines are clearer with whole-line highlighting.
  if (commonTokens === 0 && Math.max(oldTokens.length, newTokens.length) > 8) return undefined;
  return { removed: mergeSpans(removedSpans), added: mergeSpans(addedSpans) };
}

export function parseDiffLines(output: string): ParsedDiffLine[] {
  if (output.length === 0) return [];

  let oldLine: number | undefined;
  let newLine: number | undefined;
  let inHunk = false;
  const lines = output.split('\n');
  // Inside a hunk a `--- ` / `+++ ` pair followed by a hunk header opens the next file's diff
  // (an ApplyPatch that adds several files joins them), so it is not a removed/added line.
  const isFileHeaderStart = (index: number): boolean =>
    lines[index]?.startsWith('--- ') === true &&
    lines[index + 1]?.startsWith('+++ ') === true &&
    lines[index + 2]?.startsWith('@@') === true;
  const rows = lines.map((text, index): ParsedDiffLine => {
    if (inHunk && isFileHeaderStart(index)) {
      // Leaving the hunk lets the `+++ ` line that follows parse as metadata too.
      inHunk = false;
      oldLine = undefined;
      newLine = undefined;
      return { text, content: text, marker: ' ', kind: 'meta' };
    }
    const hunk = parseHunkPosition(text);
    if (hunk) {
      inHunk = true;
      oldLine = hunk.oldLine;
      newLine = hunk.newLine;
      return { text, content: text, marker: '@', kind: 'hunk' };
    }
    if (text.startsWith('diff ')) {
      inHunk = false;
      oldLine = undefined;
      newLine = undefined;
      return { text, content: text, marker: ' ', kind: 'meta' };
    }
    if (!inHunk && (text.startsWith('---') || text.startsWith('+++'))) {
      return { text, content: text, marker: ' ', kind: 'meta' };
    }
    if (text.startsWith('\\ No newline at end of file')) {
      return { text, content: text.slice(2), marker: '\\', kind: 'meta' };
    }
    if (text.startsWith('-')) {
      const row = {
        text,
        content: text.slice(1),
        marker: '-' as const,
        kind: 'del' as const,
        oldLineNumber: oldLine,
        spans: parseEmbeddedWordMarkers(text.slice(1)),
      };
      if (oldLine !== undefined) oldLine++;
      return row;
    }
    if (text.startsWith('+')) {
      const row = {
        text,
        content: text.slice(1),
        marker: '+' as const,
        kind: 'add' as const,
        newLineNumber: newLine,
        spans: parseEmbeddedWordMarkers(text.slice(1)),
      };
      if (newLine !== undefined) newLine++;
      return row;
    }

    const content = text.startsWith(' ') ? text.slice(1) : text;
    const row = {
      text,
      content,
      marker: ' ' as const,
      kind: 'ctx' as const,
      oldLineNumber: oldLine,
      newLineNumber: newLine,
    };
    if (oldLine !== undefined) oldLine++;
    if (newLine !== undefined) newLine++;
    return row;
  });

  for (let index = 0; index < rows.length;) {
    if (rows[index].kind !== 'del') {
      index++;
      continue;
    }
    const deletedStart = index;
    while (index < rows.length && rows[index].kind === 'del') index++;
    const addedStart = index;
    while (index < rows.length && rows[index].kind === 'add') index++;
    const pairCount = Math.min(addedStart - deletedStart, index - addedStart);
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
      const removed = rows[deletedStart + pairIndex];
      const added = rows[addedStart + pairIndex];
      if (removed.spans || added.spans) continue;
      const replacement = calculateReplacementSpans(removed.content, added.content);
      if (!replacement) continue;
      removed.spans = replacement.removed;
      added.spans = replacement.added;
    }
  }
  return rows;
}

export function inferDiffLanguage(filePath: string | undefined): string | undefined {
  const extension = filePath?.split('.').pop()?.toLowerCase();
  const languages: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    sh: 'bash',
    bash: 'bash',
    json: 'json',
    yml: 'yaml',
    yaml: 'yaml',
    css: 'css',
    html: 'html',
    sql: 'sql',
  };
  return extension ? languages[extension] : undefined;
}

export function expandTabs(value: string, tabSize = 4): string {
  let column = 0;
  let result = '';
  for (const character of value) {
    if (character === '\t') {
      const spaces = tabSize - (column % tabSize);
      result += ' '.repeat(spaces);
      column += spaces;
    } else {
      result += character;
      column += displayWidth(character);
    }
  }
  return result;
}

function expandSpanTabs(spans: readonly DiffSpan[], tabSize = 4): DiffSpan[] {
  const output: DiffSpan[] = [];
  let column = 0;
  for (const span of spans) {
    let text = '';
    for (const character of span.text) {
      if (character === '\t') {
        const spaces = tabSize - (column % tabSize);
        text += ' '.repeat(spaces);
        column += spaces;
      } else {
        text += character;
        column += displayWidth(character);
      }
    }
    if (text) output.push({ ...span, text });
  }
  return output;
}

/** One row of spans cut to `width` columns, ending in `…` when anything was dropped. */
function truncateSpans(spans: readonly DiffSpan[], width: number): DiffSpan[] {
  const expanded = expandSpanTabs(spans);
  const full = expanded.map((span) => span.text).join('');
  const cut = truncateDisplay(full, width);
  if (cut === full) return expanded;
  let remaining = cut.endsWith('…') ? cut.length - 1 : cut.length;
  const kept: DiffSpan[] = [];
  for (const span of expanded) {
    if (remaining <= 0) break;
    const text = span.text.slice(0, remaining);
    remaining -= text.length;
    kept.push({ ...span, text });
  }
  if (cut.endsWith('…')) kept.push({ text: '…', kind: 'plain' });
  return kept;
}

function wrapSpans(spans: readonly DiffSpan[], width: number): DiffSpan[][] {
  const lines: DiffSpan[][] = [[]];
  let lineWidth = 0;

  for (const span of expandSpanTabs(spans)) {
    for (const character of span.text) {
      const characterWidth = displayWidth(character);
      if (lines[lines.length - 1].length > 0 && lineWidth + characterWidth > width) {
        lines.push([]);
        lineWidth = 0;
      }

      const line = lines[lines.length - 1];
      const previous = line[line.length - 1];
      if (previous?.kind === span.kind) previous.text += character;
      else line.push({ text: character, kind: span.kind });
      lineWidth += characterWidth;
    }
  }

  return lines;
}

function isContentRow(row: ParsedDiffLine): boolean {
  return row.kind === 'add' || row.kind === 'del' || row.kind === 'ctx';
}

/** File metadata (`--- path`, `+++ path`, `diff …`); a `\ No newline` marker is not. */
function isFileMetaRow(row: ParsedDiffLine): boolean {
  return row.kind === 'meta' && row.marker !== '\\';
}

/**
 * Where each file of a diff starts: a `diff ` line, or a `--- ` / `+++ ` pair that is not the
 * pair of a `diff ` header just above it. Rows before the first of those belong to a file of
 * their own. These are the boundaries `parseDiffLines` recognises as `meta` rows.
 */
function fileStarts(rows: readonly ParsedDiffLine[]): number[] {
  if (rows.length === 0) return [];
  const starts: number[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!isFileMetaRow(row)) continue;
    const previous = rows[index - 1];
    const startsFile =
      row.text.startsWith('diff ') ||
      (row.text.startsWith('--- ') &&
        rows[index + 1]?.kind === 'meta' &&
        rows[index + 1].text.startsWith('+++ ') &&
        !(previous?.kind === 'meta' && previous.text.startsWith('diff ')));
    if (startsFile) starts.push(index);
  }
  if (starts[0] !== 0) starts.unshift(0);
  return starts;
}

/** The rows a preview keeps, and the cap on a kept row too tall for the budget left. */
interface Selection {
  indices: number[];
  /** Row index → the wrapped terminal rows of it to draw; a row not here is drawn whole. */
  rowLimits: Map<number, number>;
}

/** The first `limit` content lines; hunk headers and file metadata are skipped. */
function selectHeadIndices(rows: readonly ParsedDiffLine[], limit: number): Selection {
  const indices: number[] = [];
  for (let index = 0; index < rows.length && indices.length < limit; index++) {
    if (isContentRow(rows[index])) indices.push(index);
  }
  return { indices, rowLimits: new Map() };
}

/** Rendered terminal rows a diff row occupies, given the width the renderer wraps it to. */
type RowCost = (index: number) => number;

/**
 * Head preview of an edit: the diff's first rows in order, hunk headers included, each long
 * line wrapped as the full diff wraps it. A line whose wrapped rows would overflow the budget
 * is left out whole. The diff's first line is always shown, but only as many of its wrapped
 * rows as the budget holds.
 *
 * A diff of one file skips its `---` / `+++` rows: the row above the diff names the path.
 * When one call's diff covers several files (a multi-file ApplyPatch or MultiEdit) they share
 * this one budget, in order, and keep those rows, which separate the files.
 */
function selectHeadRows(
  rows: readonly ParsedDiffLine[],
  budget: number,
  cost: RowCost,
  skipFileMeta: boolean,
): Selection {
  const indices: number[] = [];
  const rowLimits = new Map<number, number>();
  let used = 0;
  for (let index = 0; index < rows.length; index++) {
    if (skipFileMeta && isFileMetaRow(rows[index])) continue;
    const rowCost = cost(index);
    if (indices.length > 0 && used + rowCost > budget) break;
    if (rowCost > budget) rowLimits.set(index, budget);
    indices.push(index);
    used += Math.min(rowCost, budget);
    if (used >= budget) break;
  }
  return { indices, rowLimits };
}

/**
 * Change-focused preview, in rendered rows: every hunk's header and changed rows, then nearby
 * context, until the budget is spent. The `⋮ N lines omitted` gap rows and the hunk-header rows
 * count against it; the omission footer, drawn after the budgeted rows, does not.
 */
function selectChangeRows(
  rows: readonly ParsedDiffLine[],
  budget: number,
  cost: RowCost,
): Selection {
  // Every row costs at least one terminal row, so more rows than budget cannot fit whole.
  if (rows.length <= budget) {
    let total = 0;
    for (let index = 0; index < rows.length; index++) total += cost(index);
    if (total <= budget) return { indices: rows.map((_, index) => index), rowLimits: new Map() };
  }

  const changedIndices = rows
    .map((row, index) => (row.kind === 'add' || row.kind === 'del' ? index : -1))
    .filter((index) => index >= 0);
  if (changedIndices.length === 0) return selectHeadRows(rows, budget, cost, false);

  // contentBefore[i]: content lines in rows[0, i). A gap row sits wherever any are skipped.
  const contentBefore = new Array<number>(rows.length + 1);
  contentBefore[0] = 0;
  for (let index = 0; index < rows.length; index++) {
    contentBefore[index + 1] = contentBefore[index] + (isContentRow(rows[index]) ? 1 : 0);
  }
  const gapRows = (previous: number, index: number): number =>
    contentBefore[index] - contentBefore[previous + 1] > 0 ? 1 : 0;
  const selectionCost = (sorted: readonly number[], stopAbove = Infinity): number => {
    let total = 0;
    let previous = -1;
    for (const index of sorted) {
      total += cost(index) + gapRows(previous, index);
      if (total > stopAbove) break;
      previous = index;
    }
    return total;
  };

  const hunkHeaders = rows
    .map((row, index) => (row.kind === 'hunk' ? index : -1))
    .filter((index) => index >= 0);
  const priority = new Set([...hunkHeaders, ...changedIndices]);
  const priorityIndices = [...priority].sort((a, b) => a - b);

  if (selectionCost(priorityIndices, budget) > budget) {
    // Changes alone overflow: keep the first and last ones around a single gap row. The
    // first row is always shown, cut to the head's budget if it wraps to more rows.
    const headBudget = Math.ceil((budget - 1) / 2);
    const tailBudget = Math.floor((budget - 1) / 2);
    const head: number[] = [];
    const rowLimits = new Map<number, number>();
    let used = 0;
    let previous = -1;
    for (const index of priorityIndices) {
      const gap = gapRows(previous, index);
      let rowCost = cost(index) + gap;
      if (head.length > 0 && used + rowCost > headBudget) break;
      if (head.length === 0 && rowCost > headBudget) {
        const limit = Math.max(1, headBudget - gap);
        rowLimits.set(index, limit);
        rowCost = limit + gap;
      }
      head.push(index);
      used += rowCost;
      previous = index;
    }
    const tail: number[] = [];
    used = 0;
    let following = -1;
    for (let at = priorityIndices.length - 1; at >= 0; at--) {
      const index = priorityIndices[at];
      if (index <= head[head.length - 1]) break;
      const rowCost = cost(index) + (following >= 0 ? gapRows(index, following) : 0);
      if (used + rowCost > tailBudget) break;
      tail.unshift(index);
      used += rowCost;
      following = index;
    }
    return { indices: [...head, ...tail], rowLimits };
  }

  // Context is useful, but changed rows and hunk boundaries always win the budget.
  const contextCandidates = new Map<number, number>();
  for (const changedIndex of changedIndices) {
    for (let distance = 1; distance <= COLLAPSED_CONTEXT_ROWS; distance++) {
      for (const candidate of [changedIndex - distance, changedIndex + distance]) {
        if (candidate < 0 || candidate >= rows.length || priority.has(candidate)) continue;
        if (rows[candidate].kind !== 'ctx') continue;
        const previousDistance = contextCandidates.get(candidate);
        if (previousDistance === undefined || distance < previousDistance) {
          contextCandidates.set(candidate, distance);
        }
      }
    }
  }

  let selected = priorityIndices;
  const byProximity = [...contextCandidates.entries()].sort(
    ([leftIndex, leftDistance], [rightIndex, rightDistance]) =>
      leftDistance === rightDistance ? leftIndex - rightIndex : leftDistance - rightDistance,
  );
  for (const [candidate] of byProximity) {
    const trial = [...selected, candidate].sort((a, b) => a - b);
    if (selectionCost(trial, budget) <= budget) selected = trial;
  }
  return { indices: selected, rowLimits: new Map() };
}

/** A row's text as the renderer draws it: one entry per terminal row. */
interface RowText {
  content: string[];
  spans?: DiffSpan[][];
}

interface SelectedDiffRow {
  row: ParsedDiffLine;
  sourceIndex: number;
  /** The row's text, already cut to its row limit. */
  text: RowText;
  /** Content lines (add/del/ctx) omitted between the previous shown row and this one. */
  gapLines: number;
}

interface DiffGeometry {
  oldWidth: number;
  newWidth: number;
  /** Columns left for a row's text after the margin, rail, gutters and marker. */
  contentWidth: number;
}

function diffGeometry(rows: readonly ParsedDiffLine[], terminalWidth: number): DiffGeometry {
  // A loop, not a spread: a diff of hundreds of thousands of rows overflows the call stack.
  let maxOld = 1;
  let maxNew = 1;
  for (const row of rows) {
    if (row.oldLineNumber !== undefined && row.oldLineNumber > maxOld) maxOld = row.oldLineNumber;
    if (row.newLineNumber !== undefined && row.newLineNumber > maxNew) maxNew = row.newLineNumber;
  }
  const narrow = terminalWidth < 36;
  const oldWidth = Math.max(1, Math.min(String(maxOld).length, narrow ? 3 : 6));
  const newWidth = Math.max(1, Math.min(String(maxNew).length, narrow ? 3 : 6));
  // marginLeft(2) + `│` + gutters + marker remain visible before wrapped content.
  const fixedWidth = 2 + 1 + oldWidth + 1 + newWidth + 1 + 2;
  return { oldWidth, newWidth, contentWidth: Math.max(1, Math.floor(terminalWidth) - fixedWidth) };
}

/** A row's text as the renderer draws it: wrapped, or cut to one row when `truncate`. */
function layoutRowText(row: ParsedDiffLine, contentWidth: number, truncate: boolean): RowText {
  const spans = row.spans
    ? truncate
      ? [truncateSpans(row.spans, contentWidth)]
      : wrapSpans(row.spans, contentWidth)
    : undefined;
  const content = spans
    ? spans.map((line) => line.map((span) => span.text).join(''))
    : truncate
      ? [truncateDisplay(expandTabs(row.content), contentWidth)]
      : hardWrapLine(expandTabs(row.content), contentWidth);
  return { content, spans };
}

/**
 * A wrapped row cut to its first `limit` terminal rows. The last drawn row ends in `…`, the
 * way `truncateDisplay` marks a cut: it is cut from the row it was joined to.
 */
function limitRowText(text: RowText, limit: number, contentWidth: number): RowText {
  if (text.content.length <= limit) return text;
  const content = text.content.slice(0, limit);
  const last = limit - 1;
  if (!text.spans) {
    content[last] = truncateDisplay(content[last] + text.content[limit], contentWidth);
    return { content };
  }
  const spans = text.spans.slice(0, limit);
  spans[last] = truncateSpans([...spans[last], ...text.spans[limit]], contentWidth);
  content[last] = spans[last].map((span) => span.text).join('');
  return { content, spans };
}

/** One shared layout of a diff: what DiffBlock draws and what the footer reports. */
interface DiffLayout {
  rows: SelectedDiffRow[];
  /** Content lines (add/del/ctx) the preview leaves out; the footer's N. */
  omittedLines: number;
}

function layoutDiff(
  rows: readonly ParsedDiffLine[],
  contentWidth: number,
  collapsed: boolean,
  limit: number,
  preview: DiffPreviewKind,
): DiffLayout {
  const budget = Math.max(1, Math.floor(limit));
  // Each line of a new file's preview is cut to one terminal row instead of wrapping.
  const truncateLines = collapsed && preview === 'head';
  // A wrapped row is laid out once: costing it and drawing it share the result.
  const wrapped = new Map<number, RowText>();
  const wrappedText = (index: number): RowText => {
    let text = wrapped.get(index);
    if (text === undefined) {
      text = layoutRowText(rows[index], contentWidth, false);
      wrapped.set(index, text);
    }
    return text;
  };
  const cost: RowCost = (index) =>
    // Four columns per UTF-16 unit covers a tab and a double-width character: one row.
    rows[index].content.length * 4 <= contentWidth ? 1 : wrappedText(index).content.length;

  const selection: Selection = !collapsed
    ? { indices: rows.map((_, index) => index), rowLimits: new Map() }
    : preview === 'head'
      ? selectHeadIndices(rows, budget)
      : preview === 'head-wrap'
        ? selectHeadRows(rows, budget, cost, fileStarts(rows).length <= 1)
        : selectChangeRows(rows, budget, cost);
  const { indices, rowLimits } = selection;
  const selected = new Set(indices);
  // Hunk headers and metadata are signposts, not content: only lines count.
  const omittedLines = rows.reduce(
    (total, row, index) => total + (isContentRow(row) && !selected.has(index) ? 1 : 0),
    0,
  );
  let previous = -1;
  const selectedRows = indices.map((sourceIndex): SelectedDiffRow => {
    let gapLines = 0;
    for (let index = previous + 1; index < sourceIndex; index++) {
      if (isContentRow(rows[index])) gapLines++;
    }
    previous = sourceIndex;
    const row = rows[sourceIndex];
    const rowLimit = rowLimits.get(sourceIndex);
    const text = truncateLines
      ? layoutRowText(row, contentWidth, true)
      : rowLimit === undefined
        ? (wrapped.get(sourceIndex) ?? layoutRowText(row, contentWidth, false))
        : limitRowText(wrappedText(sourceIndex), rowLimit, contentWidth);
    return { row, sourceIndex, text, gapLines };
  });
  return { rows: selectedRows, omittedLines };
}

/**
 * The rows to draw, one file at a time. A file whose diff has exactly one hunk draws no header
 * (the gutter's line numbers already say where the change is). With several, each header is
 * recomputed from the hunk's own lines, because `tools/diff.ts` writes `@@ -a +c @@` without
 * counts, which reads as a one-line hunk: `-a,b +c,d` with b the context and removed lines, d
 * the context and added. A hunk's lines are the rows that start with ` `, `+` or `-`; it ends
 * at the first row that does not, such as the blank line and warning a tool appends.
 */
function prepareDiffRows(parsed: readonly ParsedDiffLine[]): ParsedDiffLine[] {
  if (!parsed.some((row) => row.kind === 'hunk')) return [...parsed];

  const starts = fileStarts(parsed);
  const rows: ParsedDiffLine[] = [];
  starts.forEach((start, fileIndex) => {
    const end = starts[fileIndex + 1] ?? parsed.length;
    let hunkCount = 0;
    for (let index = start; index < end; index++) {
      if (parsed[index].kind === 'hunk') hunkCount++;
    }
    for (let index = start; index < end; index++) {
      const row = parsed[index];
      const position = row.kind === 'hunk' ? parseHunkPosition(row.text) : undefined;
      if (!position || hunkCount === 0) {
        rows.push(row);
        continue;
      }
      if (hunkCount === 1) continue;
      let oldCount = 0;
      let newCount = 0;
      for (let next = index + 1; next < end; next++) {
        const line = parsed[next];
        if (line.kind === 'hunk') break;
        // A `\ No newline` marker belongs to the hunk but is not one of its lines.
        if (line.kind === 'meta' && line.marker === '\\') continue;
        if (line.kind === 'meta' || !/^[ +-]/.test(line.text)) break;
        if (line.kind !== 'add') oldCount++;
        if (line.kind !== 'del') newCount++;
      }
      rows.push({
        ...row,
        content: `@@ -${position.oldLine},${oldCount} +${position.newLine},${newCount} @@`,
      });
    }
  });
  return rows;
}

export interface DiffPreviewOptions {
  /** The same width DiffBlock receives as `terminalWidth`. */
  terminalWidth: number;
  preview: DiffPreviewKind;
  maxRows: number;
}

/**
 * The count the collapsed preview's omission footer reports: diff content lines the
 * preview leaves out. 0 exactly when the collapsed DiffBlock draws no footer.
 */
export function diffPreviewOmittedRows(output: string, options: DiffPreviewOptions): number {
  const rows = prepareDiffRows(parseDiffLines(output));
  const { contentWidth } = diffGeometry(rows, options.terminalWidth);
  return layoutDiff(rows, contentWidth, true, options.maxRows, options.preview).omittedLines;
}

/** The preview policy ToolCallBlock uses for a mutation diff. */
export function mutationDiffPreview(input: {
  createsSingleNewFile: boolean;
  transcriptMode: TranscriptMode;
  screenReader: boolean;
}): { preview: DiffPreviewKind; maxRows: number } {
  if (input.createsSingleNewFile) return { preview: 'head', maxRows: NEW_FILE_PREVIEW_ROWS };
  if (input.transcriptMode === 'detailed' || input.screenReader) {
    return { preview: 'changes', maxRows: COLLAPSED_ROWS };
  }
  return { preview: 'head-wrap', maxRows: EDIT_PREVIEW_ROWS };
}

function lineNumber(value: number | undefined, width: number): string {
  if (value === undefined) return ' '.repeat(width);
  const text = String(value);
  return text.length <= width ? padDisplay(text, width, 'right') : text.slice(-width);
}

function syntaxSegments(
  content: string,
  language: string | undefined,
  theme: ReturnType<typeof useTheme>,
): StyledSegment[] | undefined {
  if (!language || !content) return undefined;
  return highlightCode(content, language, theme)[0];
}

export function DiffBlock({
  output,
  filePath,
  collapsed = false,
  maxRows = COLLAPSED_ROWS,
  preview = 'changes',
  expandHint = 'Ctrl+E',
  terminalWidth = 80,
}: DiffProps) {
  const theme = useTheme();
  const parsed = useMemo(() => prepareDiffRows(parseDiffLines(output)), [output]);
  const { oldWidth, newWidth, contentWidth } = useMemo(
    () => diffGeometry(parsed, terminalWidth),
    [parsed, terminalWidth],
  );
  const selected = useMemo(
    () => layoutDiff(parsed, contentWidth, collapsed, maxRows, preview),
    [collapsed, contentWidth, maxRows, parsed, preview],
  );
  const language = inferDiffLanguage(filePath);
  const omittedNoun = selected.omittedLines === 1 ? 'line' : 'lines';
  // The change-focused preview reports what it hides as gap rows too, so its footer is the
  // total. A head preview hides only what trails the last row: `+N` more.
  const omittedLabel =
    preview === 'changes'
      ? `${selected.omittedLines} ${omittedNoun} hidden`
      : `+${selected.omittedLines} ${omittedNoun}`;

  return (
    <Box flexDirection="column">
      {selected.rows.map(({ row, sourceIndex, text, gapLines }) => {
        const backgroundColor =
          row.kind === 'add' ? theme.diffAdded : row.kind === 'del' ? theme.diffRemoved : undefined;
        // A hunk header is a signpost, not content: quiet, and never the accent.
        const foregroundColor = row.kind === 'hunk' ? theme.inactive : theme.text;
        const { content: wrappedContent, spans: wrappedSpans } = text;

        return (
          <Fragment key={`${sourceIndex}-${row.text}`}>
            {gapLines > 0 ? (
              <Box marginLeft={2}>
                <Text color={theme.subtle} dimColor>
                  │{' '}
                  {truncateDisplay(
                    `⋮ ${gapLines} ${gapLines === 1 ? 'line' : 'lines'} omitted`,
                    Math.max(4, terminalWidth - 4),
                  )}
                </Text>
              </Box>
            ) : null}
            {wrappedContent.map((content, visualIndex) => {
              const spans = wrappedSpans?.[visualIndex];
              const highlighted =
                !spans && (row.kind === 'add' || row.kind === 'del' || row.kind === 'ctx')
                  ? syntaxSegments(content, language, theme)
                  : undefined;
              const visibleWidth = spans
                ? spans.reduce((total, span) => total + displayWidth(span.text), 0)
                : displayWidth(content);
              const padding = backgroundColor
                ? ' '.repeat(Math.max(0, contentWidth - visibleWidth))
                : '';
              const continuation = visualIndex > 0;

              return (
                <Box key={visualIndex} marginLeft={2}>
                  <Text color={theme.toolRail}>│</Text>
                  <Text color={theme.subtle} dimColor>
                    {lineNumber(continuation ? undefined : row.oldLineNumber, oldWidth)}{' '}
                    {lineNumber(continuation ? undefined : row.newLineNumber, newWidth)}{' '}
                  </Text>
                  <Text
                    color={
                      row.kind === 'add'
                        ? theme.success
                        : row.kind === 'del'
                          ? theme.error
                          : foregroundColor
                    }
                    backgroundColor={backgroundColor}
                  >
                    {/* `@@ -6 +6 @@` already starts with its marker; a second
                        `@` in the marker column read as a rendering glitch. */}
                    {continuation || row.kind === 'hunk' ? ' ' : row.marker}{' '}
                  </Text>
                  <Text color={foregroundColor} backgroundColor={backgroundColor}>
                    {spans
                      ? spans.map((span, spanIndex) => (
                          <Text
                            key={spanIndex}
                            backgroundColor={
                              span.kind === 'addedWord'
                                ? theme.diffAddedWord
                                : span.kind === 'removedWord'
                                  ? theme.diffRemovedWord
                                  : backgroundColor
                            }
                            bold={span.kind !== 'plain'}
                          >
                            {span.text}
                          </Text>
                        ))
                      : highlighted
                        ? highlighted.map((segment, segmentIndex) => (
                            <Text
                              key={segmentIndex}
                              color={segment.color}
                              bold={segment.bold}
                              italic={segment.italic}
                              dimColor={segment.dimColor}
                            >
                              {segment.text}
                            </Text>
                          ))
                        : content}
                    {padding}
                  </Text>
                </Box>
              );
            })}
          </Fragment>
        );
      })}
      {/* The footer is not a budgeted row: it is drawn after the `maxRows` the layout spent. */}
      {selected.omittedLines > 0 ? (
        <Box marginLeft={2}>
          <Text color={theme.subtle} dimColor>
            │{' '}
            {truncateDisplay(
              `… ${omittedLabel}${collapsed && expandHint ? ` (${expandHint})` : ''}`,
              Math.max(4, terminalWidth - 4),
            )}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
