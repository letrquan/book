import { Text, Box } from 'ink';
import { useTheme } from '../theme.js';
import { prepareToolOutputDisplay } from './tool-output.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';

interface DiffProps {
  /** Raw unified diff output string (lines starting with @@, +, -, or space). */
  output: string;
  /** Max lines to render when fully expanded. */
  maxLines?: number;
  /** When true, render a short preview with a hidden-output summary. */
  collapsed?: boolean;
  /** Available width, including this component's indentation and line prefix. */
  terminalWidth?: number;
}

export function isUnifiedDiffLike(output: string): boolean {
  const hasHunk = /^@@\s+-\d+.*\+\d+.*@@/m.test(output);
  const hasChangedLine = /^(\+[^+]|-[^-])/m.test(output);
  return hasHunk && hasChangedLine;
}

type DiffLineKind = 'add' | 'del' | 'hunk' | 'ctx';
type DiffSpanKind = 'plain' | 'addedWord' | 'removedWord';

export interface ParsedDiffLine {
  text: string;
  kind: DiffLineKind;
  spans?: Array<{ text: string; kind: DiffSpanKind }>;
}

/**
 * Parse one diff source line into one visual row. Word-level markers become
 * inline spans instead of separate rows, preserving the original line count.
 */
function parseWordLevelDiff(line: string): Array<{ text: string; kind: DiffSpanKind }> | undefined {
  const spans: Array<{ text: string; kind: DiffSpanKind }> = [];
  const combined = /\{(\+|\-)(.+?)\1\}/gs;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = combined.exec(line)) !== null) {
    const before = line.slice(lastIndex, match.index);
    if (before) spans.push({ text: before, kind: 'plain' });
    spans.push({
      text: match[2],
      kind: match[1] === '+' ? 'addedWord' : 'removedWord',
    });
    lastIndex = combined.lastIndex;
  }

  if (spans.length === 0) return undefined;
  const after = line.slice(lastIndex);
  if (after) spans.push({ text: after, kind: 'plain' });
  return spans;
}

export function parseDiffLines(output: string): ParsedDiffLine[] {
  if (output.length === 0) return [];

  return output.split('\n').map((line) => {
    if (line.startsWith('@@')) return { text: line, kind: 'hunk' };
    if (line.startsWith('+')) {
      return { text: line, kind: 'add', spans: parseWordLevelDiff(line) };
    }
    if (line.startsWith('-')) {
      return { text: line, kind: 'del', spans: parseWordLevelDiff(line) };
    }
    return { text: line, kind: 'ctx' };
  });
}

function truncateSpans(
  spans: NonNullable<ParsedDiffLine['spans']>,
  width: number,
): NonNullable<ParsedDiffLine['spans']> {
  const limit = Math.max(0, Math.floor(width));
  if (limit === 0) return [];

  const output: NonNullable<ParsedDiffLine['spans']> = [];
  let remaining = limit;
  for (const span of spans) {
    if (remaining <= 0) break;
    const spanWidth = displayWidth(span.text);
    if (spanWidth <= remaining) {
      output.push(span);
      remaining -= spanWidth;
      continue;
    }
    output.push({ ...span, text: truncateDisplay(span.text, remaining) });
    remaining = 0;
  }
  return output;
}

export function DiffBlock({
  output,
  maxLines = 200,
  collapsed = false,
  terminalWidth = 80,
}: DiffProps) {
  const theme = useTheme();
  const parsed = parseDiffLines(output);
  const displayLimit = collapsed ? 5 : maxLines;
  const display = displayLimit > 0 ? parsed.slice(0, displayLimit) : parsed;
  // Two-column margin plus the `│ ` prefix live inside the supplied budget.
  const lineWidth = Math.max(8, Math.floor(terminalWidth) - 4);
  const outputDisplay = prepareToolOutputDisplay(output, {
    maxLines: displayLimit,
    maxLineWidth: lineWidth,
    hint: collapsed ? 'Ctrl+E shows all' : undefined,
  });

  return (
    <Box flexDirection="column">
      {display.map((line, index) => {
        const backgroundColor =
          line.kind === 'add'
            ? theme.diffAdded
            : line.kind === 'del'
              ? theme.diffRemoved
              : undefined;
        const foregroundColor = line.kind === 'hunk' ? theme.brand : theme.text;
        const clippedText = truncateDisplay(line.text, lineWidth);
        const clippedSpans = line.spans ? truncateSpans(line.spans, lineWidth) : undefined;
        const contentWidth = clippedSpans
          ? clippedSpans.reduce((total, span) => total + displayWidth(span.text), 0)
          : displayWidth(clippedText);
        const padding = backgroundColor ? ' '.repeat(Math.max(0, lineWidth - contentWidth)) : '';

        return (
          <Box key={index} marginLeft={2}>
            <Text color={theme.subtle}>│ </Text>
            {clippedSpans ? (
              <Text backgroundColor={backgroundColor} color={foregroundColor}>
                {clippedSpans.map((span, spanIndex) => (
                  <Text
                    key={spanIndex}
                    backgroundColor={
                      span.kind === 'addedWord'
                        ? theme.diffAddedWord
                        : span.kind === 'removedWord'
                          ? theme.diffRemovedWord
                          : backgroundColor
                    }
                    color={foregroundColor}
                    bold={span.kind !== 'plain'}
                  >
                    {span.text}
                  </Text>
                ))}
                {padding}
              </Text>
            ) : (
              <Text backgroundColor={backgroundColor} color={foregroundColor}>
                {clippedText}
                {padding}
              </Text>
            )}
          </Box>
        );
      })}
      {outputDisplay.footer ? (
        <Box marginLeft={2}>
          <Text color={theme.subtle} dimColor>
            │ {truncateDisplay(outputDisplay.footer, lineWidth)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
