/**
 * Extract the primary argument from a tool call for display and rule matching.
 *
 * Priority order follows Claude Code's convention:
 * command → shell_id → shellId → taskId → task_id → filePath → file_path
 * → notebook_path → path → pattern → agent → skill → message → url → query → subject
 * → old_string → first string key.
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
  if (typeof args.path === 'string') return args.path;
  if (typeof args.pattern === 'string') return args.pattern;
  if (typeof args.agent === 'string') return args.agent;
  if (typeof args.skill === 'string') return args.skill;
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
