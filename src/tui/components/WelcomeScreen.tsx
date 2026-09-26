import { Box, Text } from 'ink';
import { basename } from 'path';
import { useLayoutEffect } from 'react';
import type React from 'react';
import { useStaggeredReveal } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import { CONTENT_COLUMN, transcriptGrid } from '../layout.js';
import { useTranscriptLayoutChange, useTranscriptViewport } from '../transcript-layout.js';
import { PILCROW } from '../marks.js';
import { formatAge } from '../relative-age.js';
import { romanNumeral } from '../roman.js';
import { displaySessionName } from '../../session/name.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';

/** A past session of this workspace, listed on the title page as a chapter. */
export interface RecentChapter {
  id: string;
  name?: string;
  updatedAt: number;
  messageCount: number;
}

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
  /** When false, the welcome renders directly in its settled state. */
  animate?: boolean;
  /** This workspace's recent sessions, newest first; the title page's contents. */
  recentSessions?: readonly RecentChapter[];
  /**
   * The sessions are still being listed. The page then leaves its contents
   * out, instead of showing the getting-started list a returning reader would
   * see flip to their chapters a moment later.
   */
  contentsPending?: boolean;
  /** The clock the chapter ages are measured against. Tests pin it. */
  now?: number;
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

/** The index row under a title page that lists past chapters. */
const CHAPTER_HINTS: readonly WelcomeHint[] = [
  { key: '/resume', label: 'open a chapter' },
  { key: '/help', label: 'commands' },
  { key: '@file', label: 'context' },
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

function HintRow({ hints }: { hints: readonly WelcomeHint[] }) {
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
 * The drop cap the title page opens on.
 *
 * A B five rows tall, drawn in half blocks (an 8×10 pixel glyph, two pixels per
 * cell: `▀` top, `▄` bottom, `█` both) and set in rubric, the way an
 * illuminated manuscript opens its first chapter. The stem is two pixels wide
 * and the lower bowl a column wider than the upper, as a printed B is; a
 * narrower draft pinched the waist so deep it read as an E. The rest of the
 * word, the rule and the contents are set beside and below it on the
 * transcript grid. Keep the rows the same width, or the text beside the cap
 * shears.
 */
export const DROP_CAP = ['██▀▀▀█▄ ', '██  ▄█▀ ', '██▀▀▀▄▄ ', '██    ██', '██▄▄▄█▀ '] as const;

/** Columns between the drop cap and the text set beside it. */
const DROP_CAP_GAP = 3;

/**
 * Widest the title page is set, however wide the terminal. The transcript
 * takes the whole width; a page of contents with dot leaders running across
 * two hundred columns reads as a ruler, not a page.
 */
const PAGE_MEASURE = 96;

/** Columns the chapter numeral takes: `iii.` and a space of air. */
const NUMERAL_WIDTH = 6;

/** Fewest leader columns an entry keeps between its title and its page. */
const LEADER_MIN = 5;

/** Most chapters the contents list. */
export const CONTENTS_MAX = 5;

/**
 * What the contents list before a first session: the things a new reader
 * needs, set as a table of contents with the key to press where the page
 * number would be.
 */
const FIRST_RUN_CONTENTS: ReadonlyArray<{ title: string; page: string }> = [
  { title: 'Ask for a change in your own words', page: PILCROW },
  { title: 'Point at a file', page: '@path' },
  { title: 'Run a shell command', page: '!cmd' },
  { title: 'Use a skill', page: '/skills' },
  { title: 'See every command', page: '/help' },
  { title: 'Keyboard shortcuts', page: 'Ctrl+/' },
];

/**
 * Rows the composer and status line take below the transcript: the estimate
 * used until the transcript viewport has been measured.
 */
export const WELCOME_FOOTER_ROWS = 5;

/**
 * A dot leader, as a printed table of contents sets one.
 *
 * Periods, not `·`: a leader repeats its glyph dozens of times, and `·` is
 * ambiguous-width, so a terminal that draws it two cells wide would wrap the
 * row. The dots sit on even absolute columns, so the leaders of every entry
 * line up down the page, and a space of air is kept at each end.
 */
export function dotLeader(startColumn: number, width: number): string {
  const size = Math.max(0, Math.floor(width));
  if (size < 3) return ' '.repeat(size);
  let leader = ' ';
  for (let offset = 1; offset < size - 1; offset++) {
    leader += (startColumn + offset) % 2 === 0 ? '.' : ' ';
  }
  return `${leader} `;
}

interface ContentsEntry {
  numeral: string;
  title: string;
  page: string;
  /** Keys read as ink; ages read as a quiet margin figure. */
  pageTone: 'key' | 'age';
}

function contentsEntries(
  recentSessions: readonly RecentChapter[],
  now: number,
): { entries: ContentsEntry[]; chapters: boolean } {
  if (recentSessions.length > 0) {
    return {
      chapters: true,
      entries: recentSessions.slice(0, CONTENTS_MAX).map((session, index) => ({
        numeral: `${romanNumeral(index + 1)}.`,
        title: displaySessionName(session.name),
        page: formatAge(session.updatedAt, now),
        pageTone: 'age',
      })),
    };
  }
  return {
    chapters: false,
    entries: FIRST_RUN_CONTENTS.map((entry, index) => ({
      numeral: `${romanNumeral(index + 1)}.`,
      title: entry.title,
      page: entry.page,
      pageTone: 'key',
    })),
  };
}

/**
 * How much of the title page fits in `availableRows`: all of it, or the drop
 * cap block alone. An open menu takes ten rows from the transcript; a page
 * that shed entries one at a time left a CONTENTS heading over nothing, so it
 * is the whole page or the cap. It never draws part of the cap. One row is kept
 * as slack, since the measured viewport can run a row past what shows.
 */
export function fitTitlePage(
  availableRows: number,
  entryCount: number,
  hasIndex: boolean,
): { topPadding: number; entries: number; index: boolean; show: boolean } {
  const rows = Math.floor(availableRows) - 1;
  const capRows = DROP_CAP.length;
  const full = capRows + entryCount + (hasIndex ? 2 : 0);
  if (rows >= full) {
    return {
      topPadding: Math.floor((rows - full) * 0.35),
      entries: entryCount,
      index: hasIndex,
      show: true,
    };
  }
  if (rows >= capRows) return { topPadding: 0, entries: 0, index: false, show: true };
  return { topPadding: 0, entries: 0, index: false, show: false };
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
  recentSessions = [],
  contentsPending = false,
  now = Date.now(),
}: WelcomeScreenProps) {
  const theme = useTheme();
  const viewport = useTranscriptViewport();
  const grid = transcriptGrid(terminalWidth);
  const width = grid.width;
  const height = Math.max(8, Math.floor(terminalHeight));
  // The rows the transcript can actually show. An open menu takes ten rows from
  // it, and a title page padded for the closed footer would overflow and be cut
  // through the middle of the drop cap. Until the viewport is measured (it
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
    const recent = recentSessions.slice(0, CONTENTS_MAX);
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
        {recent.length > 0 ? (
          <Text>
            {`Recent sessions: ${recent
              .map(
                (session) =>
                  `${displaySessionName(session.name)}, ${formatAge(session.updatedAt, now)}`,
              )
              .join('; ')}. Type /resume to open one.`}
          </Text>
        ) : null}
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

  return (
    <TitlePage
      width={width}
      pageWidth={Math.min(contentWidth, PAGE_MEASURE)}
      availableRows={availableRows}
      workspace={workspace}
      model={model}
      recentSessions={recentSessions}
      contentsPending={contentsPending}
      now={now}
    />
  );
}

/**
 * The title page an empty session opens on, set like the first page of a book.
 *
 *   ██▀▀▀█▄   O O K                                       book · space-bunny-alpha
 *   ██  ▄█▀   ─────────────────────────────────────────────────────────────────────
 *   ██▀▀█▄    Pick up a chapter with /resume, or begin a new one below.
 *   ██   ██
 *   ██▄▄▄█▀   C O N T E N T S
 *             i.    Fix the timeout fallback in the config loader . . . . .  2h ago
 *             ii.   Add retry backoff to the fetch client . . . . . . . .  1d ago
 *
 *             /resume open a chapter    /help commands    @file context   …
 *
 * The contents are this workspace's recent sessions, with their age where a
 * book prints the page. Before a first session they list what a new reader
 * needs, with the key to press as the page. Left-aligned on the transcript
 * grid, so the page begins where the conversation will.
 */
function TitlePage({
  width,
  pageWidth,
  availableRows,
  workspace,
  model,
  recentSessions,
  contentsPending,
  now,
}: {
  width: number;
  pageWidth: number;
  availableRows: number;
  workspace?: string;
  model: string;
  recentSessions: readonly RecentChapter[];
  contentsPending: boolean;
  now: number;
}) {
  const theme = useTheme();
  const notifyLayoutChange = useTranscriptLayoutChange();
  const { entries, chapters } = contentsPending
    ? { entries: [], chapters: false }
    : contentsEntries(recentSessions, now);
  const fit = fitTitlePage(availableRows, entries.length, chapters);
  // The page resizes itself to the viewport (a menu opening shrinks it to the
  // cap), and the transcript only re-measures its content when told.
  const fitKey = `${fit.show}:${fit.entries}:${fit.index}:${fit.topPadding}`;
  useLayoutEffect(() => {
    notifyLayoutChange?.();
  }, [fitKey, notifyLayoutChange]);
  if (!fit.show) return <Box />;

  const capWidth = displayWidth(DROP_CAP[0]);
  const textColumn = capWidth + DROP_CAP_GAP;
  const textWidth = Math.max(12, pageWidth - textColumn);
  const word = 'O O K';
  const runningHead = truncateDisplay(
    `${workspaceName(workspace)} · ${model}`,
    Math.max(0, textWidth - displayWidth(word) - 4),
  );
  const tagline = contentsPending
    ? ''
    : chapters
      ? 'Pick up a chapter with /resume, or begin a new one below.'
      : 'Your first chapter begins below.';
  const beside: React.ReactNode[] = [
    <Box key="title" width={textWidth}>
      <Text color={theme.text} bold>
        {word}
      </Text>
      <Text>
        {' '.repeat(Math.max(1, textWidth - displayWidth(word) - displayWidth(runningHead)))}
      </Text>
      <Text color={theme.inactive}>{runningHead}</Text>
    </Box>,
    <Text key="rule" color={theme.border}>
      {'─'.repeat(textWidth)}
    </Text>,
    <Text key="tagline" color={theme.subtle} italic>
      {truncateDisplay(tagline, textWidth)}
    </Text>,
    null,
    fit.entries > 0 ? (
      <Text key="contents" color={theme.inactive}>
        C O N T E N T S
      </Text>
    ) : null,
  ];

  return (
    <Box flexDirection="column" width={width - 1} paddingLeft={CONTENT_COLUMN}>
      {fit.topPadding > 0 ? <Box height={fit.topPadding} /> : null}
      {DROP_CAP.map((row, index) => (
        <Box key={`cap-${index}`}>
          <Text color={theme.brand}>{row}</Text>
          <Text>{' '.repeat(DROP_CAP_GAP)}</Text>
          {beside[index]}
        </Box>
      ))}
      {entries.slice(0, fit.entries).map((entry) => {
        const pageWidthUsed = displayWidth(entry.page);
        const titleRoom = Math.max(4, textWidth - NUMERAL_WIDTH - pageWidthUsed - LEADER_MIN);
        const title = truncateDisplay(entry.title, titleRoom);
        const leaderStart = CONTENT_COLUMN + textColumn + NUMERAL_WIDTH + displayWidth(title);
        const leaderWidth = textWidth - NUMERAL_WIDTH - displayWidth(title) - pageWidthUsed;
        return (
          <Box key={`${entry.numeral}-${entry.title}`} paddingLeft={textColumn}>
            <Text color={theme.brand}>{entry.numeral.padEnd(NUMERAL_WIDTH)}</Text>
            <Text color={theme.text}>{title}</Text>
            <Text color={theme.border}>{dotLeader(leaderStart, leaderWidth)}</Text>
            <Text color={entry.pageTone === 'key' ? theme.text : theme.inactive}>{entry.page}</Text>
          </Box>
        );
      })}
      {fit.index ? (
        <>
          <Text> </Text>
          <Box paddingLeft={textColumn}>
            <HintRow hints={composeWelcomeHints(CHAPTER_HINTS, textWidth)} />
          </Box>
        </>
      ) : null}
    </Box>
  );
}
