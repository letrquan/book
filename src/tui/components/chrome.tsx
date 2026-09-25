import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme.js';
import { panelGrid } from '../layout.js';
import { PILCROW } from '../marks.js';
import { displayWidth, padDisplay, truncateDisplay } from './word-wrap.js';

export type PanelTone = 'neutral' | 'brand' | 'permission' | 'plan' | 'error';

function toneColor(tone: PanelTone, theme: ReturnType<typeof useTheme>): string {
  switch (tone) {
    case 'brand':
      return theme.brand;
    case 'permission':
      return theme.permission;
    case 'plan':
      return theme.planMode;
    case 'error':
      return theme.error;
    default:
      return theme.border;
  }
}

export function SoftPanel({
  children,
  tone = 'neutral',
  width,
  marginX = 0,
  paddingX = 1,
  attached = false,
}: {
  children: ReactNode;
  tone?: PanelTone;
  width?: number;
  marginX?: number;
  paddingX?: number;
  /**
   * Draw the panel as part of the composer below it: a hairline across the top
   * and no walls, the same way the composer itself is drawn. The interior keeps
   * the boxed geometry (one extra column of padding stands in for each wall), so
   * callers that size rows as `width - 4` need no change.
   */
  attached?: boolean;
}) {
  const theme = useTheme();
  if (attached) {
    return (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderLeft={false}
        borderRight={false}
        borderBottom={false}
        borderColor={toneColor(tone, theme)}
        paddingX={paddingX + 1}
        width={width}
        marginX={marginX}
      >
        {children}
      </Box>
    );
  }
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={toneColor(tone, theme)}
      paddingX={paddingX}
      width={width}
      marginX={marginX}
    >
      {children}
    </Box>
  );
}

export function PanelTitle({
  children,
  tone = 'brand',
}: {
  children: ReactNode;
  tone?: PanelTone;
}) {
  const theme = useTheme();
  return (
    <Text bold color={toneColor(tone, theme)}>
      {children}
    </Text>
  );
}

export function SelectionRow({
  selected,
  children,
  width,
}: {
  selected: boolean;
  children: ReactNode;
  width?: number;
}) {
  const theme = useTheme();
  return (
    <Box width={width} backgroundColor={selected ? theme.surfaceActive : undefined}>
      <Text color={selected ? theme.selectionText : theme.text} bold={selected}>
        {children}
      </Text>
    </Box>
  );
}

/**
 * @deprecated Prefer {@link panelGrid} directly. Kept so every floating surface
 * keeps a single call site while they migrate to the grid.
 *
 * Note this is {@link panelGrid}, not {@link frameGrid}: everything that reaches
 * here floats over the transcript, so it is bounded. The composer is the one
 * bordered surface that spans the transcript, and it calls `frameGrid` itself.
 */
export function floatingFrameMetrics(terminalWidth: number): { width: number; marginX: number } {
  return panelGrid(terminalWidth);
}

/**
 * The head of a surface that is waiting on you: a hairline across its width,
 * opened by a rubricated pilcrow and a label, with a short note at the far end.
 *
 *   `─ ¶ Permission required ──────────────────────────── shell command ─`
 *
 * The pilcrow is the composer's mark and means the same thing here: the next
 * move is yours. The label carries the surface's one tone (amber for a write,
 * rose for a shell command); the line itself stays a quiet hairline, so the
 * tone reads as a word, not as a frame.
 */
export function DecisionRule({
  label,
  tone,
  width,
  meta = '',
  lineTone,
}: {
  label: string;
  tone: string;
  width: number;
  /** A short note set at the right end of the rule, in a quiet grey. */
  meta?: string;
  /** The line's own colour; a hairline grey unless a caller asks otherwise. */
  lineTone?: string;
}) {
  const theme = useTheme();
  const line = lineTone ?? theme.border;
  const lead = '─ ';
  const mark = `${PILCROW} `;
  // The note gives way first when the row is tight, then the label shortens.
  const room = (tail: string) => width - displayWidth(lead + mark + tail) - 2;
  const tail = meta && room(` ${meta} ─`) >= displayWidth(label) ? ` ${meta} ─` : '';
  const text = truncateDisplay(label, Math.max(1, room(tail)));
  const fill = Math.max(1, width - displayWidth(lead + mark + text) - 1 - displayWidth(tail));
  return (
    <Box>
      <Text color={line}>{lead}</Text>
      <Text color={theme.brand}>{mark}</Text>
      <Text color={tone} bold>
        {text}
      </Text>
      <Text color={line}>{` ${'─'.repeat(fill)}`}</Text>
      {tail ? (
        <>
          <Text color={theme.inactive}> {meta}</Text>
          <Text color={line}> ─</Text>
        </>
      ) : null}
    </Box>
  );
}

/**
 * A surface that is waiting on you, set under a {@link DecisionRule} instead of
 * inside a box.
 *
 * Every decision the TUI asks for (a permission, a question, a plan, an MCP
 * server) shares this anatomy: a blank row of air, the rule, then the body two
 * columns in, so its text lands on the transcript's content column. Two columns
 * of padding stand in for each wall a box would have drawn, so a body sized as
 * `width - PANEL_CHROME` keeps the geometry it had inside the box.
 */
export function DecisionSheet({
  label,
  tone,
  meta,
  width,
  marginX = 0,
  children,
}: {
  label: string;
  tone: string;
  meta?: string;
  width: number;
  marginX?: number;
  children: ReactNode;
}) {
  return (
    <Box flexDirection="column" width={width} marginX={marginX} marginTop={1}>
      <DecisionRule label={label} tone={tone} meta={meta} width={width} />
      <Box flexDirection="column" paddingX={2}>
        {children}
      </Box>
    </Box>
  );
}

export interface Choice {
  label: string;
  /** Set after the labels, in one column, in a quiet grey. */
  detail?: string;
  /** Whether this choice is ticked, or is the answer already given; drawn when `marks` is on. */
  checked?: boolean;
  /** Replaces the row's number, as `+` does for "Other". */
  numeral?: string;
}

/**
 * The choices a decision offers, one per row.
 *
 *   `› 1  The default (1000)    Treat an empty value like a missing one.`
 *   `  2  Disable timeouts      Keep today's behaviour.`
 *
 * The chosen row is marked by a rubricated `›` and a bold label, and nothing
 * else: a highlight bar behind it made the list look like a menu from another
 * program. Labels share one column, so details start on the same column. Rows
 * are numbered only when number keys choose them.
 */
export function ChoiceList({
  choices,
  selected,
  width,
  numbered = true,
  marks = false,
  active = true,
}: {
  choices: readonly Choice[];
  /** The row the cursor is on; -1 for none. */
  selected: number;
  width: number;
  numbered?: boolean;
  /** Keep a column for a `✓` beside each row: ticked choices, or the answer already given. */
  marks?: boolean;
  /** False while another part of the surface has the keys: no cursor is drawn. */
  active?: boolean;
}) {
  const theme = useTheme();
  const compact = width < 56;
  const numeralWidth = numbered
    ? Math.max(...choices.map((choice, index) => displayWidth(choice.numeral ?? `${index + 1}`))) +
      2
    : 0;
  const prefixWidth = 2 + (marks ? 2 : 0) + numeralWidth;
  const labelColumn = Math.min(
    Math.max(...choices.map((choice) => displayWidth(choice.label)), 4),
    Math.max(8, Math.floor((width - prefixWidth) * 0.45)),
  );
  return (
    <Box flexDirection="column">
      {choices.map((choice, index) => {
        const current = active && index === selected;
        const numeral = choice.numeral ?? `${index + 1}`;
        const label = compact
          ? truncateDisplay(choice.label, Math.max(4, width - prefixWidth))
          : padDisplay(truncateDisplay(choice.label, labelColumn), labelColumn);
        const detailRoom = compact
          ? Math.max(4, width - prefixWidth)
          : Math.max(4, width - prefixWidth - labelColumn - 3);
        const detail = choice.detail ? truncateDisplay(choice.detail, detailRoom) : '';
        return (
          <Box key={`${index}-${choice.label}`} flexDirection="column">
            <Box>
              <Text color={theme.brand}>{current ? '› ' : '  '}</Text>
              {marks ? <Text color={theme.brand}>{choice.checked ? '✓ ' : '  '}</Text> : null}
              {numbered ? (
                <Text color={theme.brand}>{padDisplay(numeral, numeralWidth)}</Text>
              ) : null}
              <Text
                bold={current || Boolean(choice.checked)}
                color={current ? theme.selectionText : theme.text}
              >
                {label}
              </Text>
              {!compact && detail ? (
                <Text color={current ? theme.subtle : theme.inactive}>{`   ${detail}`}</Text>
              ) : null}
            </Box>
            {compact && detail ? (
              <Text color={theme.inactive}>{`${' '.repeat(prefixWidth)}${detail}`}</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
