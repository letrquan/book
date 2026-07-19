/** Shared status indicator icons and colors used by both AgentTodoList and TaskList. */
export const STATUS_INDICATORS = {
  pending: { icon: '○' as const, colorToken: 'inactive' as const },
  in_progress: { icon: '◉' as const, colorToken: 'assistantAccent' as const },
  completed: { icon: '✓' as const, colorToken: 'success' as const },
};
