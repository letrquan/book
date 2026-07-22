import { Text, Box } from 'ink';
import { Fragment, useMemo } from 'react';
import { useTheme } from '../theme.js';
import { displayWidth, hardWrapLine, padDisplay, truncateDisplay } from './word-wrap.js';
import { highlightCode, type StyledSegment } from './syntax-highlight.js';

interface DiffProps {
  output: string;
  filePath?: string;
  /** When true, render a change-focused preview across all hunks. */
  collapsed?: boolean;
  terminalWidth?: number;
}

const COLLAPSED_ROWS = 80;
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
  /** Original source row, retained for exact byte accounting and compatibility. */
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
  const rows = output.split('\n').map((text): ParsedDiffLine => {
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

function expandTabs(value: string, tabSize = 4): string {
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

function rowByteSize(row: ParsedDiffLine, index: number, total: number): number {
  return Buffer.byteLength(`${row.text}${index < total - 1 ? '\n' : ''}`, 'utf8');
}

function selectPreviewIndices(rows: readonly ParsedDiffLine[], limit: number): number[] {
  if (rows.length <= limit) return rows.map((_, index) => index);
  const changedIndices = rows
    .map((row, index) => (row.kind === 'add' || row.kind === 'del' ? index : -1))
    .filter((index) => index >= 0);
  if (changedIndices.length === 0) return Array.from({ length: limit }, (_, index) => index);

  const hunkHeaders = rows
    .map((row, index) => (row.kind === 'hunk' ? index : -1))
    .filter((index) => index >= 0);
  const priority = new Set([...hunkHeaders, ...changedIndices]);

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

  const priorityIndices = [...priority].sort((a, b) => a - b);
  if (priorityIndices.length >= limit) {
    const headCount = Math.ceil(limit / 2);
    return [...priorityIndices.slice(0, headCount), ...priorityIndices.slice(-(limit - headCount))];
  }

  const contextIndices = [...contextCandidates.entries()]
    .sort(([leftIndex, leftDistance], [rightIndex, rightDistance]) =>
      leftDistance === rightDistance ? leftIndex - rightIndex : leftDistance - rightDistance,
    )
    .slice(0, limit - priorityIndices.length)
    .map(([index]) => index);

  return [...priorityIndices, ...contextIndices].sort((a, b) => a - b);
}

interface SelectedDiffRow {
  row: ParsedDiffLine;
  sourceIndex: number;
}

function selectRenderedRows(
  rows: readonly ParsedDiffLine[],
  collapsed: boolean,
): { rows: SelectedDiffRow[]; hiddenRows: number; hiddenBytes: number } {
  const rowBytes = rows.map((row, index) => rowByteSize(row, index, rows.length));
  const indices = collapsed
    ? selectPreviewIndices(rows, COLLAPSED_ROWS)
    : rows.map((_, index) => index);
  const selected = new Set(indices);
  const hiddenBytes = rowBytes.reduce(
    (total, bytes, index) => total + (selected.has(index) ? 0 : bytes),
    0,
  );
  return {
    rows: indices.map((sourceIndex) => ({ row: rows[sourceIndex], sourceIndex })),
    hiddenRows: rows.length - indices.length,
    hiddenBytes,
  };
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

export function DiffBlock({ output, filePath, collapsed = false, terminalWidth = 80 }: DiffProps) {
  const theme = useTheme();
  const parsed = useMemo(() => parseDiffLines(output), [output]);
  const selected = useMemo(() => selectRenderedRows(parsed, collapsed), [collapsed, parsed]);
  const language = inferDiffLanguage(filePath);
  const maxOld = Math.max(1, ...parsed.map((row) => row.oldLineNumber ?? 0));
  const maxNew = Math.max(1, ...parsed.map((row) => row.newLineNumber ?? 0));
  const narrow = terminalWidth < 36;
  const oldWidth = Math.max(1, Math.min(String(maxOld).length, narrow ? 3 : 6));
  const newWidth = Math.max(1, Math.min(String(maxNew).length, narrow ? 3 : 6));
  // marginLeft(2) + `│` + gutters + marker remain visible before wrapped content.
  const fixedWidth = 2 + 1 + oldWidth + 1 + newWidth + 1 + 2;
  const contentWidth = Math.max(1, Math.floor(terminalWidth) - fixedWidth);

  return (
    <Box flexDirection="column">
      {selected.rows.map(({ row, sourceIndex }, index) => {
        const previousSourceIndex = selected.rows[index - 1]?.sourceIndex;
        const gapRows =
          previousSourceIndex === undefined ? sourceIndex : sourceIndex - previousSourceIndex - 1;
        const backgroundColor =
          row.kind === 'add' ? theme.diffAdded : row.kind === 'del' ? theme.diffRemoved : undefined;
        const foregroundColor = row.kind === 'hunk' ? theme.brand : theme.text;
        const rawContent = expandTabs(row.content);
        const wrappedSpans = row.spans ? wrapSpans(row.spans, contentWidth) : undefined;
        const wrappedContent = wrappedSpans
          ? wrappedSpans.map((spans) => spans.map((span) => span.text).join(''))
          : hardWrapLine(rawContent, contentWidth);

        return (
          <Fragment key={`${sourceIndex}-${row.text}`}>
            {gapRows > 0 ? (
              <Box marginLeft={2}>
                <Text color={theme.subtle} dimColor>
                  │{' '}
                  {truncateDisplay(
                    `⋮ ${gapRows} ${gapRows === 1 ? 'row' : 'rows'} omitted`,
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
                  <Text color={theme.subtle}>│</Text>
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
                    {continuation ? ' ' : row.marker}{' '}
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
      {selected.hiddenRows > 0 || selected.hiddenBytes > 0 ? (
        <Box marginLeft={2}>
          <Text color={theme.subtle} dimColor>
            │{' '}
            {truncateDisplay(
              `… ${selected.hiddenRows} ${selected.hiddenRows === 1 ? 'row' : 'rows'} and ${selected.hiddenBytes} B omitted${collapsed ? '; Ctrl+E shows all' : ''}`,
              Math.max(4, terminalWidth - 4),
            )}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
