import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme.js';
import { panelGrid } from '../layout.js';
import { PILCROW } from '../marks.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';

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
 * The head of a surface that is waiting on you: a hairline across its width in
 * the surface's tone, opened by a rubricated pilcrow and a label.
 *
 *   `─ ¶ Permission required ──────────────────────────────`
 *
 * The pilcrow is the composer's mark, and here it means the same thing: the
 * next move is yours. A box around the whole prompt made it the heaviest
 * object on screen; the rule keeps the tone at the head, where the eye lands.
 */
export function DecisionRule({
  label,
  tone,
  width,
  lineTone = tone,
}: {
  label: string;
  tone: string;
  width: number;
  /** The rule's own colour, when it should sit quieter than its label. */
  lineTone?: string;
}) {
  const theme = useTheme();
  const lead = '─ ';
  const mark = `${PILCROW} `;
  const text = truncateDisplay(label, Math.max(1, width - displayWidth(lead + mark) - 3));
  const fill = Math.max(0, width - displayWidth(lead + mark + text) - 1);
  return (
    <Box>
      <Text color={lineTone}>{lead}</Text>
      <Text color={theme.brand}>{mark}</Text>
      <Text color={tone} bold>
        {text}
      </Text>
      <Text color={lineTone}>{` ${'─'.repeat(fill)}`}</Text>
    </Box>
  );
}
