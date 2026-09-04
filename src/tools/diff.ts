import { throwIfAborted, yieldToEventLoop } from '../async.js';

/**
 * Minimal unified-diff generator for tool result output.
 * Produces a CC-style snippet: a few context lines around each hunk with
 * `-`/`+` markers. Good enough for ToolCallBlock rendering; not a full diff3.
 */

function splitLines(s: string): string[] {
  // Preserve a trailing empty line so edits at EOF render correctly.
  const lines = s.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: Array<{ kind: 'ctx' | 'add' | 'del'; text: string }>;
}

export interface DiffStats {
  addedLines: number;
  removedLines: number;
}

interface DiffOp {
  kind: 'ctx' | 'add' | 'del';
  text: string;
  ai: number;
  bi: number;
}

const DIFF_YIELD_CELLS = 32_768;
const DIFF_YIELD_ITEMS = 1_024;

/**
 * Lines shared at both ends of the two inputs.
 *
 * The LCS table below is O(n·m) in time and memory, and almost every real
 * edit changes a few lines of a file that is otherwise identical on both
 * sides. Trimming the shared prefix and suffix first turns a one-line edit
 * in a twenty-thousand-line file from a 400M-cell table into a handful.
 */
function commonAffixes(a: string[], b: string[]): { prefix: number; suffix: number } {
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { prefix, suffix };
}

function contextOps(a: string[], from: number, count: number, bOffset: number): DiffOp[] {
  const ops: DiffOp[] = [];
  for (let index = 0; index < count; index++) {
    const ai = from + index;
    ops.push({ kind: 'ctx', text: a[ai], ai, bi: ai + bOffset });
  }
  return ops;
}

/** Walk a filled LCS table into an edit script, offset into the full inputs. */
function editScript(
  a: string[],
  b: string[],
  dp: ArrayLike<ArrayLike<number>>,
  offset: number,
): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'ctx', text: a[i], ai: offset + i, bi: offset + j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'del', text: a[i], ai: offset + i, bi: offset + j });
      i++;
    } else {
      ops.push({ kind: 'add', text: b[j], ai: offset + i, bi: offset + j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: 'del', text: a[i], ai: offset + i, bi: offset + j });
    i++;
  }
  while (j < m) {
    ops.push({ kind: 'add', text: b[j], ai: offset + i, bi: offset + j });
    j++;
  }
  return ops;
}

/** Group consecutive non-context ops into hunks, padded by `context` ctx lines. */
function hunkBounds(ops: DiffOp[], context: number): Array<[number, number]> {
  const bounds: Array<[number, number]> = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].kind === 'ctx') {
      k++;
      continue;
    }
    const start = k;
    // Walk back context.
    let ctxBefore = 0;
    let s = start - 1;
    while (s >= 0 && ops[s].kind === 'ctx' && ctxBefore < context) {
      s--;
      ctxBefore++;
    }
    // Walk forward through all consecutive non-context ops, then context after.
    let e = start;
    while (e < ops.length && ops[e].kind !== 'ctx') e++;
    let ctxAfter = 0;
    while (e < ops.length && ops[e].kind === 'ctx' && ctxAfter < context) {
      e++;
      ctxAfter++;
    }
    bounds.push([s + 1, e]);
    k = e;
  }
  return bounds;
}

function hunkFrom(ops: DiffOp[], start: number, end: number): DiffHunk {
  const hunkOps = ops.slice(start, end);
  return {
    oldStart: (hunkOps[0]?.ai ?? 0) + 1,
    newStart: (hunkOps[0]?.bi ?? 0) + 1,
    lines: hunkOps.map((o) => ({ kind: o.kind, text: o.text })),
  };
}

/** Compute a line-level diff between two strings. Returns hunks with context. */
export function lineDiff(oldText: string, newText: string, context = 3): DiffHunk[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const { prefix, suffix } = commonAffixes(a, b);
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  // LCS-based edit script over the changed span only.
  const n = midA.length;
  const m = midB.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [
    ...contextOps(a, 0, prefix, 0),
    ...editScript(midA, midB, dp, prefix),
    ...contextOps(a, a.length - suffix, suffix, b.length - a.length),
  ];
  return hunkBounds(ops, context).map(([start, end]) => hunkFrom(ops, start, end));
}

/** Cooperative variant used by agent tools so large diffs do not block Ink. */
export async function lineDiffAsync(
  oldText: string,
  newText: string,
  context = 3,
  signal?: AbortSignal,
): Promise<DiffHunk[]> {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const { prefix, suffix } = commonAffixes(a, b);
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const n = midA.length;
  const m = midB.length;
  const dp: number[][] = [];

  for (let row = 0; row <= n; row++) {
    dp.push(new Array<number>(m + 1).fill(0));
    if (row > 0 && row % 128 === 0) await yieldToEventLoop(signal);
  }

  let cellsUntilYield = DIFF_YIELD_CELLS;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      cellsUntilYield--;
      if (cellsUntilYield === 0) {
        cellsUntilYield = DIFF_YIELD_CELLS;
        await yieldToEventLoop(signal);
      }
    }
  }

  throwIfAborted(signal);
  const ops = [
    ...contextOps(a, 0, prefix, 0),
    ...editScript(midA, midB, dp, prefix),
    ...contextOps(a, a.length - suffix, suffix, b.length - a.length),
  ];
  if (ops.length > DIFF_YIELD_ITEMS) await yieldToEventLoop(signal);

  const hunks: DiffHunk[] = [];
  for (const [start, end] of hunkBounds(ops, context)) {
    hunks.push(hunkFrom(ops, start, end));
    await yieldToEventLoop(signal);
  }

  throwIfAborted(signal);
  return hunks;
}

export function diffStatsFromHunks(hunks: DiffHunk[]): DiffStats {
  let addedLines = 0;
  let removedLines = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') addedLines++;
      if (line.kind === 'del') removedLines++;
    }
  }
  return { addedLines, removedLines };
}

export function renderDiffWithStats(
  oldText: string,
  newText: string,
  context = 3,
): { diff: string; stats: DiffStats } {
  const hunks = lineDiff(oldText, newText, context);
  if (hunks.length === 0) return { diff: '', stats: { addedLines: 0, removedLines: 0 } };
  const out: string[] = [];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart} +${h.newStart} @@`);
    for (const l of h.lines) {
      const prefix = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
      out.push(prefix + l.text);
    }
  }
  return { diff: out.join('\n'), stats: diffStatsFromHunks(hunks) };
}

export async function renderDiffWithStatsAsync(
  oldText: string,
  newText: string,
  context = 3,
  signal?: AbortSignal,
): Promise<{ diff: string; stats: DiffStats }> {
  const hunks = await lineDiffAsync(oldText, newText, context, signal);
  if (hunks.length === 0) return { diff: '', stats: { addedLines: 0, removedLines: 0 } };

  const out: string[] = [];
  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex++) {
    const hunk = hunks[hunkIndex];
    out.push(`@@ -${hunk.oldStart} +${hunk.newStart} @@`);
    for (let lineIndex = 0; lineIndex < hunk.lines.length; lineIndex++) {
      const line = hunk.lines[lineIndex];
      const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
      out.push(prefix + line.text);
      if (lineIndex > 0 && lineIndex % DIFF_YIELD_ITEMS === 0) await yieldToEventLoop(signal);
    }
    if (hunkIndex > 0 && hunkIndex % 64 === 0) await yieldToEventLoop(signal);
  }
  return { diff: out.join('\n'), stats: diffStatsFromHunks(hunks) };
}

/** Render a unified diff string. */
export function renderDiff(oldText: string, newText: string, context = 3): string {
  return renderDiffWithStats(oldText, newText, context).diff;
}
