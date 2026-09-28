import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { STATUS_INDICATORS } from '../status-indicators.js';
import { GUTTER_WIDTH, sheetContentWidth } from '../layout.js';
import { stepProgress, stepWindow } from '../steps.js';
import type { Todo } from '../../tools/todo.js';
import { SoftPanel } from './chrome.js';
import { foldControlCharacters } from '../../control-characters.js';
import { truncateDisplay } from './word-wrap.js';

/**
 * The agent's steps, opened with Ctrl+T.
 *
 * The plan is not a standing block. While a step is in flight the working line
 * and the status line carry it, so the full list is a reference sheet like
 * /help: set under `─ § Steps ──── 2 of 7 done · Ctrl+T to close ─`. Esc closes
 * it too once the agent is idle; while it works, Esc still cancels the turn, as
 * it always has. Its markers sit where a tool row's `✓` sits, its text on the
 * content column. A step shows its plain wording here; the working line has the
 * `activeForm`.
 */
export function StepsSheet({ todos, width }: { todos: readonly Todo[]; width: number }) {
  const theme = useTheme();
  const textWidth = Math.max(1, sheetContentWidth(width) - GUTTER_WIDTH);
  const { before, rows, after } = stepWindow(todos);
  const beforeFinished = before.every((todo) => todo.status === 'completed');
  return (
    <SoftPanel
      title="Steps"
      meta={todos.length > 0 ? `${stepProgress(todos)} · Ctrl+T to close` : 'Ctrl+T to close'}
      width={width}
    >
      {todos.length === 0 ? (
        <Text color={theme.subtle}>No steps yet. The agent sets them out on multi-step work.</Text>
      ) : null}
      {before.length > 0 ? (
        <Box>
          <Text color={theme[STATUS_INDICATORS.completed.colorToken]}>
            {beforeFinished ? `${STATUS_INDICATORS.completed.icon} ` : ' '.repeat(GUTTER_WIDTH)}
          </Text>
          <Text color={theme.inactive}>
            {beforeFinished ? `${before.length} done` : `${before.length} earlier`}
          </Text>
        </Box>
      ) : null}
      {rows.map((todo, index) => {
        const indicator = STATUS_INDICATORS[todo.status];
        const active = todo.status === 'in_progress';
        const color =
          todo.status === 'completed' ? theme.inactive : active ? theme.text : theme.subtle;
        return (
          <Box key={`${index}-${todo.content}`} flexWrap="nowrap">
            <Text color={theme[indicator.colorToken]}>{`${indicator.icon} `}</Text>
            <Text color={color} bold={active}>
              {truncateDisplay(foldControlCharacters(todo.content), textWidth)}
            </Text>
          </Box>
        );
      })}
      {after > 0 ? (
        <Text color={theme.inactive}>{`${' '.repeat(GUTTER_WIDTH)}+${after} more`}</Text>
      ) : null}
    </SoftPanel>
  );
}
