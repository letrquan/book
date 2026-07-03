/**
 * Shared built-in command definitions.
 *
 * Used by both InputBar (autocomplete) and CommandMenu (rendering).
 * Single source of truth — no duplication.
 */

export interface BuiltinCommand {
  name: string;
  description: string;
  argumentHint?: string;
  /** Hide from / autocomplete when empty, but still match when typed exactly. */
  isHidden?: boolean;
}

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: 'clear', description: 'Clear conversation' },
  { name: 'compact', description: 'Summarize older turns' },
  { name: 'exit', description: 'Exit book' },
  { name: 'help', description: 'Toggle help' },
  { name: 'task', description: 'Add a task' },
  { name: 'theme', description: 'Switch theme' },
  { name: 'model', description: 'Switch AI model' },
  { name: 'config', description: 'Show current configuration' },
  { name: 'diff', description: 'Show git diff' },
  { name: 'status', description: 'Show session status' },
  { name: 'memory', description: 'Manage auto-memory' },
  { name: 'permissions', description: 'Manage permission rules' },
  { name: 'cost', description: 'Show token usage and cost' },
  { name: 'skills', description: 'List available skills' },
  { name: 'init', description: 'Initialize project with CLAUDE.md' },
  { name: 'reload-skills', description: 'Re-scan command and skill directories' },
  { name: 'export', description: 'Export conversation to file' },
  // NEW (1f): commands that do the real thing locally instead of sending to the agent.
  { name: 'usage', description: 'Session cost & token usage (alias: /stats)' },
  { name: 'stats', description: 'Alias for /usage', isHidden: true },
  { name: 'context', description: 'Show what is filling the context window' },
  { name: 'review', description: 'Review current git diff (correctness & cleanups)' },
  { name: 'security-review', description: 'Security audit of current git diff' },
  { name: 'release-notes', description: 'Show installed version + changelog' },
  { name: 'feedback', description: 'Save a bug-report snapshot to .book/feedback/' },
];

/** Lookup map for fast name → description access. */
export const BUILTIN_BY_NAME: Record<string, BuiltinCommand> = Object.fromEntries(
  BUILTIN_COMMANDS.map((c) => [c.name, c]),
);
