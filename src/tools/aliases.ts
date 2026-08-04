/** Legacy tool-name aliases, resolved to their canonical PascalCase names. */
export const TOOL_ALIASES: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  multi_edit: 'MultiEdit',
  apply_patch: 'ApplyPatch',
  glob: 'Glob',
  glob_files: 'Glob',
  grep: 'Grep',
  bash: 'Bash',
  // Legacy snake_case git tool names — backward compatible.
  git_status: 'GitStatus',
  git_diff: 'GitDiff',
  git_log: 'GitLog',
  git_commit: 'GitCommit',
  git_branch: 'GitBranch',
};

/** Map a (possibly aliased) tool name to its canonical name for display / matching. */
export function canonicalToolName(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}
