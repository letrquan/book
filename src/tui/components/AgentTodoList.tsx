import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { useDensityMetrics } from '../density.js';
import { STATUS_INDICATORS } from '../status-indicators.js';
import { CONTENT_COLUMN, transcriptGrid } from '../layout.js';
import { truncateDisplay } from './word-wrap.js';
import type { Todo } from '../../tools/todo.js';

interface AgentTodoListProps {
  todos: Todo[];
  terminalWidth?: number;
}

/**
 * The header meter runs one cell per step, so it reads as a scale model of the
 * rows underneath it rather than as an unrelated percentage bar. Long plans are
 * scaled into this many cells instead.
 */
const METER_MAX_CELLS = 12;

/** Below this measure the header keeps the count and drops the meter. */
const METER_MIN_WIDTH = 44;

export function visibleAgentTodos(todos: readonly Todo[]): Todo[] {
  const visible = todos.slice(0, 5);
  const activeTodo = todos.find((todo) => todo.status === 'in_progress');
  if (activeTodo && !visible.includes(activeTodo)) visible.splice(4, 1, activeTodo);
  return visible;
}

export function shouldShowAgentPlan(todos: readonly Todo[], showTasks: boolean): boolean {
  return todos.length > 0 && (showTasks || todos.some((todo) => todo.status !== 'completed'));
}

/** Filled cells for `done` of `total`, never rounding an unfinished plan up to full. */
export function planMeterFill(done: number, total: number, cells: number): number {
  if (total <= 0 || cells <= 0) return 0;
  if (done >= total) return cells;
  return Math.min(cells - 1, Math.round((done / total) * cells));
}

export function AgentTodoList({ todos, terminalWidth = 80 }: AgentTodoListProps) {
  const theme = useTheme();
  const { majorBlockGap } = useDensityMetrics();
  if (todos.length === 0) return null;

  const visible = visibleAgentTodos(todos);
  const done = todos.filter((todo) => todo.status === 'completed').length;
  const complete = done === todos.length;
  const grid = transcriptGrid(terminalWidth);
  // A plan row is `[marker][text]` on the transcript grid, exactly like a tool
  // row or a paragraph. Truncating to the content measure keeps a long step on
  // one line: an Ink wrap would send the overflow back to column 0, under the
  // marker column, where it reads as a new item rather than a continuation.
  const textWidth = grid.content;
  const cells = Math.min(todos.length, METER_MAX_CELLS);
  const filled = planMeterFill(done, todos.length, cells);
  const showMeter = grid.width >= METER_MIN_WIDTH;
  const hidden = todos.length - visible.length;

  return (
    <Box flexDirection="column" marginTop={majorBlockGap}>
      <Box paddingLeft={CONTENT_COLUMN} flexWrap="nowrap">
        <Text color={theme.brand} bold>
          Plan
        </Text>
        {showMeter ? (
          <Text color={complete ? theme.success : theme.brand}>{`  ${'█'.repeat(filled)}`}</Text>
        ) : null}
        {showMeter ? <Text color={theme.toolRail}>{'░'.repeat(cells - filled)}</Text> : null}
        <Text color={complete ? theme.success : theme.subtle}>{`  ${done}/${todos.length}`}</Text>
      </Box>
      {visible.map((todo, index) => {
        const indicator = STATUS_INDICATORS[todo.status];
        const active = todo.status === 'in_progress';
        const finished = todo.status === 'completed';
        // Three weights, so the eye lands on the step in flight: the finished
        // ones recede, the queued ones stay legible, the active one is the only
        // row set in full text colour.
        const color = finished ? theme.inactive : active ? theme.text : theme.subtle;
        return (
          <Box key={index} flexWrap="nowrap">
            <Text color={theme[indicator.colorToken]} bold={active}>
              {indicator.icon}{' '}
            </Text>
            <Text color={color} bold={active} strikethrough={finished}>
              {truncateDisplay(
                active && todo.activeForm ? todo.activeForm : todo.content,
                textWidth,
              )}
            </Text>
          </Box>
        );
      })}
      {hidden > 0 ? (
        <Box paddingLeft={CONTENT_COLUMN}>
          <Text color={theme.inactive}>{`+${hidden} more`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
