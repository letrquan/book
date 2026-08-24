import { Box, Text } from 'ink';
import { basename } from 'path';
import type React from 'react';
import { useStaggeredReveal } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import { CONTENT_COLUMN, transcriptGrid } from '../layout.js';
import { Bookplate } from './Bookplate.js';
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
          <Text color={theme.brand}>{hint.key}</Text>
          <Text color={theme.subtle}> {hint.label}</Text>
        </Text>
      ))}
    </Box>
  );
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
  const meta = `${workspaceName(workspace)} · ${model} · ${mode}`;
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
          <Text color={theme.assistantAccent} bold>
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
          <Text color={theme.assistantAccent} bold>
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

  return (
    <Box flexDirection="column" width={width}>
      {/* The plate's ╭ / ╰ glyphs are the gutter, so the mark and the tagline
          already land on the transcript's content column. */}
      <Bookplate tagline={tagline} width={contentWidth} />
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
