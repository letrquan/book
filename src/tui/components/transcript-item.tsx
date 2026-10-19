import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from '../theme.js';
import { useUiClock } from '../ui-clock.js';
import { CONTENT_COLUMN, RESULT_INDENT } from '../layout.js';
import { ITEM_MARK, RESULT_MARK } from '../marks.js';
import type { ToolPresentationStatus } from '../tool-presentation.js';
import type { ThemeTokens } from '../../types/theme.js';

/**
 * What an item's mark says. Prose is the agent's voice; every other state is a call's.
 * `quiet` is a call that changed nothing worth a colour: a folded run of reads, or a call
 * the registry refused before it ran.
 */
export type ItemState = ToolPresentationStatus | 'prose' | 'quiet';

/** The colour an item's mark takes. Running blinks between it and the dim ink. */
export function itemMarkColor(state: ItemState, theme: ThemeTokens): string {
  if (state === 'success') return theme.success;
  if (state === 'failure') return theme.error;
  if (state === 'skipped' || state === 'pending') return theme.warning;
  if (state === 'running') return theme.assistantAccent;
  if (state === 'quiet') return theme.inactive;
  return theme.text;
}

/**
 * The mark an item opens on, and the space after it: always two columns, so the item's
 * text starts on {@link CONTENT_COLUMN} whatever its state.
 *
 * A running call's mark blinks once a second, the only motion a row makes; under
 * reduced motion it holds still. The clock is the shared slow one, so a turn of
 * running calls re-renders once a second, not once a frame.
 */
export function ItemMark({
  state,
  reducedMotion = false,
}: {
  state: ItemState;
  reducedMotion?: boolean;
}) {
  const theme = useTheme();
  const blinking = state === 'running' && !reducedMotion;
  const tick = useUiClock('slow', blinking);
  const color = blinking && tick % 2 === 1 ? theme.inactive : itemMarkColor(state, theme);
  return <Text color={color}>{`${ITEM_MARK} `}</Text>;
}

/**
 * A call's result, hung under its heading on `⎿`: the connector sits under the call's
 * name, and the result's rows — a sentence, an error, a diff, a command's output — run
 * down the column after it. Only the first row carries the connector.
 */
export function ResultBox({
  width,
  children,
}: {
  /** Columns the result's rows may take, past the connector. */
  width: number;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  return (
    <Box marginLeft={CONTENT_COLUMN}>
      <Box width={RESULT_INDENT} flexShrink={0}>
        <Text color={theme.inactive}>{RESULT_MARK}</Text>
      </Box>
      <Box flexDirection="column" width={Math.max(1, width)}>
        {children}
      </Box>
    </Box>
  );
}

/**
 * One row of a result. It truncates, never wraps: every row draws inside its own box. A `label`
 * (`Error:`) leads it in a colour of its own; the rest of the row keeps the result's grey, so a
 * failure is told by its mark and its label, not by a row of coloured text.
 */
export function ResultLine({
  text,
  color,
  label,
  labelColor,
}: {
  text: string;
  color?: string;
  label?: string;
  labelColor?: string;
}) {
  const theme = useTheme();
  return (
    <Box height={1}>
      {label ? (
        <Text wrap="truncate-end" color={labelColor ?? color ?? theme.subtle}>
          {label}
        </Text>
      ) : null}
      <Text wrap="truncate-end" color={color ?? theme.subtle}>
        {text}
      </Text>
    </Box>
  );
}
