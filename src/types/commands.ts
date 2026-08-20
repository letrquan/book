/**
 * A slash command loaded from .book/commands/*.md or ~/.book/commands/*.md.
 * Matches Claude Code's command loading model.
 */
export interface SlashCommand {
  /** File basename without extension — the command name invoked via /name */
  name: string;
  /** Human-readable description (from frontmatter `description`) */
  description: string;
  /** Argument hint shown in help and autocomplete (from frontmatter `argument-hint`) */
  argumentHint?: string;
  /** Named positional arguments for $name substitution (from frontmatter `arguments`) */
  arguments?: string[];
  /** Restrict which tools this command can use (from frontmatter `allowed-tools`) */
  allowedTools?: string[];
  /** Override model for this command (from frontmatter `model`) */
  model?: string;
  /** The raw Markdown body — injected as the prompt when invoked. */
  body: string;
  /** Source directory for priority/debugging (user vs project). */
  source: 'user' | 'project';
  /** Hide from / autocomplete and /help listing (default false). */
  isHidden?: boolean;
  /** Whether users can type /name to invoke (default true). */
  userInvocable?: boolean;
}

/**
 * A slash command a host performed itself instead of running a model turn for
 * it (`book -p "/review"`, `query({ prompt: '/review' })`).
 *
 * Both renderings travel together because both hosts consume it: `output` is
 * what a human reads, `data` is the command's own machine contract (`/review`
 * projects `ReviewJsonReport` from `review/host.ts`). Carrying it on the result
 * rather than only writing it to stdout is what keeps an SDK caller — whose
 * stdout is a discard sink — from paying for the work and receiving nothing.
 */
export interface HostCommandResult {
  /** Command name as the user typed it (an alias, possibly). */
  command: string;
  output?: string;
  data?: unknown;
}

/**
 * Runtime context for an active command invocation.
 * Carries enforcement data through the agent loop.
 */
export interface CommandContext {
  /** The command that was invoked */
  command: SlashCommand;
  /** The resolved body after argument/shell/env substitution */
  resolvedBody: string;
  /** Model override from command frontmatter */
  modelOverride?: string;
  /** Tool allowlist from command frontmatter */
  allowedTools?: string[];
}
