/** Shared status indicator icons and colors used by both AgentTodoList and TaskList. */
export const STATUS_INDICATORS = {
  pending: { icon: '○' as const, color: 'gray' as const },
  in_progress: { icon: '◉' as const, color: 'cyan' as const },
  completed: { icon: '✓' as const, color: 'green' as const },
};
