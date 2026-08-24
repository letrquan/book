import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { STATUS_INDICATORS } from '../status-indicators.js';
import { CONTENT_COLUMN } from '../layout.js';
import type { Todo } from '../../tools/todo.js';

interface AgentTodoListProps {
  todos: Todo[];
}

export function visibleAgentTodos(todos: readonly Todo[]): Todo[] {
  const visible = todos.slice(0, 5);
  const activeTodo = todos.find((todo) => todo.status === 'in_progress');
  if (activeTodo && !visible.includes(activeTodo)) visible.splice(4, 1, activeTodo);
  return visible;
}

export function shouldShowAgentPlan(todos: readonly Todo[], showTasks: boolean): boolean {
  return todos.length > 0 && (showTasks || todos.some((todo) => todo.status !== 'completed'));
}

export function AgentTodoList({ todos }: AgentTodoListProps) {
  const theme = useTheme();
  if (todos.length === 0) return null;
  const visible = visibleAgentTodos(todos);
  const done = todos.filter((t) => t.status === 'completed').length;

  return (
    <Box flexDirection="column" marginY={0}>
      <Box paddingLeft={CONTENT_COLUMN}>
        <Text color={theme.brand} bold>
          Plan <Text color={theme.toolRail}>·</Text> {done}/{todos.length}
        </Text>
      </Box>
      {visible.map((t, i) => {
        const ind = STATUS_INDICATORS[t.status];
        return (
          <Box key={i}>
            <Text color={theme[ind.colorToken]}>{ind.icon} </Text>
            <Text
              color={t.status === 'completed' ? theme.subtle : theme.text}
              strikethrough={t.status === 'completed'}
            >
              {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
            </Text>
          </Box>
        );
      })}
      {todos.length > visible.length && (
        <Box paddingLeft={CONTENT_COLUMN}>
          <Text color={theme.subtle}>…and {todos.length - visible.length} more</Text>
        </Box>
      )}
    </Box>
  );
}
