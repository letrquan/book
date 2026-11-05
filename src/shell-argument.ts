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
