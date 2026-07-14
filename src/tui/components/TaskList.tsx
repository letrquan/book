import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { STATUS_INDICATORS } from '../status-indicators.js';
import type { Task } from '../hooks/useTasks.js';

interface TaskListProps {
  tasks: Task[];
  onUpdateStatus: (id: string, status: Task['status']) => void;
  onRemove: (id: string) => void;
}

export function TaskList({ tasks }: TaskListProps) {
  const theme = useTheme();
  const visible = tasks.slice(0, 5);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.brand}
      paddingX={1}
      marginY={1}
    >
      <Text color={theme.brand} bold>
        Tasks ({tasks.length})
      </Text>
      {visible.length === 0 && (
        <Text color={theme.subtle}>No tasks yet. Use /task &lt;description&gt; to create one.</Text>
      )}
      {visible.map((task) => {
        const indicator = STATUS_INDICATORS[task.status];
        return (
          <Box key={task.id}>
            <Text color={indicator.color}>{indicator.icon} </Text>
            <Text
              color={task.status === 'completed' ? theme.subtle : theme.text}
              strikethrough={task.status === 'completed'}
            >
              {task.subject}
            </Text>
          </Box>
        );
      })}
      {tasks.length > 5 && <Text color={theme.subtle}>...and {tasks.length - 5} more</Text>}
    </Box>
  );
}
