import { posix, win32 } from 'path';
import { canonicalizePath, comparablePath, isOutside } from './path-utils.js';

/**
 * A strict reading of a shell line that is nothing but `rm <file> [<file>…]`.
 *
 * A glob over a command string cannot say "and nothing else": `*` crosses spaces, `;`, `&&` and
 * `..`, so `Bash(rm /memory/*.md)` as a glob would also match `rm /memory/a.md && curl …` and
 * `rm /memory/a.md /home/me/b.md`. Both callers that must be sure a line is one plain removal —
 * the permission evaluator's memory allowance and the capability layer's `rm` rules — read it
 * here instead.
 *
 * Accepted: the word `rm`, then one or more operands, separated by blanks. An operand is an
 * absolute path of plain characters (letters, digits and `_ . / @ % + = : , -`) with no empty,
 * `.` or `..` segment. Everything else is refused, so there is no flag (a leading `-` cannot start
 * an absolute path, and `--` is not one), no glob, no quote, no variable, no tilde, no chaining
 * (`; & |`), no redirect, no substitution, no line break.
 *
 * On Windows an absolute path is also a drive-letter one (`C:/…` or `C:\…`), and `\` is a
 * separator. Git-Bash-style `/c/Users/…` operands are read as POSIX paths and so never match a
 * `C:` root: `/c/…` is ambiguous with a path on the current drive, so it is left refused rather
 * than guessed at. A directory name with a blank in it cannot be written without quotes, so it is
 * refused too. A `~` is read only as the 8.3 short-name marker (`RUNNER~1`): a shell expands a tilde
 * at the start of a word, and a drive operand never starts with one.
 */
const PLAIN_POSIX_OPERAND = /^\/[A-Za-z0-9_./@%+=:,-]*$/;
/**
 * `C:/…` or `C:\…`; past the drive no `:` is allowed (`a.md:stream` is not a file name). A `~` must
 * be followed by a digit, the 8.3 short form of a long directory name (`C:\Users\RUNNER~1`), which
 * is how Windows spells a temp directory.
 */
const PLAIN_DRIVE_OPERAND = /^[A-Za-z]:[\\/](?:[A-Za-z0-9_.\\/@%+=,-]|~(?=[0-9]))*$/;

export function parseStrictRm(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string[] | null {
  const words = command.trim().split(/[ \t]+/);
  if (words[0] !== 'rm' || words.length < 2) return null;
  const operands = words.slice(1);
  for (const operand of operands) {
    const drive = platform === 'win32' && PLAIN_DRIVE_OPERAND.test(operand);
    if (!drive && !PLAIN_POSIX_OPERAND.test(operand)) return null;
    // Segments are read in the spelling they are compared in; the root of a drive path is `C:/`.
    const spelled = comparablePath(operand, platform);
    const segments = spelled.slice(drive ? 3 : 1).split('/');
    // A trailing slash leaves an empty last segment: that names a directory, not a file.
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      return null;
    }
  }
  return operands;
}

/** Whether `operand` is a `.md` file's path whose name is not hidden. */
function isMarkdownFile(operand: string): boolean {
  const name = posix.basename(operand);
  return name.length > '.md'.length && !name.startsWith('.') && name.endsWith('.md');
}

/**
 * The operands of `command` when it is a strict `rm` of only Markdown files that are *spelled* as
 * under one of `roots`, and `null` otherwise. `MEMORY.md` — the index, not a memory — is never one
 * of them. A pure comparison of strings: nothing is read from disk, so the Windows spelling of a
 * path is judged the same on any host.
 */
export function strictRmOperandsSpelledUnder(
  command: string,
  roots: readonly string[],
  platform: NodeJS.Platform = process.platform,
  /** Another spelling of an operand that may also be under a root (see `strictRmOfMarkdownUnder`). */
  respell: (operand: string) => string = (operand) => operand,
): string[] | null {
  const operands = parseStrictRm(command, platform);
  if (!operands) return null;
  const spellings = roots.map((root) =>
    posix.normalize(comparablePath(root, platform)).replace(/\/+$/, ''),
  );
  const isUnder = (path: string) => {
    const spelled = comparablePath(path, platform);
    return spellings.some((spelling) => spelled.startsWith(`${spelling}/`));
  };
  for (const operand of operands) {
    const spelled = comparablePath(operand, platform);
    if (!isMarkdownFile(spelled) || posix.basename(spelled).toLowerCase() === 'memory.md') {
      return null;
    }
    if (!isUnder(operand) && !isUnder(respell(operand))) return null;
  }
  return operands;
}

/**
 * The operands of `command` when it is a strict `rm` of only Markdown files under `root`, and
 * `null` otherwise. `MEMORY.md` — the index, not a memory — is never one of them.
 *
 * "Under" is judged twice: by the spelling, and again after links are followed in the directory
 * that holds each file, so a symlinked subdirectory cannot carry a removal out of `root`. The file
 * itself may be a link: `rm` removes the link and not what it points at.
 *
 * `canonicalize` is how links (and, on Windows, 8.3 short names) are followed. Root and operand
 * both go through it, so `C:\Users\RUNNER~1\…` and `C:\Users\runneradmin\…` name one directory
 * whichever of them the root and the operand are spelled in; it is a seam so that a Windows path
 * can be judged on any host.
 */
export function strictRmOfMarkdownUnder(
  command: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
  canonicalize: (path: string) => string = canonicalizePath,
): string[] | null {
  const paths = platform === 'win32' ? win32 : posix;
  if (!paths.isAbsolute(root)) return null;
  const canonicalRoot = canonicalize(root);
  // The root as the model was told it and as links resolve it: either spelling names it.
  const operands = strictRmOperandsSpelledUnder(
    command,
    [root, canonicalRoot],
    platform,
    (operand) => paths.join(canonicalize(paths.dirname(operand)), paths.basename(operand)),
  );
  if (!operands) return null;
  for (const operand of operands) {
    if (isOutside(canonicalRoot, canonicalize(paths.dirname(operand)), paths)) return null;
  }
  return operands;
}

/**
 * Whether a capability rule `Bash(rm <glob>)` admits `command`. The rule is read operand by
 * operand: the line must be a strict `rm` ({@link parseStrictRm}), and every operand must match
 * the glob. Only called for a rule whose operand glob is an absolute path.
 */
export function strictRmMatchesGlob(
  command: string,
  matchesOperand: (operand: string) => boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const operands = parseStrictRm(command, platform);
  return operands !== null && operands.every(matchesOperand);
}
