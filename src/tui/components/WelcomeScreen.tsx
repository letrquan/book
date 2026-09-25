import { Box, Text } from 'ink';
import { basename } from 'path';
import type React from 'react';
import { useStaggeredReveal } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import { CONTENT_COLUMN, transcriptGrid } from '../layout.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';

interface WelcomeScreenProps {
  terminalWidth: number;
  terminalHeight: number;
  workspace?: string;
  model?: string;
  mode?: string;
  commandCount?: number;
  skillCount?: number;
  reducedMotion?: boolean;
  screenReader?: boolean;
  /** When false, the welcome bookplate renders directly in its settled state. */
  animate?: boolean;
}

export interface WelcomeHint {
  /** What the user types. */
  key: string;
  /** What it does. */
  label: string;
}

/** What a first-run user most needs to know, in the order they need it. */
export const WELCOME_HINTS: readonly WelcomeHint[] = [
  { key: '/help', label: 'commands' },
  { key: '@file', label: 'context' },
  { key: '/skills', label: 'workflows' },
  { key: '!cmd', label: 'shell' },
  { key: 'Ctrl+/', label: 'shortcuts' },
];

/** Columns between one hint and the next. */
const HINT_GAP = 4;

const TAGLINE = 'Ask anything, or type / for a command.';

/**
 * A tiny terminal gets the short form. The hint row below already reads
 * `/help commands`, so orientation survives losing the long sentence — and a
 * truncated tagline reads as breakage, not brevity.
 */
const TAGLINE_TINY = 'Ask anything.';

/**
 * Choose the hints that fit the available width, whole.
 *
 * A hint is never partially rendered: the previous screen truncated each
 * segment against its own budget inside a row that also held fixed separators,
 * so a 50-column terminal advertised `/hel commands` — a command that does not
 * exist. Dropping the last hint is always better than inventing one.
 */
export function composeWelcomeHints(hints: readonly WelcomeHint[], width: number): WelcomeHint[] {
  const budget = Math.max(0, Math.floor(width));
  const chosen: WelcomeHint[] = [];
  let used = 0;
  for (const hint of hints) {
    const cost = displayWidth(`${hint.key} ${hint.label}`) + (chosen.length > 0 ? HINT_GAP : 0);
    if (used + cost > budget) break;
    chosen.push(hint);
    used += cost;
  }
  return chosen;
}

function workspaceName(workspace?: string): string {
  if (!workspace) return 'workspace';
  return basename(workspace) || workspace;
}

function WelcomeLine({ visible, children }: { visible: boolean; children: React.ReactNode }) {
  return <Box>{visible ? children : <Text> </Text>}</Box>;
}

function HintRow({ hints }: { hints: WelcomeHint[] }) {
  const theme = useTheme();
  return (
    <Box>
      {hints.map((hint, index) => (
        <Text key={hint.key}>
          {index > 0 ? ' '.repeat(HINT_GAP) : ''}
          <Text color={theme.text}>{hint.key}</Text>
          <Text color={theme.inactive}> {hint.label}</Text>
        </Text>
      ))}
    </Box>
  );
}

/**
 * The title-page logotype: BOOK drawn in half blocks, three rows tall.
 *
 * Each letter is a 4×6 pixel glyph packed two pixels per cell (`▀` top, `▄`
 * bottom, `█` both). Keep the rows the same display width, or the centred
 * block shears.
 */
export const LOGOTYPE = [
  '█▀▀▄ ▄▀▀▄ ▄▀▀▄ █ ▄▀',
  '█▀▀▄ █  █ █  █ █▀▄ ',
  '█▄▄▀ ▀▄▄▀ ▀▄▄▀ █  █',
] as const;

/** Rows the composer and status line take below the transcript. */
const FOOTER_ROWS = 5;

/** Rows the title page itself occupies: logotype, blank, meta, blank, hints. */
const TITLE_PAGE_ROWS = LOGOTYPE.length + 4;

/** Blend two `#rrggbb` colours; `t = 0` is `from`. Undefined for any other form. */
function mixHex(from: string, to: string, t: number): string | undefined {
  const parse = (hex: string) =>
    /^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) : null;
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return undefined;
  return `#${a
    .map((v, i) => Math.round(v + (b[i]! - v) * t))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * The logotype in gold foil: each row steps from the light gilt down to the
 * deep one, the way stamped foil catches the light along its top edge.
 */
function Logotype() {
  const theme = useTheme();
  const last = LOGOTYPE.length - 1;
  return (
    <Box flexDirection="column">
      {LOGOTYPE.map((row, index) => (
        <Text
          key={index}
          color={
            mixHex(theme.brandShimmer, theme.brand, last === 0 ? 1 : index / last) ?? theme.brand
          }
        >
          {row}
        </Text>
      ))}
    </Box>
  );
}

/**
 * Blank rows above the title page.
 *
 * An empty session used to print a small block in the top-left corner above
 * thirty-odd empty rows. The title page sits a little above the optical middle
 * of the space left over, the way a title sits on the page of a book.
 */
export function titlePageTopPadding(terminalHeight: number): number {
  const free = Math.floor(terminalHeight) - FOOTER_ROWS - TITLE_PAGE_ROWS;
  return Math.max(0, Math.floor(free * 0.4));
}

export function WelcomeScreen({
  terminalWidth,
  terminalHeight,
  workspace,
  model = 'model',
  mode = 'default',
  reducedMotion = false,
  screenReader = false,
  animate = true,
}: WelcomeScreenProps) {
  const theme = useTheme();
  const grid = transcriptGrid(terminalWidth);
  const width = grid.width;
  const height = Math.max(8, Math.floor(terminalHeight));
  const compact = width < 64 || height < 18;
  const tiny = width < 42 || height < 12;
  const motionDisabled = reducedMotion || screenReader || !animate;
  const reveal = useStaggeredReveal(tiny ? 2 : compact ? 3 : 4, animate, 110, motionDisabled);
  const tagline = tiny ? TAGLINE_TINY : TAGLINE;
  const contentWidth = grid.content;
  const meta = `${workspaceName(workspace)}  ·  ${model}  ·  ${mode}`;
  const hints = composeWelcomeHints(WELCOME_HINTS, contentWidth);

  if (screenReader) {
    return (
      <Box flexDirection="column" paddingLeft={CONTENT_COLUMN} width={width}>
        <Text bold>BOOK</Text>
        <Text>{truncateDisplay(tagline, contentWidth)}</Text>
        {/* Prose, not the `·`-joined chip row: a screen reader reads a
            sentence far better than a list of separators. */}
        <Text>
          {truncateDisplay(
            `Workspace ${workspaceName(workspace)}. Model ${model}. Mode ${mode}.`,
            contentWidth,
          )}
        </Text>
        <Text>
          {truncateDisplay(
            'Type /help for commands, Ctrl+/ for shortcuts, @file for context, !cmd for shell.',
            contentWidth,
          )}
        </Text>
      </Box>
    );
  }

  if (tiny) {
    return (
      <Box flexDirection="column" width={width}>
        <Box paddingLeft={CONTENT_COLUMN}>
          <Text color={theme.brand} bold>
            BOOK{' '}
          </Text>
          <Text color={theme.text}>{truncateDisplay(tagline, contentWidth - 5)}</Text>
        </Box>
        <WelcomeLine visible={reveal >= 1}>
          <Box paddingLeft={CONTENT_COLUMN}>
            <HintRow hints={composeWelcomeHints(WELCOME_HINTS, contentWidth)} />
          </Box>
        </WelcomeLine>
      </Box>
    );
  }

  if (compact) {
    return (
      <Box flexDirection="column" width={width}>
        <Box paddingLeft={CONTENT_COLUMN}>
          <Text color={theme.brand} bold>
            BOOK{' '}
          </Text>
          <Text color={theme.text}>{truncateDisplay(tagline, contentWidth - 5)}</Text>
        </Box>
        <WelcomeLine visible={reveal >= 1}>
          <Box paddingLeft={CONTENT_COLUMN}>
            <Text color={theme.subtle} dimColor>
              {truncateDisplay(meta, contentWidth)}
            </Text>
          </Box>
        </WelcomeLine>
        <WelcomeLine visible={reveal >= 2}>
          <Box paddingLeft={CONTENT_COLUMN}>
            <HintRow hints={hints} />
          </Box>
        </WelcomeLine>
      </Box>
    );
  }

  // A title page: centred, with the composer below as the first line of text.
  // No tagline — the composer's placeholder already says "Ask me anything".
  return (
    <Box flexDirection="column" width={width - 1} alignItems="center">
      <Box height={titlePageTopPadding(height)} />
      <Logotype />
      <Text> </Text>
      <WelcomeLine visible={reveal >= 1}>
        {/* The mode is left to the status line, which is where it changes. */}
        <Text color={theme.subtle}>
          {truncateDisplay(`${workspaceName(workspace)}  ·  ${model}`, contentWidth)}
        </Text>
      </WelcomeLine>
      <Text> </Text>
      <WelcomeLine visible={reveal >= 2}>
        <HintRow hints={hints} />
      </WelcomeLine>
    </Box>
  );
}
