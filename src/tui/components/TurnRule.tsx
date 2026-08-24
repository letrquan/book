import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from '../theme.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';

/**
 * Compose a labelled horizontal rule: `── you ─────────────── 10:55 ──`.
 *
 * Returned as parts so the caller can colour the label independently of the
 * rule. The rule always spans exactly `width` columns.
 */
export function composeTurnRule(
  label: string,
  trailing: string,
  width: number,
): { lead: string; label: string; fill: string; trailing: string; tail: string } {
  const total = Math.max(8, Math.floor(width));
  const lead = '── ';
  const tail = ' ──';
  const shownTrailing = trailing ? ` ${trailing}` : '';
  const labelBudget = Math.max(
    1,
    total - displayWidth(lead) - displayWidth(tail) - displayWidth(shownTrailing) - 2,
  );
  const shownLabel = truncateDisplay(label, labelBudget);
  const fillWidth = Math.max(
    0,
    total -
      displayWidth(lead) -
      displayWidth(shownLabel) -
      1 -
      displayWidth(shownTrailing) -
      displayWidth(tail),
  );
  return {
    lead,
    label: shownLabel,
    fill: `${' '.repeat(1)}${'─'.repeat(fillWidth)}`,
    trailing: shownTrailing,
    tail,
  };
}

/**
 * The boundary between turns.
 *
 * A transcript without one is a wall of same-weight rows: this is the single
 * element that lets the eye find where a turn began when scrolling back.
 */
function TurnRuleInner({
  label,
  trailing = '',
  width,
  accent,
  screenReader = false,
}: {
  label: string;
  trailing?: string;
  width: number;
  accent?: string;
  screenReader?: boolean;
}) {
  const theme = useTheme();
  if (screenReader) {
    return (
      <Box>
        <Text>{trailing ? `${label} at ${trailing}` : label}</Text>
      </Box>
    );
  }
  const parts = composeTurnRule(label, trailing, width);
  return (
    <Box>
      <Text color={theme.mdTurnSeparator}>{parts.lead}</Text>
      <Text color={accent ?? theme.subtle} bold>
        {parts.label}
      </Text>
      <Text color={theme.mdTurnSeparator}>{parts.fill}</Text>
      <Text color={theme.subtle} dimColor>
        {parts.trailing}
      </Text>
      <Text color={theme.mdTurnSeparator}>{parts.tail}</Text>
    </Box>
  );
}

export const TurnRule = React.memo(TurnRuleInner);
