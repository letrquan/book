/**
 * Pure layout helpers for MarkdownBlock: tables, fenced code chrome, and
 * nested block width budgets. All measurements use displayWidth (CJK/emoji
 * safe). No React imports — unit-testable without Ink.
 */

import {
  displayWidth,
  hardWrapLine,
  makeDivider,
  padDisplay,
  truncateDisplay,
  wordWrap,
} from './word-wrap.js';

export type TableAlign = 'left' | 'right' | 'center' | null | undefined;

export interface TableCellInput {
  text: string;
}

export interface TableLayoutInput {
  header: TableCellInput[];
  rows: TableCellInput[][];
  align?: TableAlign[];
  /** Available terminal columns for the whole table (including borders). */
  terminalWidth: number;
}

export interface TableGridLayout {
  mode: 'grid';
  /** Display widths of cell content (excluding padding/borders). */
  colWidths: number[];
  /** Full border/body line width (display columns). */
  totalWidth: number;
  top: string;
  middle: string;
  bottom: string;
  /** First visual header row (padded cells). */
  headerCells: string[];
  /** Full multi-line header rows (padded cells). */
  headerRows: string[][];
  bodyRows: string[][];
}

export interface TableStackedLayout {
  mode: 'stacked';
  /** Lines like "Header: value", already hard-wrapped to terminalWidth. */
  lines: string[];
}

export type TableLayout = TableGridLayout | TableStackedLayout;

export interface CodeLineLayout {
  /** Gutter prefix for this visual line (line number + separator, or continuation spaces). */
  gutter: string;
  /** Hard-wrapped content segment for this visual line. */
  text: string;
  /** 0-based source line index in the original fenced block. */
  sourceLineIndex: number;
  /** Character offset into the original source line where `text` starts. */
  sourceStart: number;
  /** Character offset into the original source line where `text` ends (exclusive). */
  sourceEnd: number;
  /** True when this is a continuation of a previous hard-wrap for the same source line. */
  isContinuation: boolean;
}

export interface CodeBlockLayout {
  showBorder: boolean;
  showLineNumbers: boolean;
  /** Content columns available after border/padding/gutter. */
  contentWidth: number;
  /** Full outer width budget used for border lines. */
  outerWidth: number;
  /** Language label, truncated to contentWidth when present. */
  langLabel: string | null;
  /** Flattened visual lines ready to render. */
  lines: CodeLineLayout[];
}

const MIN_CELL = 1;
const CELL_PAD = 1; // one space on each side of cell content in borders: "─".repeat(w+2)
// Row format: │ + " " + cell + " " + │ ...  → per column: 3 chrome chars + width,
// plus one final │. Equivalently: 1 + sum(width_i + 3) for n columns?
// Actual: "│ " + cell + " │ " + cell + " │"
// Between cells: " │ " (3), left edge "│ " (2), right edge "│" (1).
// total = 1 (left │) + n * (1 space + width + 1 space) + (n-1) * 1 (│ between) + 1?
// Looking at current MarkdownBlock: `│ ` + cell + ` │ ` between + final via same pattern.
// renderTableRow: <Text>│ </Text> then for each cell: cell + ` │ `
// So: "│ " + cell0 + " │ " + cell1 + " │ " ... = 2 + sum(width_i + 3) for each cell
// = 2 + n*width + 3n = n*width + 3n + 2
// Border: ┌ + ─.repeat(w+2) joined by ┬ + ┐
// = 1 + sum(w+2) + (n-1) + 1 = n*w + 2n + n + 1? join('┬') adds n-1 seps of 1
// = 1 + sum(w_i+2) + (n-1) + 1 = sum(w_i) + 2n + n - 1 + 2 = sum(w) + 3n + 1
// Row body: "│ " (2) + for each: cell + " │ " (width+3) = 2 + sum(w)+3n = sum(w)+3n+2
// Off-by-one: border is sum(w)+3n+1, body is sum(w)+3n+2
// Looking at existing code:
// const separator = colWidths.map((width) => '─'.repeat(width + 2));
// const top = `┌${separator.join('┬')}┐`;
// For widths [3,3]: sep = ['─────','─────'] join ┬ → ┌─────┬─────┐ length = 1+5+1+5+1=13
// Body: │ + space + 3 + space + │ + space + 3 + space + │ = 2+3+3+2+3+3?
// "│ " + "aaa" + " │ " + "bbb" + " │" = 2+3+3+3+3+2 wait
// "│ " = 2, cell=3, " │ " = 3, cell=3, " │" = 2 → 2+3+3+3+2 = 13. Yes!
// So totalWidth = sum(w_i + 2) + (n - 1) + 2 = sum(w) + 2n + n - 1 + 2 = sum(w) + 3n + 1
// With the trailing " │" being 2 chars (space+│) not 3.
// Formula: 1 + sum(width_i + 2) + (n-1) = sum(width) + 3n

function tableChromeWidth(colWidths: number[]): number {
  if (colWidths.length === 0) return 0;
  // ┌ + ─×(w+2) joined by ┬ + ┐  == sum(w) + 3n
  // Body: "│ " + cells with " │ " separators ending in " │" matches same width.
  return colWidths.reduce((sum, w) => sum + w + 2, 0) + (colWidths.length - 1) + 2;
}

function normalizeAlign(align: TableAlign): 'left' | 'right' | 'center' {
  if (align === 'right' || align === 'center') return align;
  return 'left';
}

/**
 * Allocate column content widths that fit inside `terminalWidth`.
 * Prefers natural content widths; shrinks proportionally when needed.
 * Returns null when even minimum columns cannot fit (caller should stack).
 */
export function allocateTableColumns(
  naturalWidths: number[],
  terminalWidth: number,
): number[] | null {
  const n = naturalWidths.length;
  if (n === 0) return [];

  const minTotal = tableChromeWidth(Array(n).fill(MIN_CELL));
  if (terminalWidth < minTotal) return null;

  const natural = naturalWidths.map((w) => Math.max(MIN_CELL, Math.ceil(w)));
  const naturalTotal = tableChromeWidth(natural);
  if (naturalTotal <= terminalWidth) return natural;

  // Budget available for pure cell content.
  const contentBudget = terminalWidth - (tableChromeWidth(Array(n).fill(0)));
  // tableChromeWidth(zeros) = 0*n + 3n = 3n ... wait:
  // sum(0+2) + (n-1) + 2 = 2n + n - 1 + 2 = 3n + 1. Yes.
  // contentBudget = terminalWidth - (3n + 1), and sum(widths) must equal contentBudget?
  // total = sum(w) + 3n + 1 => sum(w) = terminalWidth - 3n - 1
  const sumTarget = terminalWidth - 3 * n - 1;
  if (sumTarget < n * MIN_CELL) return null;

  // Start from natural, shrink largest columns first until sum fits.
  const widths = [...natural];
  let sum = widths.reduce((a, b) => a + b, 0);
  while (sum > sumTarget) {
    let maxIdx = 0;
    for (let i = 1; i < n; i++) {
      if (widths[i]! > widths[maxIdx]!) maxIdx = i;
    }
    if (widths[maxIdx]! <= MIN_CELL) break;
    widths[maxIdx]! -= 1;
    sum -= 1;
  }

  if (sum > sumTarget) return null;
  // Distribute any leftover to the widest natural columns for readability.
  let leftover = sumTarget - sum;
  while (leftover > 0) {
    let maxIdx = 0;
    for (let i = 1; i < n; i++) {
      if (natural[i]! > natural[maxIdx]!) maxIdx = i;
    }
    // Prefer columns that are still below natural width.
    let growIdx = -1;
    for (let i = 0; i < n; i++) {
      if (widths[i]! < natural[i]!) {
        if (growIdx < 0 || natural[i]! > natural[growIdx]!) growIdx = i;
      }
    }
    if (growIdx < 0) growIdx = maxIdx;
    widths[growIdx]! += 1;
    leftover -= 1;
  }

  return widths;
}

function wrapCellLines(text: string, width: number): string[] {
  if (width <= 0) return [''];
  const soft = wordWrap(text, width);
  const out: string[] = [];
  for (const line of soft.split('\n')) {
    out.push(...hardWrapLine(line, width));
  }
  return out.length > 0 ? out : [''];
}

function buildBorder(colWidths: number[], left: string, join: string, right: string): string {
  return `${left}${colWidths.map((w) => '─'.repeat(w + 2)).join(join)}${right}`;
}

/**
 * Layout a markdown table for the given terminal width.
 * Falls back to stacked "Header: value" lines when the grid cannot fit.
 */
export function layoutTable(input: TableLayoutInput): TableLayout {
  const { header, rows, align = [], terminalWidth } = input;
  const colCount = Math.max(header.length, ...rows.map((r) => r.length), 0);
  if (colCount === 0) {
    return { mode: 'stacked', lines: [] };
  }

  const normalizedHeader = Array.from({ length: colCount }, (_, i) => header[i]?.text ?? '');
  const normalizedRows = rows.map((row) =>
    Array.from({ length: colCount }, (_, i) => row[i]?.text ?? ''),
  );

  const naturalWidths: number[] = Array.from({ length: colCount }, () => MIN_CELL);
  for (let ci = 0; ci < colCount; ci++) {
    naturalWidths[ci] = Math.max(naturalWidths[ci]!, displayWidth(normalizedHeader[ci]!));
    for (const row of normalizedRows) {
      naturalWidths[ci] = Math.max(naturalWidths[ci]!, displayWidth(row[ci]!));
    }
  }

  const widthBudget = Math.max(0, Math.floor(terminalWidth));
  const colWidths = allocateTableColumns(naturalWidths, widthBudget);

  // Prefer stacked layout when columns are extremely narrow relative to content
  // or allocation failed (too many columns / tiny terminal).
  const tooNarrow =
    colWidths === null ||
    colWidths.some((w, i) => w < 3 && naturalWidths[i]! > w * 2) ||
    (colCount >= 4 && widthBudget < colCount * 8);

  if (tooNarrow || colWidths === null) {
    return {
      mode: 'stacked',
      lines: layoutStackedTable(normalizedHeader, normalizedRows, widthBudget),
    };
  }

  // Wrap header + body cells; expand multi-line cells into stacked visual rows.
  const headerLineGroups = normalizedHeader.map((text, ci) => wrapCellLines(text, colWidths[ci]!));
  const headerHeight = Math.max(1, ...headerLineGroups.map((lines) => lines.length));
  const headerRows: string[][] = [];
  for (let li = 0; li < headerHeight; li++) {
    headerRows.push(
      headerLineGroups.map((lines, ci) =>
        padDisplay(lines[li] ?? '', colWidths[ci]!, normalizeAlign(align[ci])),
      ),
    );
  }

  const bodyRows: string[][] = [];
  for (const row of normalizedRows) {
    const cellLines = row.map((text, ci) => wrapCellLines(text, colWidths[ci]!));
    const height = Math.max(1, ...cellLines.map((lines) => lines.length));
    for (let li = 0; li < height; li++) {
      bodyRows.push(
        cellLines.map((lines, ci) =>
          padDisplay(lines[li] ?? '', colWidths[ci]!, normalizeAlign(align[ci])),
        ),
      );
    }
  }

  const totalWidth = tableChromeWidth(colWidths);
  return {
    mode: 'grid',
    colWidths,
    totalWidth,
    top: buildBorder(colWidths, '┌', '┬', '┐'),
    middle: buildBorder(colWidths, '├', '┼', '┤'),
    bottom: buildBorder(colWidths, '└', '┴', '┘'),
    // First visual header row kept as headerCells for simple consumers;
    // full multi-line header is in headerRows.
    headerCells: headerRows[0] ?? Array(colCount).fill(''.padEnd(0)),
    headerRows,
    bodyRows,
  };
}

function layoutStackedTable(header: string[], rows: string[][], terminalWidth: number): string[] {
  const width = Math.max(1, terminalWidth);
  const lines: string[] = [];
  for (const row of rows) {
    if (lines.length > 0) lines.push(''); // blank separator between records
    for (let ci = 0; ci < header.length; ci++) {
      const label = header[ci]?.trim() || `Col ${ci + 1}`;
      const value = row[ci] ?? '';
      const combined = `${label}: ${value}`;
      const wrapped = wordWrap(combined, width).split('\n');
      for (const line of wrapped) {
        lines.push(...hardWrapLine(line, width));
      }
    }
  }
  // If there are headers but no body rows, still show headers.
  if (rows.length === 0 && header.some((h) => h.length > 0)) {
    for (const h of header) {
      lines.push(...hardWrapLine(h, width));
    }
  }
  return lines;
}

/** Nested content budget after list markers / blockquote bars. */
export function nestedContentWidth(
  terminalWidth: number | undefined,
  options: { depth?: number; listGutter?: number; blockquoteDepth?: number } = {},
): number | undefined {
  if (terminalWidth === undefined) return undefined;
  const depth = options.depth ?? 0;
  const listGutter = options.listGutter ?? 5; // marker column + margins
  const bq = options.blockquoteDepth ?? 0;
  // Each list depth: +2 marginLeft on list + 2 on item ≈ 4, plus marker width ~3.
  // Keep a conservative clamp matching previous Math.max(10, terminalWidth - 5 - depth*2).
  const listDeduction = listGutter + depth * 2;
  const bqDeduction = bq * 2; // border + paddingLeft
  return Math.max(1, Math.floor(terminalWidth) - listDeduction - bqDeduction);
}

/** Clamp decorative heading chrome so it fits `terminalWidth`. */
export function layoutHeadingChrome(
  text: string,
  depth: number,
  terminalWidth: number | undefined,
): { prefix: string; text: string; suffix: string } {
  const raw = text;
  if (!terminalWidth || terminalWidth <= 0) {
    if (depth === 1) return { prefix: '═══ ', text: raw.toUpperCase(), suffix: ' ═══' };
    if (depth === 2) return { prefix: '── ', text: raw, suffix: ' ──' };
    return { prefix: `${'#'.repeat(depth)} `, text: raw, suffix: '' };
  }

  const width = Math.max(1, Math.floor(terminalWidth));

  if (depth === 1) {
    const upper = raw.toUpperCase();
    const side = '═══';
    // "═══ " + text + " ═══"
    const chrome = displayWidth(`${side}  ${side}`); // spaces around text: 2
    const budget = Math.max(1, width - chrome);
    return {
      prefix: `${side} `,
      text: fitsIn(upper, budget) ? upper : truncateDisplay(upper, budget),
      suffix: ` ${side}`,
    };
  }

  if (depth === 2) {
    const side = '──';
    const chrome = displayWidth(`${side}  ${side}`);
    const budget = Math.max(1, width - chrome);
    return {
      prefix: `${side} `,
      text: fitsIn(raw, budget) ? raw : truncateDisplay(raw, budget),
      suffix: ` ${side}`,
    };
  }

  const hashes = '#'.repeat(depth);
  const prefix = `${hashes} `;
  const budget = Math.max(1, width - displayWidth(prefix));
  return {
    prefix,
    text: fitsIn(raw, budget) ? raw : truncateDisplay(raw, budget),
    suffix: '',
  };
}

function fitsIn(text: string, width: number): boolean {
  return displayWidth(text) <= width;
}

/** Horizontal rule that respects terminal width (min 5, max 60). */
export function layoutHorizontalRule(terminalWidth: number | undefined): string {
  const width = terminalWidth && terminalWidth > 0 ? Math.floor(terminalWidth) : 40;
  return makeDivider(Math.min(width, 60), 0, '─');
}

/**
 * Layout a fenced code block.
 *
 * Accounts for round border (2) + paddingX (2) + optional line-number gutter.
 * Hard-wraps unbroken source lines; continuation lines use a blank gutter so
 * numbers are not repeated. Drops line numbers and/or border when the budget
 * is too tight.
 */
export function layoutCodeBlock(
  sourceLines: string[],
  terminalWidth: number | undefined,
  options: { lang?: string; preferLineNumbers?: boolean } = {},
): CodeBlockLayout {
  const preferLineNumbers =
    options.preferLineNumbers ?? sourceLines.length > 5;
  const lang = options.lang?.trim() || null;

  // Without a known width, keep full chrome and do not wrap (Ink may hard-wrap).
  if (!terminalWidth || terminalWidth <= 0) {
    const gutterWidth = String(Math.max(sourceLines.length, 1)).length;
    const showLineNumbers = preferLineNumbers;
    const lines: CodeLineLayout[] = sourceLines.map((text, i) => {
      const gutter = showLineNumbers
        ? `${String(i + 1).padStart(gutterWidth, ' ')} │ `
        : '';
      return {
        gutter,
        text,
        sourceLineIndex: i,
        sourceStart: 0,
        sourceEnd: text.length,
        isContinuation: false,
      };
    });
    return {
      showBorder: true,
      showLineNumbers,
      contentWidth: Number.POSITIVE_INFINITY,
      outerWidth: terminalWidth ?? 0,
      langLabel: lang,
      lines,
    };
  }

  const outerWidth = Math.max(1, Math.floor(terminalWidth));

  // Border cost: left + right border columns (round style uses 1 each).
  // paddingX={1} adds 1 column each side inside the border.
  const BORDER = 2;
  const PADDING_X = 2;

  type Chrome = { border: boolean; lineNumbers: boolean };
  const candidates: Chrome[] = [
    { border: true, lineNumbers: preferLineNumbers },
    { border: true, lineNumbers: false },
    { border: false, lineNumbers: preferLineNumbers },
    { border: false, lineNumbers: false },
  ];

  const gutterWidth = String(Math.max(sourceLines.length, 1)).length;
  // "N │ " → gutterWidth + 3
  const lineNumberGutterCols = gutterWidth + 3;

  let chosen: Chrome = { border: false, lineNumbers: false };
  let contentWidth = Math.max(1, outerWidth);

  for (const candidate of candidates) {
    const chrome =
      (candidate.border ? BORDER + PADDING_X : 0) +
      (candidate.lineNumbers ? lineNumberGutterCols : 0);
    const available = outerWidth - chrome;
    if (available >= 1) {
      chosen = candidate;
      contentWidth = available;
      break;
    }
  }

  // Final clamp: always leave at least 1 content column.
  contentWidth = Math.max(1, contentWidth);

  const langLabel =
    lang === null
      ? null
      : fitsIn(lang, contentWidth)
        ? lang
        : truncateDisplay(lang, contentWidth);

  const lines: CodeLineLayout[] = [];
  for (let i = 0; i < sourceLines.length; i++) {
    const source = sourceLines[i] ?? '';
    const chunks = hardWrapLine(source, contentWidth);
    let charOffset = 0;
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci]!;
      // hardWrapLine splits by code points; concatenation of chunks equals source.
      const start = charOffset;
      const end = start + chunk.length;
      charOffset = end;

      const isContinuation = ci > 0;
      let gutter = '';
      if (chosen.lineNumbers) {
        gutter = isContinuation
          ? `${' '.repeat(gutterWidth)} │ `
          : `${String(i + 1).padStart(gutterWidth, ' ')} │ `;
      }

      lines.push({
        gutter,
        text: chunk,
        sourceLineIndex: i,
        sourceStart: start,
        sourceEnd: end,
        isContinuation,
      });
    }
  }

  return {
    showBorder: chosen.border,
    showLineNumbers: chosen.lineNumbers,
    contentWidth,
    outerWidth,
    langLabel,
    lines,
  };
}

/**
 * Slice a styled segment line by character offsets (not display width).
 * Preserves segment styles for hard-wrapped code visual lines.
 */
export function sliceStyledLine<T extends { text: string }>(
  segments: T[],
  start: number,
  end: number,
): T[] {
  if (end <= start) return [];
  const out: T[] = [];
  let cursor = 0;
  for (const seg of segments) {
    const segStart = cursor;
    const segEnd = cursor + seg.text.length;
    const overlapStart = Math.max(segStart, start);
    const overlapEnd = Math.min(segEnd, end);
    if (overlapStart < overlapEnd) {
      const text = seg.text.slice(overlapStart - segStart, overlapEnd - segStart);
      if (text) out.push({ ...seg, text });
    }
    cursor = segEnd;
    if (cursor >= end) break;
  }
  return out;
}
