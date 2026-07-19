import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme.js';

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

export function floatingFrameMetrics(terminalWidth: number): { width: number; marginX: number } {
  const outerWidth = Math.max(20, Math.floor(terminalWidth));
  if (outerWidth < 32) return { width: outerWidth, marginX: 0 };
  return { width: outerWidth - 2, marginX: 1 };
}
