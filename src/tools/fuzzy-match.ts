/**
 * Whitespace-tolerant fallback matching for Edit and MultiEdit.
 *
 * When an exact oldString match fails, two deterministic relaxations are tried
 * in order, each accepted only when it matches exactly one location in the file:
 *
 *   1. trailing-whitespace — lines compare equal ignoring trailing spaces/tabs;
 *   2. indent-shift — every line is offset by one uniform leading-whitespace
 *      prefix, which is re-applied to the replacement text.
 *
 * Both rungs are line-anchored: oldString must cover whole lines. Similarity
 * scoring and other lossy heuristics are deliberately excluded so a relaxed
 * match can never pick a "close enough" but wrong site. A match whose
 * replacement cannot be shifted consistently is rejected rather than written
 * with mixed indentation.
 */

import { yieldToEventLoop } from '../async.js';

export interface RelaxedMatch {
  /** Character offset of the matched block in the file content. */
  start: number;
  /** Exclusive end offset of the matched block. */
  end: number;
  /** Replacement text with the file's actual indentation applied. */
  replacement: string;
  rung: 'trailing-whitespace' | 'indent-shift';
}

export type RelaxedMatchOutcome =
  | { status: 'found'; match: RelaxedMatch }
  | { status: 'ambiguous'; rung: RelaxedMatch['rung']; count: number }
  | { status: 'not_found' };

interface LineSpan {
  text: string;
  start: number;
  /** Exclusive end offset, not including the trailing newline. */
  end: number;
}

const CANDIDATE_YIELD_INTERVAL = 1024;

function splitLineSpans(content: string): LineSpan[] {
  const spans: LineSpan[] = [];
  let start = 0;
  for (;;) {
    const newline = content.indexOf('\n', start);
    if (newline === -1) {
      spans.push({ text: content.slice(start), start, end: content.length });
      return spans;
    }
    spans.push({ text: content.slice(start, newline), start, end: newline });
    start = newline + 1;
  }
}

function trimTrailing(line: string): string {
  return line.replace(/[ \t]+$/, '');
}

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)![0];
}

type IndentShift =
  | { kind: 'none' }
  | { kind: 'add'; prefix: string }
  | {
      kind: 'remove';
      prefix: string;
    };

function deriveShift(fileLine: string, oldLine: string): IndentShift | null {
  const fileIndent = leadingWhitespace(fileLine);
  const oldIndent = leadingWhitespace(oldLine);
  if (fileIndent === oldIndent) return { kind: 'none' };
  if (fileIndent.startsWith(oldIndent)) {
    return { kind: 'add', prefix: fileIndent.slice(oldIndent.length) };
  }
  if (oldIndent.startsWith(fileIndent)) {
    return { kind: 'remove', prefix: oldIndent.slice(fileIndent.length) };
  }
  return null;
}

function applyShift(line: string, shift: IndentShift): string | null {
  if (trimTrailing(line) === '') return line;
  if (shift.kind === 'none') return line;
  if (shift.kind === 'add') return shift.prefix + line;
  return line.startsWith(shift.prefix) ? line.slice(shift.prefix.length) : null;
}

/** Compare cached trimmed lines; blank old lines match whitespace-only file lines. */
function matchesAt(
  fileTrimmed: string[],
  index: number,
  oldTrimmed: string[],
  shift: IndentShift,
): boolean {
  for (let offset = 0; offset < oldTrimmed.length; offset++) {
    const fileLine = fileTrimmed[index + offset];
    const oldLine = oldTrimmed[offset];
    if (oldLine === '') {
      if (fileLine !== '') return false;
      continue;
    }
    const shifted = applyShift(oldLine, shift);
    if (shifted === null || fileLine !== shifted) return false;
  }
  return true;
}

function firstContentLineIndex(lines: string[]): number {
  const index = lines.findIndex((line) => trimTrailing(line) !== '');
  return index === -1 ? 0 : index;
}

/**
 * Re-apply the matched shift to the replacement text. Returns null when any
 * non-blank line cannot take the shift (e.g. a remove-prefix the line lacks):
 * writing a partially-shifted block would produce mixed indentation.
 */
function shiftReplacement(newString: string, shift: IndentShift): string | null {
  if (shift.kind === 'none') return newString;
  const shifted = newString.split('\n').map((line) => applyShift(line, shift));
  if (shifted.some((line) => line === null)) return null;
  return shifted.join('\n');
}

/**
 * Find where oldString matches the content under progressive whitespace
 * relaxation. Only called after an exact search found zero occurrences.
 * Yields to the event loop periodically and honors the abort signal, matching
 * the conventions of the other long-running scans in file.ts.
 */
export async function findRelaxedMatch(
  content: string,
  oldString: string,
  newString: string,
  signal?: AbortSignal,
): Promise<RelaxedMatchOutcome> {
  const oldLines = oldString.split('\n');
  if (oldLines.every((line) => trimTrailing(line) === '')) return { status: 'not_found' };
  const fileLines = splitLineSpans(content);
  const fileTrimmed = fileLines.map((span) => trimTrailing(span.text));
  const oldTrimmed = oldLines.map(trimTrailing);
  const anchorOffset = firstContentLineIndex(oldLines);
  const lastStart = fileLines.length - oldLines.length;

  const rungs: Array<{
    rung: RelaxedMatch['rung'];
    shiftFor: (candidateIndex: number) => IndentShift | null;
  }> = [
    { rung: 'trailing-whitespace', shiftFor: () => ({ kind: 'none' }) },
    {
      rung: 'indent-shift',
      shiftFor: (candidateIndex) =>
        deriveShift(fileLines[candidateIndex + anchorOffset].text, oldLines[anchorOffset]),
    },
  ];

  for (const { rung, shiftFor } of rungs) {
    const matches: Array<{ index: number; shift: IndentShift }> = [];
    for (let index = 0; index <= lastStart; index++) {
      if (index > 0 && index % CANDIDATE_YIELD_INTERVAL === 0) await yieldToEventLoop(signal);
      const shift = shiftFor(index);
      if (shift === null) continue;
      if (matchesAt(fileTrimmed, index, oldTrimmed, shift)) matches.push({ index, shift });
    }
    if (matches.length === 1) {
      const { index, shift } = matches[0];
      const replacement = shiftReplacement(newString, shift);
      if (replacement === null) return { status: 'not_found' };
      return {
        status: 'found',
        match: {
          start: fileLines[index].start,
          end: fileLines[index + oldLines.length - 1].end,
          replacement,
          rung,
        },
      };
    }
    if (matches.length > 1) return { status: 'ambiguous', rung, count: matches.length };
  }
  return { status: 'not_found' };
}
