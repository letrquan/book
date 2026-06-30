import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { STATUS_INDICATORS } from '../status-indicators.js';
import type { Todo } from '../../tools/todo.js';

interface AgentTodoListProps {
  todos: Todo[];
}

export function AgentTodoList({ todos }: AgentTodoListProps) {
  const theme = useTheme();
  if (todos.length === 0) return null;
  const visible = todos.slice(0, 8);
  const done = todos.filter((t) => t.status === 'completed').length;

  return (
    <Box flexDirection="column" marginY={0} paddingLeft={2}>
      <Text color={theme.brand} bold>
        ▶ Plan ({done}/{todos.length})
      </Text>
      {visible.map((t, i) => {
        const ind = STATUS_INDICATORS[t.status];
        return (
          <Box key={i}>
            <Text color={ind.color}>{ind.icon} </Text>
            <Text
              color={t.status === 'completed' ? theme.subtle : theme.text}
              strikethrough={t.status === 'completed'}
            >
              {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
            </Text>
          </Box>
        );
      })}
      {todos.length > 8 && (
        <Text color={theme.subtle}>…and {todos.length - 8} more</Text>
      )}
    </Box>
  );
}
