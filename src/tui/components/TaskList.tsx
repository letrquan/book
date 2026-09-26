import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { STATUS_INDICATORS } from '../status-indicators.js';
import type { Task } from '../hooks/useTasks.js';
import { SoftPanel } from './chrome.js';

interface TaskListProps {
  tasks: Task[];
  onUpdateStatus: (id: string, status: Task['status']) => void;
  onRemove: (id: string) => void;
  /** Sheet width; with it the title becomes a ruled head like the other reference panels. */
  width?: number;
}

export function TaskList({ tasks, width }: TaskListProps) {
  const theme = useTheme();
  const visible = tasks.slice(0, 5);

  return (
    <SoftPanel title="Tasks" meta={String(tasks.length)} width={width}>
      {visible.length === 0 && (
        <Text color={theme.subtle}>No tasks yet. Use /task &lt;description&gt; to create one.</Text>
      )}
      {visible.map((task) => {
        const indicator = STATUS_INDICATORS[task.status];
        return (
          <Box key={task.id}>
            <Text color={theme[indicator.colorToken]}>{indicator.icon} </Text>
            <Text
              color={task.status === 'completed' ? theme.subtle : theme.text}
              strikethrough={task.status === 'completed'}
            >
              {task.subject}
            </Text>
          </Box>
        );
      })}
      {tasks.length > 5 && <Text color={theme.inactive}>…and {tasks.length - 5} more</Text>}
    </SoftPanel>
  );
}
