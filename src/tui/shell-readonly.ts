/**
 * A conservative read-only classifier for shell commands.
 *
 * The compact transcript folds a run of reads into one summary row. A model that
 * explores through the shell (`cat src/a.js`, `rg TODO src`, `ls src`) used to
 * draw a row per command, because a shell command can change anything. This
 * module answers one question: can the WHOLE command be proven harmless by
 * reading it? It tokenizes the way a POSIX shell would for the few constructs it
 * accepts, refuses everything it cannot model (expansion, redirection,
 * background jobs, multi-line scripts, wrappers), and then checks every segment
 * against a small allow-list with each command's mutating flags rejected.
 *
 * Allow-list: `cat`, `bat` (only with paging off), `head`, `tail` (never following),
 * `nl`, `wc`, `file`, `stat`, `sed -n Np`, `grep`, `rg`, `ag`, `find` without actions,
 * `fd` without exec, `ls`, `tree`, `eza`, `du` and `pwd`, plus small stdin formatters
 * after a pipe. Read-only `git` is on it too: `status`, `log`, `diff`, `show`, `grep`,
 * `ls-files` and `branch` in its listing forms, behind only `-C <dir>`, `--no-pager`, `-P`
 * and `--no-optional-locks`. A fold changes how a command that already ran is drawn, so
 * what the repository's own config makes git run is not this module's question; what the
 * command line itself asks for is (`-c`, `--output`, `--ext-diff`, a pager program, a
 * branch name). Not on the list: `ack` (it reads a project-level `.ackrc`), and every
 * pager, wrapper and interpreter. An option that names a file is counted as a path for
 * the caller's workspace check, or the command is refused. A path with a glob that could
 * expand to `..` is refused.
 *
 * `undefined` is always the safe answer: the command then keeps its own row.
 * Anything not named here, a command or a flag, is therefore "not read-only".
 *
 * The shape follows OpenAI Codex's `parse_command.rs` (Apache-2.0): reads,
 * searches and listings, small stdin formatters dropped from a pipeline.
 */

import { isAbsolute, join } from 'path';

export type ReadOnlyShellPart =
  | { kind: 'read'; path: string }
  | { kind: 'search'; query?: string; path?: string; extraPaths?: string[] }
  | { kind: 'list'; path?: string; extraPaths?: string[] }
  /** A look at repository state (`git status`); `target` names it in a summary. */
  | { kind: 'lookup'; target: string; path?: string; extraPaths?: string[] };

/** Every path a classification names, for the caller's workspace-containment check. */
export function shellCommandPaths(parts: readonly ReadOnlyShellPart[]): string[] {
  return parts.flatMap((part) =>
    part.kind === 'read'
      ? [part.path]
      : [...(part.path !== undefined ? [part.path] : []), ...(part.extraPaths ?? [])],
  );
}

const GLOB_CHARS = /[*?[]/;

/**
 * Whether a path operand holds a glob that bash (before 5.2) could expand to `..`:
 * a segment that starts with a dot and has a metacharacter (`.*`, `.?`, `.[.]`), or
 * one made only of metacharacters and dots (`[.][.]`, `*`). The workspace check is
 * lexical, so `.*\/secret` would resolve inside the workspace while the shell
 * reaches the parent.
 */
function globMayReachParent(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => {
    if (!GLOB_CHARS.test(segment)) return false;
    return segment.startsWith('.') || /^[*?[\].]+$/.test(segment);
  });
}

type Connector = '|' | '&&' | '||' | ';';

type Token = { kind: 'word'; text: string } | { kind: 'op'; op: Connector };

/** The two redirections that cannot write anywhere, only at the start of a word. */
const SAFE_REDIRECT = /^2>(?:\/dev\/null|&1)(?=[\s;&|]|$)/;

/**
 * Split a command into words and connectors, or undefined when it uses anything
 * the classifier does not model: expansion, redirection, background jobs,
 * subshells, groups, comments, tilde or brace expansion.
 */
function tokenize(command: string): Token[] | undefined {
  const tokens: Token[] = [];
  let word = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) tokens.push({ kind: 'word', text: word });
    word = '';
    inWord = false;
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return undefined;
      const body = command.slice(i + 1, end);
      if (body.includes('`')) return undefined;
      word += body;
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      inWord = true;
      i += 1;
      let closed = false;
      while (i < command.length) {
        const ch = command[i]!;
        if (ch === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (ch === '$' || ch === '`') return undefined;
        if (ch === '\\') {
          const next = command[i + 1];
          if (next === undefined || next === '`') return undefined;
          // Inside double quotes a backslash only escapes these four characters.
          if (next === '$' || next === '"' || next === '\\') {
            word += next;
            i += 2;
            continue;
          }
        }
        word += ch;
        i += 1;
      }
      if (!closed) return undefined;
      continue;
    }
    if (c === '\\') {
      const next = command[i + 1];
      if (next === undefined || next === '`') return undefined;
      word += next;
      inWord = true;
      i += 2;
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      i += 1;
      continue;
    }
    if (c === '$' || c === '`') return undefined;
    if (!inWord) {
      const redirect = SAFE_REDIRECT.exec(command.slice(i));
      if (redirect) {
        i += redirect[0].length;
        continue;
      }
      // A comment, or a tilde that would expand to the home directory.
      if (c === '#' || c === '~') return undefined;
    }
    if (c === '<' || c === '>' || c === '(' || c === ')' || c === '{' || c === '}') {
      return undefined;
    }
    if (c === '|') {
      if (command[i + 1] === '&') return undefined;
      endWord();
      const double = command[i + 1] === '|';
      tokens.push({ kind: 'op', op: double ? '||' : '|' });
      i += double ? 2 : 1;
      continue;
    }
    if (c === '&') {
      // A lone `&` backgrounds the command; `&>` and `>&` redirect.
      if (command[i + 1] !== '&') return undefined;
      endWord();
      tokens.push({ kind: 'op', op: '&&' });
      i += 2;
      continue;
    }
    if (c === ';') {
      endWord();
      tokens.push({ kind: 'op', op: ';' });
      i += 1;
      continue;
    }
    word += c;
    inWord = true;
    i += 1;
  }
  endWord();
  return tokens;
}

interface Segment {
  words: string[];
  /** The connector that precedes this segment; undefined for the first. */
  after?: Connector;
}

function splitSegments(tokens: readonly Token[]): Segment[] | undefined {
  const segments: Segment[] = [];
  let current: Segment = { words: [] };
  for (const token of tokens) {
    if (token.kind === 'word') {
      current.words.push(token.text);
      continue;
    }
    if (current.words.length === 0) return undefined;
    segments.push(current);
    current = { words: [], after: token.op };
  }
  if (current.words.length === 0) return undefined;
  segments.push(current);
  return segments;
}

interface Flag {
  /** `-x` for a short option, `--name` for a long one. */
  name: string;
  value?: string;
}

interface FlagRules {
  /** Options that take a value: `-A` for a short one, `--glob` for a long one. */
  values?: readonly string[];
  /** Options that make the command unsafe. A long name also matches its abbreviations. */
  deny?: readonly string[];
  /**
   * Options whose value names a file or directory. Each is also listed in `values`; the
   * value joins the command's paths, so the workspace check sees it.
   */
  paths?: readonly string[];
  /** A last check on the raw words and what they parsed to; false refuses the command. */
  check?: (args: readonly string[], parsed: ParsedArgs) => boolean;
}

interface ParsedArgs {
  flags: Flag[];
  /** Every non-option word, including those after `--`. */
  operands: string[];
  /** The values of the options in `FlagRules.paths`. */
  flagPaths: string[];
  /** How many operands came before a `--`, or all of them when there is none. */
  beforeDashes: number;
}

/**
 * Whether a flag is one of `entries`. getopt-style tools accept any unambiguous prefix
 * of a long option, so a long entry also matches its abbreviations, except a name that
 * is itself a known option (`--exclude` beside `--exclude-from`).
 */
function matchesOption(
  flag: Flag,
  entries: readonly string[],
  known: ReadonlySet<string> = new Set(),
): boolean {
  return entries.some((entry) => {
    if (!entry.startsWith('--')) return flag.name === entry;
    if (flag.name === entry) return true;
    return (
      flag.name.startsWith('--') &&
      flag.name.length >= 3 &&
      entry.startsWith(flag.name) &&
      !known.has(flag.name)
    );
  });
}

/**
 * Split arguments into options and operands the way getopt does: a cluster of
 * short options ends at the first one that takes a value, which then owns the
 * rest of the cluster or the next word. Undefined when a denied option appears
 * or a value is missing.
 */
function parseArgs(args: readonly string[], rules: FlagRules = {}): ParsedArgs | undefined {
  const values = rules.values ?? [];
  const shortValue = new Set(values.filter((v) => /^-[^-]$/.test(v)).map((v) => v[1]!));
  const longValue = new Set(values.filter((v) => v.startsWith('--')));
  const flags: Flag[] = [];
  const operands: string[] = [];
  let beforeDashes: number | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (beforeDashes !== undefined) {
      operands.push(arg);
    } else if (arg === '--') {
      beforeDashes = operands.length;
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        flags.push({ name: arg.slice(0, eq), value: arg.slice(eq + 1) });
      } else if (longValue.has(arg)) {
        const value = args[i + 1];
        if (value === undefined) return undefined;
        flags.push({ name: arg, value });
        i += 1;
      } else {
        flags.push({ name: arg });
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j += 1) {
        const ch = arg[j]!;
        if (!shortValue.has(ch)) {
          flags.push({ name: `-${ch}` });
          continue;
        }
        let value = arg.slice(j + 1);
        if (value === '') {
          const next = args[i + 1];
          if (next === undefined) return undefined;
          value = next;
          i += 1;
        }
        flags.push({ name: `-${ch}`, value });
        break;
      }
    } else {
      operands.push(arg);
    }
  }
  const deny = rules.deny ?? [];
  if (flags.some((flag) => matchesOption(flag, deny, longValue))) return undefined;
  const pathOptions = rules.paths ?? [];
  const flagPaths = flags
    .filter((flag) => flag.value !== undefined && matchesOption(flag, pathOptions, longValue))
    // A list of files (`file -m a:b`) is several paths, and the whole value is one too.
    .flatMap((flag) => [flag.value!, ...(flag.value!.includes(':') ? flag.value!.split(':') : [])]);
  const parsed = { flags, operands, flagPaths, beforeDashes: beforeDashes ?? operands.length };
  return rules.check && !rules.check(args, parsed) ? undefined : parsed;
}

function whereParts(paths: readonly string[]): { path?: string; extraPaths?: string[] } {
  const [first, ...rest] = paths;
  return {
    ...(first !== undefined ? { path: first } : {}),
    ...(rest.length > 0 ? { extraPaths: rest } : {}),
  };
}

function pathsPart(
  kind: 'search' | 'list',
  paths: readonly string[],
  query?: string,
): ReadOnlyShellPart {
  const where = whereParts(paths);
  if (kind === 'list') return { kind, ...where };
  return { kind, ...(query !== undefined ? { query } : {}), ...where };
}

/** An own-property lookup, so a word like `constructor` is never a table hit. */
function lookup<T>(table: Record<string, T>, key: string | undefined): T | undefined {
  return key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

// --- Read ---------------------------------------------------------------

const HEAD_TAIL_VALUES = ['-n', '-c', '--lines', '--bytes'];

/**
 * `tail` must never follow: `-f`, `-F`, `--follow` (denied by name), a cluster that
 * holds one (`-5f`), and the obsolete `+1f` operand form all keep it running.
 */
function tailDoesNotFollow(args: readonly string[], parsed: ParsedArgs): boolean {
  if (parsed.operands.some((operand) => operand.startsWith('+'))) return false;
  for (const arg of args) {
    if (arg === '--') break;
    if (/^-[^-]/.test(arg) && /[fF]/.test(arg)) return false;
  }
  return true;
}

/** `bat` only runs a pager unless paging is turned off. */
function batPagingIsNever(_args: readonly string[], parsed: ParsedArgs): boolean {
  return parsed.flags.every((flag) => !matchesOption(flag, ['--paging']) || flag.value === 'never');
}

const READ_RULES: Record<string, FlagRules> = {
  cat: {},
  bat: {
    values: [
      '-l',
      '--language',
      '-r',
      '--line-range',
      '--theme',
      '-H',
      '--highlight-line',
      '--style',
      '--tabs',
      '--wrap',
      '--terminal-width',
      '--paging',
      '--color',
      '--map-syntax',
    ],
    deny: [
      '--pager',
      // `bat cache --build` and the like write the cache; `--generate-config-file` a config.
      '--generate-config-file',
      '--build',
      '--clear',
      '--source',
      '--target',
      '--blank',
      '--acknowledgements',
    ],
    check: batPagingIsNever,
  },
  head: { values: HEAD_TAIL_VALUES },
  tail: {
    values: HEAD_TAIL_VALUES,
    deny: ['-f', '-F', '--follow'],
    check: tailDoesNotFollow,
  },
  nl: { values: ['-b', '-d', '-f', '-h', '-i', '-l', '-n', '-s', '-v', '-w'] },
  wc: { deny: ['--files0-from'] },
  file: {
    values: ['-m', '--magic-file', '-P', '--parameter', '-e', '--exclude'],
    paths: ['-m', '--magic-file'],
    deny: ['-f', '-C', '--files-from', '--compile'],
  },
  stat: { values: ['-c', '--format', '--printf'] },
};
READ_RULES.batcat = READ_RULES.bat!;

function readParts(args: readonly string[], rules: FlagRules): ReadOnlyShellPart[] | undefined {
  const parsed = parseArgs(args, rules);
  if (!parsed || parsed.operands.length === 0) return undefined;
  return [...parsed.operands, ...parsed.flagPaths].map((path) => ({ kind: 'read', path }));
}

/** Only an address print: `sed -n 1,40p file`. Every other script can write, execute or read. */
const SED_PRINT = /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/;

function sedParts(args: readonly string[]): ReadOnlyShellPart[] | undefined {
  let quiet = false;
  let script: string | undefined;
  const operands: string[] = [];
  let dashes = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (dashes) operands.push(arg);
    else if (arg === '--') dashes = true;
    else if (arg === '-n' || arg === '--quiet' || arg === '--silent') quiet = true;
    else if (arg === '-E' || arg === '-r' || arg === '-s') continue;
    else if (arg === '--regexp-extended' || arg === '--separate') continue;
    else if (arg === '-e') {
      if (script !== undefined) return undefined;
      script = args[i + 1];
      if (script === undefined) return undefined;
      i += 1;
    } else if (arg.startsWith('-') && arg.length > 1) return undefined;
    else operands.push(arg);
  }
  script ??= operands.shift();
  if (!quiet || script === undefined || !SED_PRINT.test(script) || operands.length === 0) {
    return undefined;
  }
  return operands.map((path) => ({ kind: 'read', path }));
}

// --- Search -------------------------------------------------------------

const GREP_VALUES = [
  '-e',
  '--regexp',
  '-m',
  '--max-count',
  '-A',
  '--after-context',
  '-B',
  '--before-context',
  '-C',
  '--context',
  '-d',
  '--directories',
  '-D',
  '--devices',
  '--include',
  '--exclude',
  '--exclude-dir',
  '--label',
  '--binary-files',
];

const RG_VALUES = [
  '-e',
  '--regexp',
  '-g',
  '--glob',
  '--iglob',
  '-t',
  '--type',
  '-T',
  '--type-not',
  '-m',
  '--max-count',
  '-A',
  '--after-context',
  '-B',
  '--before-context',
  '-C',
  '--context',
  '-j',
  '--threads',
  '-M',
  '--max-columns',
  '-d',
  '--max-depth',
  '--maxdepth',
  '-E',
  '--encoding',
  '--max-filesize',
  '--sort',
  '--sortr',
  '-r',
  '--replace',
  '--colors',
  '--path-separator',
  '--type-add',
  '--type-clear',
  '--engine',
  '--ignore-file',
  '-f',
  '--file',
];

const AG_VALUES = [
  '-G',
  '--file-search-regex',
  '-m',
  '--max-count',
  '-A',
  '--after',
  '-B',
  '--before',
  '-C',
  '--context',
  '--depth',
  '--ignore',
  '--ignore-dir',
  '--type',
  '-W',
  '--width',
];

const SEARCH_RULES: Record<string, FlagRules> = {
  grep: { values: GREP_VALUES, deny: ['-f', '--file', '--exclude-from'] },
  rg: {
    values: RG_VALUES,
    // `--pre` and `--hostname-bin` run a program; `-z` decompresses through one.
    deny: ['--pre', '--pre-glob', '--search-zip', '-z', '--hostname-bin'],
    paths: ['--ignore-file', '-f', '--file'],
  },
  ag: {
    values: AG_VALUES,
    // `--pager` runs a program; `-p` reads an ignore file and `-g` makes every operand a path.
    deny: ['--pager', '-p', '--path-to-ignore', '-g'],
  },
};
SEARCH_RULES.egrep = SEARCH_RULES.grep!;
SEARCH_RULES.fgrep = SEARCH_RULES.grep!;

/** The options that supply the pattern, so that every operand is a path. */
const PATTERN_OPTIONS = ['-e', '--regexp'];
/** `rg -f FILE` reads its patterns from a file, which then names no pattern operand. */
const RG_PATTERN_OPTIONS = [...PATTERN_OPTIONS, '-f', '--file'];

/** `grep PATTERN PATH...`, or `-e PATTERN` and then only paths. */
function grepLikeParts(
  parsed: ParsedArgs,
  patternOptions: readonly string[] = PATTERN_OPTIONS,
): ReadOnlyShellPart[] {
  const patterns = parsed.flags.filter((flag) => patternOptions.includes(flag.name));
  const named = patterns.find((flag) => PATTERN_OPTIONS.includes(flag.name));
  const query = patterns.length > 0 ? named?.value : parsed.operands[0];
  const paths = patterns.length > 0 ? parsed.operands : parsed.operands.slice(1);
  return [pathsPart('search', [...paths, ...parsed.flagPaths], query)];
}

function rgParts(args: readonly string[]): ReadOnlyShellPart[] | undefined {
  const parsed = parseArgs(args, SEARCH_RULES.rg);
  if (!parsed) return undefined;
  if (parsed.flags.some((f) => f.name === '--files')) {
    return [pathsPart('list', [...parsed.operands, ...parsed.flagPaths])];
  }
  return grepLikeParts(parsed, RG_PATTERN_OPTIONS);
}

const FIND_DENY = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
  // Reads the names of the files to search from a file.
  '-files0-from',
]);
/** Tests that compare with a file named by the next word: `-newer FILE`, `-newerXY FILE`. */
const FIND_FILE_TESTS = /^-(?:newer|anewer|cnewer|samefile|newer[aBcm][aBcmt])$/;
const FIND_QUERY_TESTS = new Set([
  '-name',
  '-iname',
  '-path',
  '-ipath',
  '-wholename',
  '-iwholename',
  '-regex',
  '-iregex',
]);

function findParts(args: readonly string[]): ReadOnlyShellPart[] | undefined {
  if (args.some((arg) => FIND_DENY.has(arg))) return undefined;
  let i = 0;
  while (args[i] === '-H' || args[i] === '-L' || args[i] === '-P') i += 1;
  // `-D opts` and `-O3` come before the start points and would hide them from this scan.
  if (/^-[DO]/.test(args[i] ?? '')) return undefined;
  const paths: string[] = [];
  while (i < args.length && !/^(?:-.|[!(),])/.test(args[i]!)) {
    paths.push(args[i]!);
    i += 1;
  }
  const expression = args.slice(i);
  const test = expression.findIndex((arg) => FIND_QUERY_TESTS.has(arg));
  const query = test >= 0 ? expression[test + 1] : undefined;
  for (const [index, arg] of expression.entries()) {
    if (!FIND_FILE_TESTS.test(arg)) continue;
    const file = expression[index + 1];
    if (file === undefined) return undefined;
    paths.push(file);
  }
  return [pathsPart('search', paths, query)];
}

const FD_RULES: FlagRules = {
  values: [
    '-t',
    '--type',
    '-e',
    '--extension',
    '-E',
    '--exclude',
    '-d',
    '--max-depth',
    '--min-depth',
    '--exact-depth',
    '-c',
    '--color',
    '-j',
    '--threads',
    '-S',
    '--size',
    '--changed-within',
    '--changed-before',
    '-o',
    '--owner',
    '--ignore-file',
    '--search-path',
    '--base-directory',
  ],
  paths: ['--ignore-file', '--search-path', '--base-directory'],
  // `-l` is `--exec-batch ls -l`.
  deny: ['-x', '-X', '--exec', '--exec-batch', '-l', '--list-details'],
};

function isPathish(word: string): boolean {
  return word === '.' || word === '..' || /[\\/]/.test(word);
}

function fdParts(args: readonly string[]): ReadOnlyShellPart[] | undefined {
  const parsed = parseArgs(args, FD_RULES);
  if (!parsed) return undefined;
  const [first, ...rest] = parsed.operands;
  let query: string | undefined;
  let paths: string[];
  if (first !== undefined && rest.length === 0 && isPathish(first)) paths = [first];
  else {
    query = first;
    paths = rest;
  }
  return [pathsPart('search', [...paths, ...parsed.flagPaths], query)];
}

// --- List ---------------------------------------------------------------

const LIST_RULES: Record<string, FlagRules> = {
  ls: {
    values: [
      '-I',
      '--ignore',
      '-w',
      '--width',
      '-T',
      '--tabsize',
      '--block-size',
      '--time-style',
      '--sort',
      '--format',
      '--hide',
    ],
  },
  tree: {
    values: ['-L', '-P', '-I', '--charset', '--filelimit', '--sort', '--timefmt'],
    // `tree -o FILE` writes the listing to a file; the others read one.
    deny: ['-o', '--output', '--fromfile', '--fromtabfile', '--gitfile'],
  },
  eza: { values: ['-L', '--level', '-I', '--ignore-glob', '-s', '--sort', '--time-style'] },
  du: {
    values: [
      '-d',
      '--max-depth',
      '-B',
      '--block-size',
      '--exclude',
      '-t',
      '--threshold',
      '--time-style',
    ],
    // These read the names or patterns to use from a file.
    deny: ['--files0-from', '-X', '--exclude-from'],
  },
};
LIST_RULES.exa = LIST_RULES.eza!;

function listParts(args: readonly string[], rules: FlagRules): ReadOnlyShellPart[] | undefined {
  const parsed = parseArgs(args, rules);
  return parsed ? [pathsPart('list', [...parsed.operands, ...parsed.flagPaths])] : undefined;
}

// --- Git ----------------------------------------------------------------

/** The options git takes before the subcommand that are safe: `-C <dir>` is handled apart. */
const GIT_GLOBAL_FLAGS: ReadonlySet<string> = new Set(['--no-pager', '-P', '--no-optional-locks']);

/**
 * Options that write a file (`--output`, `-O<orderfile>` reads one), run a program
 * (`--ext-diff`, `--show-signature`, `git grep -O` / `--open-files-in-pager`), on any
 * subcommand. A long name also matches its abbreviations.
 */
const GIT_DENY = ['--output', '-O', '--open-files-in-pager', '--ext-diff', '--show-signature'];

/**
 * Every `git branch` form that creates, deletes, renames, copies or configures a branch,
 * or opens an editor. What is left, with no positional name, only lists.
 */
const GIT_BRANCH_DENY = [
  ...GIT_DENY,
  '-d',
  '-D',
  '-m',
  '-M',
  '-c',
  '-C',
  '-u',
  '-f',
  '-t',
  '--delete',
  '--move',
  '--copy',
  '--set-upstream',
  '--set-upstream-to',
  '--unset-upstream',
  '--edit-description',
  '--force',
  '--track',
  '--no-track',
];

/** Branch options whose value is optional: the last word of a command may leave it out. */
const GIT_BRANCH_OPTIONAL_VALUE = new Set([
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
]);

/** A branch name is a positional operand; only `--list` turns it into a pattern. */
function gitBranchOnlyLists(_args: readonly string[], parsed: ParsedArgs): boolean {
  return parsed.operands.length === 0 || parsed.flags.some((flag) => flag.name === '--list');
}

const GIT_RULES: Record<string, FlagRules> = {
  status: { deny: GIT_DENY },
  log: {
    values: [
      '-n',
      '--max-count',
      '--skip',
      '--since',
      '--until',
      '--after',
      '--before',
      '--author',
      '--committer',
      '--grep',
      '-L',
    ],
    // `-L <start>,<end>:<file>` names a file.
    paths: ['-L'],
    deny: GIT_DENY,
  },
  diff: { deny: GIT_DENY },
  show: { deny: GIT_DENY },
  grep: {
    values: [
      '-e',
      '-f',
      '-A',
      '-B',
      '-C',
      '-m',
      '--max-count',
      '--max-depth',
      '--threads',
      '--context',
      '--after-context',
      '--before-context',
    ],
    // `-f <file>` reads the patterns from a file.
    paths: ['-f'],
    deny: GIT_DENY,
  },
  'ls-files': {
    values: [
      '-x',
      '--exclude',
      '-X',
      '--exclude-from',
      '--exclude-per-directory',
      '--with-tree',
      '--format',
    ],
    paths: ['-X', '--exclude-from'],
    deny: GIT_DENY,
  },
  branch: {
    values: [
      '--contains',
      '--no-contains',
      '--merged',
      '--no-merged',
      '--points-at',
      '--sort',
      '--format',
    ],
    deny: GIT_BRANCH_DENY,
    check: gitBranchOnlyLists,
  },
};

const REVISION_NAME = /^(?:@|[A-Z_]*HEAD|[0-9a-f]{7,40})$/;

/**
 * Whether an operand before `--` is one a revision can be told by: `HEAD~2`, `main..feature`,
 * `<rev>:<path>`, `HEAD`, a commit id. It must not be able to name a path outside the
 * workspace (absolute, a `..` segment, a glob) whatever it means to git. Anything else is
 * ambiguous, and an ambiguous operand is a path.
 */
function isRevisionLike(operand: string): boolean {
  if (isAbsolute(operand) || GLOB_CHARS.test(operand)) return false;
  if (operand.split(/[\\/]/).includes('..')) return false;
  return REVISION_NAME.test(operand) || /[~^@:]/.test(operand) || operand.includes('..');
}

/**
 * Read-only `git`: global options (`-C <dir>`, `--no-pager`, `-P`, `--no-optional-locks`),
 * one of the listed subcommands, and no option that writes or runs a program. `-C` is a path,
 * and so is every operand that could name a file; the operands are resolved against the
 * `-C` directory, which is where git reads them from.
 */
function gitParts(args: readonly string[]): ReadOnlyShellPart[] | undefined {
  const dirs: string[] = [];
  let cwd: string | undefined;
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '-C') {
      const dir = args[index + 1];
      if (dir === undefined) return undefined;
      cwd = cwd === undefined || isAbsolute(dir) ? dir : join(cwd, dir);
      dirs.push(cwd);
      index += 1;
    } else if (!GIT_GLOBAL_FLAGS.has(arg)) {
      break;
    }
  }
  const subcommand = args[index];
  if (subcommand === undefined || subcommand.startsWith('-')) return undefined;
  const rules = lookup(GIT_RULES, subcommand);
  if (!rules) return undefined;

  let rest = args.slice(index + 1);
  const last = rest[rest.length - 1];
  if (subcommand === 'branch' && last !== undefined && GIT_BRANCH_OPTIONAL_VALUE.has(last)) {
    rest = rest.slice(0, -1);
  }
  const parsed = parseArgs(rest, rules);
  if (!parsed) return undefined;

  // `git grep PATTERN`: the first operand before `--` is the pattern, unless `-e` or `-f` gave it.
  let query: string | undefined;
  let skip = 0;
  if (subcommand === 'grep') {
    const patterns = parsed.flags.filter((flag) => flag.name === '-e' || flag.name === '-f');
    if (patterns.length > 0) query = patterns.find((flag) => flag.name === '-e')?.value;
    else if (parsed.beforeDashes >= 1) {
      query = parsed.operands[0];
      skip = 1;
    }
  }

  const candidates: string[] = [];
  // A branch operand is a ref pattern for `--list`, never a path.
  const operands = subcommand === 'branch' ? [] : parsed.operands;
  for (const [position, operand] of operands.entries()) {
    if (position < skip) continue;
    // Pathspec magic (`:/`, `:(top)`, `:!x`) and index blobs (`:0:path`) reach past the
    // working directory, and an index stage is not a revision.
    if (operand.startsWith(':')) return undefined;
    if (position >= parsed.beforeDashes || !isRevisionLike(operand)) {
      candidates.push(operand);
      continue;
    }
    // `<rev>:<path>` names a path in that revision, relative to the directory.
    const colon = operand.indexOf(':');
    if (colon >= 0 && colon < operand.length - 1) candidates.push(operand.slice(colon + 1));
  }

  const at = (path: string) => (cwd === undefined || isAbsolute(path) ? path : join(cwd, path));
  const paths = [...dirs, ...candidates.map(at), ...parsed.flagPaths.map(at)];
  if (subcommand === 'grep') return [pathsPart('search', paths, query)];
  if (subcommand === 'ls-files') return [pathsPart('list', paths)];
  return [{ kind: 'lookup', target: `git ${subcommand}`, ...whereParts(paths) }];
}

// --- Formatters ---------------------------------------------------------

const FORMATTER_RULES: Record<string, FlagRules> = {
  wc: READ_RULES.wc!,
  sort: {
    values: ['-k', '-t', '-S', '--key', '--field-separator', '--buffer-size'],
    // `-o FILE` writes the result to a file; `--compress-program` runs a program; the rest
    // read or write a file or directory named by their value.
    deny: [
      '-o',
      '--output',
      '--compress-program',
      '--files0-from',
      '-T',
      '--temporary-directory',
      '--random-source',
    ],
  },
  uniq: { values: ['-f', '-s', '-w', '--skip-fields', '--skip-chars', '--check-chars'] },
  head: READ_RULES.head!,
  tail: READ_RULES.tail!,
  cut: {
    values: [
      '-b',
      '-c',
      '-d',
      '-f',
      '--bytes',
      '--characters',
      '--delimiter',
      '--fields',
      '--output-delimiter',
    ],
  },
  column: {
    values: [
      '-s',
      '-o',
      '-c',
      '-N',
      '-R',
      '-n',
      '-W',
      '-O',
      '--separator',
      '--output-separator',
      '--output-width',
    ],
  },
  nl: READ_RULES.nl!,
  cat: {},
  tr: {},
};

/**
 * Whether a segment only reshapes its standard input. Such a segment, after the
 * first one of a pipeline, is dropped from the summary. One that names a file
 * operand reads that file instead of stdin, so it is not a formatter.
 */
function isFormatter(words: readonly string[]): boolean {
  const [cmd, ...args] = words;
  const rules = lookup(FORMATTER_RULES, cmd);
  if (!rules) return false;
  const parsed = parseArgs(args, rules);
  if (!parsed) return false;
  // `tr` takes its character sets as operands; everything else must have none.
  return cmd === 'tr'
    ? parsed.operands.length >= 1 && parsed.operands.length <= 2
    : parsed.operands.length === 0;
}

// --- Segments -----------------------------------------------------------

function classifySegment(words: readonly string[]): ReadOnlyShellPart[] | undefined {
  const [cmd, ...args] = words;
  if (cmd === undefined) return undefined;
  if (cmd === 'git') return gitParts(args);
  if (cmd === 'sed') return sedParts(args);
  if (cmd === 'rg') return rgParts(args);
  if (cmd === 'find') return findParts(args);
  if (cmd === 'fd' || cmd === 'fdfind') return fdParts(args);
  if (cmd === 'pwd') {
    const parsed = parseArgs(args);
    return parsed && parsed.operands.length === 0 ? [{ kind: 'list' }] : undefined;
  }
  const read = lookup(READ_RULES, cmd);
  if (read) return readParts(args, read);
  const search = lookup(SEARCH_RULES, cmd);
  if (search) {
    const parsed = parseArgs(args, search);
    return parsed ? grepLikeParts(parsed) : undefined;
  }
  const list = lookup(LIST_RULES, cmd);
  if (list) return listParts(args, list);
  return undefined;
}

/**
 * Classify a whole shell command, or return undefined unless every part of it is
 * read-only. The parts are what the command reads, searches and lists, in order,
 * with stdin formatters dropped.
 */
export function classifyReadOnlyShellCommand(command: string): ReadOnlyShellPart[] | undefined {
  const trimmed = command.trim();
  // A newline separates commands, and one inside quotes can smuggle a script.
  if (trimmed === '' || /[\r\n]/.test(trimmed)) return undefined;
  const tokens = tokenize(trimmed);
  if (!tokens) return undefined;
  const segments = splitSegments(tokens);
  if (!segments) return undefined;

  const parts: ReadOnlyShellPart[] = [];
  for (const segment of segments) {
    if (segment.after === '|' && isFormatter(segment.words)) continue;
    const segmentParts = classifySegment(segment.words);
    if (!segmentParts) return undefined;
    parts.push(...segmentParts);
  }
  return shellCommandPaths(parts).some(globMayReachParent) ? undefined : parts;
}
