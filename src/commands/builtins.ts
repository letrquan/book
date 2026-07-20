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
  { name: 'clear', description: 'Start a new conversation', argumentHint: '[previous-name]' },
  { name: 'new', description: 'Start a new conversation', argumentHint: '[previous-name]' },
  {
    name: 'reset',
    description: 'Alias for /clear',
    argumentHint: '[previous-name]',
    isHidden: true,
  },
  { name: 'resume', description: 'Resume a saved conversation', argumentHint: '[id|name]' },
  { name: 'continue', description: 'Alias for /resume', argumentHint: '[id|name]', isHidden: true },
  {
    name: 'compact',
    description: 'Summarize older turns',
    argumentHint: '[focus instructions]',
  },
  { name: 'rewind', description: 'Restore conversation, workspace code, or both' },
  { name: 'exit', description: 'Exit book' },
  { name: 'help', description: 'Toggle help' },
  { name: 'task', description: 'Add a task' },
  { name: 'agents', description: 'List managed agents' },
  {
    name: 'agent',
    description: 'Inspect or control a managed agent',
    argumentHint: '<id>|send <id> <message>|stop <id>|apply <id>',
  },
  { name: 'theme', description: 'Switch color theme', argumentHint: '[dark|light|auto|name]' },
  { name: 'model', description: 'Switch models and manage BYOK providers' },
  {
    name: 'effort',
    description: 'Set thinking effort',
    argumentHint: '[low|medium|high|xhigh|max]',
  },
  { name: 'config', description: 'Show current configuration' },
  { name: 'diff', description: 'Show git diff' },
  { name: 'status', description: 'Show session status' },
  {
    name: 'memory',
    description: 'Manage auto-memory',
    argumentHint: '[status|inbox|approve|discard|on|off|path]',
  },
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
