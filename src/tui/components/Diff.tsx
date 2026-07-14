import { Text, Box } from 'ink';
import { useTheme } from '../theme.js';
import { prepareToolOutputDisplay } from './tool-output.js';
import { truncateDisplay } from './word-wrap.js';

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

/**
 * Parse a unified diff string into structured segments for color rendering.
 * Handles:
 *   @@ -old,count +new,count @@  → hunk header (subtle)
 *   +added line                    → diffAdded color
 *   -removed line                  → diffRemoved color
 *   context line                   → normal text color
 *
 * For word-level highlights (CC-style inline diffs), lines starting with
 * + or - that contain sub-parts surrounded by `{+...+}` or `{-...-}`
 * are split into staggered colored spans using diffAddedWord/diffRemovedWord.
 */
function parseDiffLines(output: string): Array<{
  text: string;
  /** Theme token: 'diffAdded' | 'diffRemoved' | 'diffAddedWord' | 'diffRemovedWord' | 'diffHunk' | 'diffCtx' | 'diffAddedDimmed' | 'diffRemovedDimmed' */
  kind:
    | 'diffAdded'
    | 'diffRemoved'
    | 'diffAddedWord'
    | 'diffRemovedWord'
    | 'diffHunk'
    | 'diffCtx'
    | 'diffAddedDimmed'
    | 'diffRemovedDimmed';
}> {
  const lines = output.split('\n');
  const result: ReturnType<typeof parseDiffLines> = [];

  for (const line of lines) {
    if (line === '' && output.length === 0) continue; // skip empty result for truly empty input
    if (line.startsWith('@@')) {
      result.push({ text: line, kind: 'diffHunk' });
    } else if (line.startsWith('+')) {
      // Check for CC-style word-level highlights: {+added+} within the line.
      const stripped = line.slice(1);
      const wordTokens = parseWordLevelDiff(stripped, 'add');
      if (wordTokens) {
        for (const wt of wordTokens) {
          result.push({
            text: wt.text,
            kind: wt.kind,
          });
        }
      } else {
        result.push({ text: line, kind: 'diffAdded' });
      }
    } else if (line.startsWith('-')) {
      const stripped = line.slice(1);
      const wordTokens = parseWordLevelDiff(stripped, 'del');
      if (wordTokens) {
        for (const wt of wordTokens) {
          result.push({
            text: wt.text,
            kind: wt.kind,
          });
        }
      } else {
        result.push({ text: line, kind: 'diffRemoved' });
      }
    } else {
      result.push({ text: line, kind: 'diffCtx' });
    }
  }

  return result;
}

/**
 * Parse lines with CC-style inline word diffs:
 *   {+added+}  → diffAddedWord
 *   {-removed-} → diffRemovedWord
 *
 * Returns null if no word-level tokens found.
 */
function parseWordLevelDiff(
  line: string,
  mode: 'add' | 'del',
): Array<{
  text: string;
  kind: 'diffAdded' | 'diffRemoved' | 'diffAddedWord' | 'diffRemovedWord';
}> | null {
  // Check for CC-style markers: {+...+} or {-...-}
  const addedRe = /\{\+(.+?)\+\}/g;
  const removedRe = /\{\-(.+?)\-\}/g;

  const tokens: Array<{
    text: string;
    kind: 'diffAdded' | 'diffRemoved' | 'diffAddedWord' | 'diffRemovedWord';
  }> = [];
  let remaining = line;
  let lastIdx = 0;

  // Combined regex that matches both.
  const combined = /\{(\+|\-)(.+?)\1\}/gs;
  let match: RegExpExecArray | null;
  let hasWordDiff = false;

  while ((match = combined.exec(line)) !== null) {
    hasWordDiff = true;
    // Text before this match is plain.
    const before = line.slice(lastIdx, match.index);
    if (before) {
      tokens.push({ text: before, kind: mode === 'add' ? 'diffAdded' : 'diffRemoved' });
    }
    // The word-diff region.
    const wordKind = match[1] === '+' ? 'diffAddedWord' : 'diffRemovedWord';
    tokens.push({ text: match[2], kind: wordKind });
    lastIdx = combined.lastIndex;
  }

  if (!hasWordDiff) return null;

  // Trailing text.
  const after = line.slice(lastIdx);
  if (after) {
    tokens.push({ text: after, kind: mode === 'add' ? 'diffAdded' : 'diffRemoved' });
  }

  return tokens;
}

/** Theme token → color keys for lookups. */
const DIFF_COLOR_MAP: Record<string, keyof ReturnType<typeof useTheme>> = {
  diffAdded: 'diffAdded',
  diffRemoved: 'diffRemoved',
  diffAddedWord: 'diffAddedWord',
  diffRemovedWord: 'diffRemovedWord',
  diffHunk: 'brand',
  diffCtx: 'subtle',
  diffAddedDimmed: 'diffAddedDimmed',
  diffRemovedDimmed: 'diffRemovedDimmed',
};

export function DiffBlock({
  output,
  maxLines = 200,
  collapsed = false,
  terminalWidth = 120,
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
      {display.map((segment, i) => {
        const colorKey = DIFF_COLOR_MAP[segment.kind] ?? 'subtle';
        const color = theme[colorKey] as string;
        const isDimmed = segment.kind === 'diffAddedDimmed' || segment.kind === 'diffRemovedDimmed';

        return (
          <Box key={i} marginLeft={2}>
            <Text
              color={color}
              dimColor={isDimmed}
              bold={segment.kind === 'diffAddedWord' || segment.kind === 'diffRemovedWord'}
            >
              {'│'} {truncateDisplay(segment.text, lineWidth)}
            </Text>
          </Box>
        );
      })}
      {outputDisplay.footer && (
        <Box marginLeft={2}>
          <Text color={theme.subtle} dimColor>
            {'│'} {truncateDisplay(outputDisplay.footer, lineWidth)}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export { parseDiffLines };
