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

const DIFF_YIELD_CELLS = 32_768;
const DIFF_YIELD_ITEMS = 1_024;

/** Compute a line-level diff between two strings. Returns hunks with context. */
export function lineDiff(oldText: string, newText: string, context = 3): DiffHunk[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  // LCS-based edit script. O(n*m) — fine for typical file sizes in a CLI tool.
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: Array<{ kind: 'ctx' | 'add' | 'del'; text: string; ai: number; bi: number }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'ctx', text: a[i], ai: i, bi: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'del', text: a[i], ai: i, bi: j });
      i++;
    } else {
      ops.push({ kind: 'add', text: b[j], ai: i, bi: j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: 'del', text: a[i], ai: i, bi: j });
    i++;
  }
  while (j < m) {
    ops.push({ kind: 'add', text: b[j], ai: i, bi: j });
    j++;
  }

  // Group consecutive non-context ops into hunks, padded by `context` ctx lines.
  const hunks: DiffHunk[] = [];
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
    const hunkStart = s + 1;
    // Walk forward through all consecutive non-context ops, then context after.
    let e = start;
    while (e < ops.length && ops[e].kind !== 'ctx') e++;
    let ctxAfter = 0;
    while (e < ops.length && ops[e].kind === 'ctx' && ctxAfter < context) {
      e++;
      ctxAfter++;
    }
    const hunkOps = ops.slice(hunkStart, e);
    const oldStart = (hunkOps[0]?.ai ?? 0) + 1;
    const newStart = (hunkOps[0]?.bi ?? 0) + 1;
    hunks.push({
      oldStart,
      newStart,
      lines: hunkOps.map((o) => ({ kind: o.kind, text: o.text })),
    });
    k = e;
  }

  return hunks;
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
  const n = a.length;
  const m = b.length;
  const dp: number[][] = [];

  for (let row = 0; row <= n; row++) {
    dp.push(new Array(m + 1).fill(0));
    if (row > 0 && row % 128 === 0) await yieldToEventLoop(signal);
  }

  let cellsUntilYield = DIFF_YIELD_CELLS;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      cellsUntilYield--;
      if (cellsUntilYield === 0) {
        cellsUntilYield = DIFF_YIELD_CELLS;
        await yieldToEventLoop(signal);
      }
    }
  }

  throwIfAborted(signal);
  const ops: Array<{ kind: 'ctx' | 'add' | 'del'; text: string; ai: number; bi: number }> = [];
  let i = 0;
  let j = 0;
  let itemsUntilYield = DIFF_YIELD_ITEMS;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'ctx', text: a[i], ai: i, bi: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'del', text: a[i], ai: i, bi: j });
      i++;
    } else {
      ops.push({ kind: 'add', text: b[j], ai: i, bi: j });
      j++;
    }
    itemsUntilYield--;
    if (itemsUntilYield === 0) {
      itemsUntilYield = DIFF_YIELD_ITEMS;
      await yieldToEventLoop(signal);
    }
  }
  while (i < n) {
    ops.push({ kind: 'del', text: a[i], ai: i, bi: j });
    i++;
    if (i % DIFF_YIELD_ITEMS === 0) await yieldToEventLoop(signal);
  }
  while (j < m) {
    ops.push({ kind: 'add', text: b[j], ai: i, bi: j });
    j++;
    if (j % DIFF_YIELD_ITEMS === 0) await yieldToEventLoop(signal);
  }

  const hunks: DiffHunk[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].kind === 'ctx') {
      k++;
      if (k % DIFF_YIELD_ITEMS === 0) await yieldToEventLoop(signal);
      continue;
    }
    const start = k;
    let ctxBefore = 0;
    let s = start - 1;
    while (s >= 0 && ops[s].kind === 'ctx' && ctxBefore < context) {
      s--;
      ctxBefore++;
    }
    const hunkStart = s + 1;
    let e = start;
    while (e < ops.length && ops[e].kind !== 'ctx') e++;
    let ctxAfter = 0;
    while (e < ops.length && ops[e].kind === 'ctx' && ctxAfter < context) {
      e++;
      ctxAfter++;
    }
    const hunkOps = ops.slice(hunkStart, e);
    const oldStart = (hunkOps[0]?.ai ?? 0) + 1;
    const newStart = (hunkOps[0]?.bi ?? 0) + 1;
    hunks.push({
      oldStart,
      newStart,
      lines: hunkOps.map((o) => ({ kind: o.kind, text: o.text })),
    });
    k = e;
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
