import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme.js';
import { panelGrid } from '../layout.js';

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
}: {
  children: ReactNode;
  tone?: PanelTone;
  width?: number;
  marginX?: number;
  paddingX?: number;
}) {
  const theme = useTheme();
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
