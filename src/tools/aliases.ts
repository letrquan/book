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

/**
 * Namespaces a model may write in front of a tool's name. Some providers send
 * `default:Glob`; models write the same namespaces with a dot (`default.Bash`),
 * and OpenAI's harmony format addresses every tool as `functions.<name>`. Each
 * is the tool's own name behind a prefix, so the registry runs the call as that
 * tool. The list stays explicit: `pnpm:list` and `pnpm.list` are commands, not
 * tools.
 */
export const PROVIDER_TOOL_PREFIXES = [
  'parent:',
  'default:',
  'tool:',
  'parent.',
  'default.',
  'tool.',
  'functions.',
] as const;

/** The name behind a provider namespace (`default.Bash` → `Bash`), or the name unchanged. */
export function unwrapProviderPrefix(name: string): string {
  const prefix = PROVIDER_TOOL_PREFIXES.find((candidate) => name.startsWith(candidate));
  return prefix ? name.slice(prefix.length) : name;
}

/**
 * A tool's name as the transcript shows it: namespace unwrapped, alias
 * resolved. The transcript receives a call as the model streamed it, before the
 * registry canonicalizes it, so `default.Bash` would otherwise read as a tool
 * of its own while it ran as `Bash`. For display only: matching and permissions
 * see the call the registry already normalized.
 */
export function displayToolName(name: string): string {
  return canonicalToolName(unwrapProviderPrefix(name));
}
