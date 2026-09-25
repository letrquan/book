import { Box, Text } from 'ink';
import { basename } from 'path';
import type React from 'react';
import { useStaggeredReveal } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import { CONTENT_COLUMN, transcriptGrid } from '../layout.js';
import { useTranscriptViewport } from '../transcript-layout.js';
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
 * The drop cap an empty session opens on.
 *
 * A B four rows tall, drawn in half blocks (a 5×8 pixel glyph, two pixels per
 * cell: `▀` top, `▄` bottom, `█` both) and set in rubric, the way an
 * illuminated manuscript opens its first chapter. Three rows were not enough:
 * with a 4×6 glyph the bowls shrank to single cells and the B read as an E. The
 * rest of the word and the session's details are set beside it, left-aligned on
 * the transcript grid: the page begins where the conversation will. Keep the
 * rows the same width, or the text beside the cap shears.
 */
export const DROP_CAP = ['█▀▀▀▄', '█▄▄▄▀', '█   █', '█▄▄▄▀'] as const;

/** Columns between the drop cap and the text set beside it. */
const DROP_CAP_GAP = 2;

/** Rows the opening occupies: one row of top margin, then the drop cap. */
const OPENING_ROWS = DROP_CAP.length + 1;

/**
 * Rows the composer and status line take below the transcript: the estimate
 * used until the transcript viewport has been measured.
 */
export const WELCOME_FOOTER_ROWS = 5;

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
  const viewport = useTranscriptViewport();
  const grid = transcriptGrid(terminalWidth);
  const width = grid.width;
  const height = Math.max(8, Math.floor(terminalHeight));
  // The rows the transcript can actually show. An open menu takes ten rows from
  // it, and a title page padded for the closed footer would overflow and be cut
  // through the middle of the logotype. Until the viewport is measured (it
  // starts at one row), estimate from the terminal height.
  const availableRows =
    viewport && viewport.viewportRows > 1 ? viewport.viewportRows : height - WELCOME_FOOTER_ROWS;
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
        <Text bold>Book</Text>
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
          {/* The drop cap in miniature: a rubricated B, then the word in ink. */}
          <Text color={theme.brand} bold>
            B
          </Text>
          <Text color={theme.text} bold>
            ook{' '}
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
          {/* The drop cap in miniature: a rubricated B, then the word in ink. */}
          <Text color={theme.brand} bold>
            B
          </Text>
          <Text color={theme.text} bold>
            ook{' '}
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

  // Too short for the drop cap (a menu is open): draw nothing rather than a cap
  // cut through the middle.
  if (availableRows < DROP_CAP.length) return <Box />;

  const besideWidth = Math.max(8, contentWidth - displayWidth(DROP_CAP[0]) - DROP_CAP_GAP);
  const beside = [
    <Text key="word" color={theme.text} bold>
      ook
    </Text>,
    // Air between the word and the details, so the block beside the cap spans
    // its full height and the hints sit on its last row.
    null,
    <WelcomeLine key="meta" visible={reveal >= 1}>
      {/* The mode is left to the status line, which is where it changes. */}
      <Text color={theme.subtle}>
        {truncateDisplay(`${workspaceName(workspace)}  ·  ${model}`, besideWidth)}
      </Text>
    </WelcomeLine>,
    <WelcomeLine key="hints" visible={reveal >= 2}>
      <HintRow hints={composeWelcomeHints(WELCOME_HINTS, besideWidth)} />
    </WelcomeLine>,
  ];
  // No tagline: the composer's placeholder already says "Ask me anything".
  return (
    <Box flexDirection="column" width={width - 1} paddingLeft={CONTENT_COLUMN}>
      {availableRows >= OPENING_ROWS ? <Text> </Text> : null}
      {DROP_CAP.map((row, index) => (
        <Box key={index}>
          <Text color={theme.brand}>{row}</Text>
          <Text>{' '.repeat(DROP_CAP_GAP)}</Text>
          {beside[index]}
        </Box>
      ))}
    </Box>
  );
}
