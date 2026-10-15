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
 * `undefined` is always the safe answer: the command then keeps its own row.
 * Anything not named here, a command or a flag, is therefore "not read-only".
 *
 * The shape follows OpenAI Codex's `parse_command.rs` (Apache-2.0): reads,
 * searches and listings, small stdin formatters dropped from a pipeline.
 */

export type ReadOnlyShellPart =
  | { kind: 'read'; path: string }
  | { kind: 'search'; query?: string; path?: string; extraPaths?: string[] }
  | { kind: 'list'; path?: string; extraPaths?: string[] };

/** Every path a classification names, for the caller's workspace-containment check. */
export function shellCommandPaths(parts: readonly ReadOnlyShellPart[]): string[] {
  return parts.flatMap((part) =>
    part.kind === 'read'
      ? [part.path]
      : [...(part.path !== undefined ? [part.path] : []), ...(part.extraPaths ?? [])],
  );
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
}

interface ParsedArgs {
  flags: Flag[];
  /** Every non-option word, including those after `--`. */
  operands: string[];
  /** The words after `--`, which are always paths for the git tools. */
  afterDashes: string[];
}

function isDenied(flag: Flag, deny: readonly string[]): boolean {
  return deny.some((entry) =>
    entry.startsWith('--')
      ? // getopt-style tools accept any unambiguous prefix of a long option.
        flag.name.startsWith('--') && flag.name.length >= 3 && entry.startsWith(flag.name)
      : flag.name === entry,
  );
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
  const afterDashes: string[] = [];
  let dashes = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (dashes) {
      operands.push(arg);
      afterDashes.push(arg);
    } else if (arg === '--') {
      dashes = true;
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
  if (flags.some((flag) => isDenied(flag, deny))) return undefined;
  return { flags, operands, afterDashes };
}

function pathsPart(
  kind: 'search' | 'list',
  paths: readonly string[],
  query?: string,
): ReadOnlyShellPart {
  const [first, ...rest] = paths;
  const where = {
    ...(first !== undefined ? { path: first } : {}),
    ...(rest.length > 0 ? { extraPaths: rest } : {}),
  };
  if (kind === 'list') return { kind, ...where };
  return { kind, ...(query !== undefined ? { query } : {}), ...where };
}

/** An own-property lookup, so a word like `constructor` is never a table hit. */
function lookup<T>(table: Record<string, T>, key: string | undefined): T | undefined {
  return key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

/** A word that names somewhere outside the directory the command runs in. */
function lexicallyEscapes(word: string): boolean {
  return (
    /^[\\/~]/.test(word) || /^[A-Za-z]:/.test(word) || word.split(/[\\/]/).some((s) => s === '..')
  );
}

// --- Read ---------------------------------------------------------------

const HEAD_TAIL_VALUES = ['-n', '-c', '--lines', '--bytes'];

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
    deny: ['--pager'],
  },
  head: { values: HEAD_TAIL_VALUES },
  tail: { values: HEAD_TAIL_VALUES, deny: ['-f', '-F', '--follow'] },
  nl: { values: ['-b', '-d', '-f', '-h', '-i', '-l', '-n', '-s', '-v', '-w'] },
  wc: { deny: ['--files0-from'] },
  file: {
    values: ['-m', '--magic-file', '-P', '--parameter', '-e', '--exclude'],
    deny: ['-f', '-C', '--files-from', '--compile'],
  },
  stat: { values: ['-c', '--format', '--printf'] },
};
READ_RULES.batcat = READ_RULES.bat!;

function readParts(args: readonly string[], rules: FlagRules): ReadOnlyShellPart[] | undefined {
  const parsed = parseArgs(args, rules);
  if (!parsed || parsed.operands.length === 0) return undefined;
  return parsed.operands.map((path) => ({ kind: 'read', path }));
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
];

const AG_ACK_VALUES = [
  '-G',
  '--file-search-regex',
  '-g',
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
    deny: ['--pre', '--pre-glob', '--search-zip', '-z', '-f', '--file', '--hostname-bin'],
  },
  ag: { values: AG_ACK_VALUES, deny: ['--pager'] },
  ack: { values: AG_ACK_VALUES, deny: ['--pager'] },
};

const GIT_GREP_RULES: FlagRules = {
  values: ['-e', '-A', '-B', '-C', '-m', '--max-count', '--max-depth', '-j', '--threads'],
  deny: ['-f', '-O', '--open-files-in-pager', '--no-index'],
};
SEARCH_RULES.egrep = SEARCH_RULES.grep!;
SEARCH_RULES.fgrep = SEARCH_RULES.grep!;

/** `grep PATTERN PATH...`, or `-e PATTERN` and then only paths. */
function grepLikeParts(
  args: readonly string[],
  rules: FlagRules,
  options: { checkEscapes?: boolean } = {},
): ReadOnlyShellPart[] | undefined {
  const parsed = parseArgs(args, rules);
  if (!parsed) return undefined;
  if (options.checkEscapes && parsed.operands.some(lexicallyEscapes)) return undefined;
  const patterns = parsed.flags.filter((f) => f.name === '-e' || f.name === '--regexp');
  const query = patterns.length > 0 ? patterns[0]!.value : parsed.operands[0];
  const paths = patterns.length > 0 ? parsed.operands : parsed.operands.slice(1);
  return [pathsPart('search', paths, query)];
}

function rgParts(args: readonly string[]): ReadOnlyShellPart[] | undefined {
  const parsed = parseArgs(args, SEARCH_RULES.rg);
  if (!parsed) return undefined;
  if (parsed.flags.some((f) => f.name === '--files')) {
    return [pathsPart('list', parsed.operands)];
  }
  return grepLikeParts(args, SEARCH_RULES.rg!);
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
]);
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
  const paths: string[] = [];
  while (i < args.length && !/^(?:-.|[!(),])/.test(args[i]!)) {
    paths.push(args[i]!);
    i += 1;
  }
  const expression = args.slice(i);
  const test = expression.findIndex((arg) => FIND_QUERY_TESTS.has(arg));
  const query = test >= 0 ? expression[test + 1] : undefined;
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
  deny: ['-x', '-X', '--exec', '--exec-batch'],
};

function isPathish(word: string): boolean {
  return word === '.' || word === '..' || /[\\/]/.test(word);
}

function fdParts(args: readonly string[]): ReadOnlyShellPart[] | undefined {
  const parsed = parseArgs(args, FD_RULES);
  if (!parsed) return undefined;
  const flagPaths = parsed.flags
    .filter((f) => f.name === '--search-path' || f.name === '--base-directory')
    .map((f) => f.value!);
  const [first, ...rest] = parsed.operands;
  let query: string | undefined;
  let paths: string[];
  if (first !== undefined && rest.length === 0 && isPathish(first)) paths = [first];
  else {
    query = first;
    paths = rest;
  }
  return [pathsPart('search', [...paths, ...flagPaths], query)];
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
    // `tree -o FILE` writes the listing to a file.
    deny: ['-o', '--output'],
  },
  eza: { values: ['-L', '--level', '-I', '--ignore-glob', '-s', '--sort', '--time-style'] },
  du: { values: ['-d', '--max-depth', '-B', '--block-size', '--exclude', '-t', '--threshold'] },
};
LIST_RULES.exa = LIST_RULES.eza!;

function listParts(args: readonly string[], rules: FlagRules): ReadOnlyShellPart[] | undefined {
  const parsed = parseArgs(args, rules);
  return parsed ? [pathsPart('list', parsed.operands)] : undefined;
}

// --- Git ----------------------------------------------------------------

const GIT_VALUES = [
  '-U',
  '--unified',
  '-S',
  '-G',
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
  '--diff-filter',
];

const GIT_RULES: Record<string, FlagRules> = {
  status: {},
  diff: { values: GIT_VALUES, deny: ['--output', '--ext-diff', '--no-index', '-O'] },
  log: { values: GIT_VALUES, deny: ['--output'] },
  show: { values: GIT_VALUES, deny: ['--output', '--ext-diff'] },
  'rev-parse': {},
  'ls-files': {},
};

const GIT_BRANCH_FLAGS = new Set([
  '-a',
  '-r',
  '-v',
  '--list',
  '--show-current',
  '--all',
  '--remotes',
]);

/**
 * Read-only git subcommands. A global option before the subcommand (`-c`, `-C`,
 * `--git-dir`) can redirect the command or run a program, so none is accepted.
 * Operands may be revisions or paths, so any that names somewhere outside the
 * directory is refused outright.
 */
function gitParts(args: readonly string[]): ReadOnlyShellPart[] | undefined {
  const [sub, ...rest] = args;
  if (sub === undefined || sub.startsWith('-')) return undefined;
  if (sub === 'grep') return grepLikeParts(rest, GIT_GREP_RULES, { checkEscapes: true });
  if (sub === 'branch') {
    const parsed = parseArgs(rest, { deny: [] });
    if (!parsed || parsed.operands.length > 0) return undefined;
    if (parsed.flags.some((flag) => !GIT_BRANCH_FLAGS.has(flag.name))) return undefined;
    return [{ kind: 'list' }];
  }
  if (sub === 'blame') {
    const parsed = parseArgs(rest, {
      values: ['-L'],
      deny: ['--contents', '-S', '--ignore-revs-file', '--output'],
    });
    if (!parsed || parsed.operands.length === 0 || parsed.operands.some(lexicallyEscapes)) {
      return undefined;
    }
    return [{ kind: 'read', path: parsed.afterDashes[0] ?? parsed.operands.at(-1)! }];
  }
  const rules = lookup(GIT_RULES, sub);
  if (!rules) return undefined;
  const parsed = parseArgs(rest, rules);
  if (!parsed || parsed.operands.some(lexicallyEscapes)) return undefined;
  return [pathsPart('list', parsed.afterDashes)];
}

// --- Formatters ---------------------------------------------------------

const FORMATTER_RULES: Record<string, FlagRules> = {
  wc: { deny: ['--files0-from'] },
  sort: {
    values: [
      '-k',
      '-t',
      '-S',
      '-T',
      '--key',
      '--field-separator',
      '--buffer-size',
      '--temporary-directory',
    ],
    // `-o FILE` writes the result to a file; `--compress-program` runs a program.
    deny: ['-o', '--output', '--compress-program', '--files0-from'],
  },
  uniq: { values: ['-f', '-s', '-w', '--skip-fields', '--skip-chars', '--check-chars'] },
  head: { values: HEAD_TAIL_VALUES },
  tail: { values: HEAD_TAIL_VALUES, deny: ['-f', '-F', '--follow'] },
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
  if (search) return grepLikeParts(args, search);
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
  return parts;
}
