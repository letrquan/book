/**
 * Extract the primary argument from a tool call for display and rule matching.
 *
 * Priority order follows Claude Code's convention:
 * command → shell_id → shellId → taskId → task_id → filePath → file_path
 * → notebook_path → pattern → path → agent → skill → to (beside a message) → message → url
 * → query → subject
 * → old_string → first string key.
 *
 * `pattern` outranks `path`: for search tools (Grep) the pattern is the
 * rule-matching identity, while `path` is only an optional scope.
 *
 * For command-type args, only the first line is returned.
 */
export function getPrimaryArg(args: Record<string, unknown>): string {
  if (typeof args.command === 'string') return args.command.split('\n')[0];
  if (typeof args.shell_id === 'string') return args.shell_id;
  if (typeof args.shellId === 'string') return args.shellId;
  if (typeof args.taskId === 'string') return args.taskId;
  if (typeof args.task_id === 'string') return args.task_id;
  if (typeof args.filePath === 'string') return args.filePath;
  if (typeof args.file_path === 'string') return args.file_path;
  if (typeof args.patch === 'string') {
    const match = args.patch.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m);
    if (match) return match[1].trim();
  }
  if (typeof args.notebook_path === 'string') return args.notebook_path;
  if (typeof args.pattern === 'string') return args.pattern;
  if (typeof args.path === 'string') return args.path;
  if (typeof args.agent === 'string') return args.agent;
  if (typeof args.skill === 'string') return args.skill;
  // A message's recipient, not its text, is what a rule names: `SessionSend(book-3f)`.
  if (typeof args.to === 'string' && typeof args.message === 'string') {
    return canonicalRecipient(args.to);
  }
  if (typeof args.message === 'string') return args.message;
  if (typeof args.url === 'string') return args.url;
  if (typeof args.query === 'string') return args.query;
  if (typeof args.subject === 'string') return args.subject;
  if (typeof args.old_string === 'string') return args.old_string.slice(0, 60);
  const keys = Object.keys(args);
  if (keys.length > 0) {
    const v = args[keys[0]];
    return typeof v === 'string' ? v : '';
  }
  return '';
}

/**
 * A message's recipient as a rule reads it: trimmed, with a trailing ` [ref]` left out. The name
 * is the address, and `book-3f [a1b2c3]` only tells two sessions of that name apart, so a call
 * and a rule (`permissions.ts` reads a recipient tool's patterns the same way) meet on the name.
 */
export function canonicalRecipient(to: string): string {
  return to.trim().replace(/\s*\[[0-9a-fA-F]{6}\]$/, '');
}
