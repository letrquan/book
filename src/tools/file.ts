import { open, readFile as readTextFile, stat } from 'fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { basename, extname } from 'node:path';
import fg from 'fast-glob';
import type { ToolDefinition, ToolContext, ToolResult } from '../types/tools.js';
import { throwIfAborted, yieldToEventLoop } from '../async.js';
import { markdownContentStart } from '../frontmatter.js';
import { renderDiffWithStatsAsync } from './diff.js';
import { findRelaxedMatch } from './fuzzy-match.js';
import {
  pathOutsideWorkspaceResult,
  resolveReadablePath,
  resolveWorkspacePath,
} from './path-utils.js';
import {
  observeFile,
  requireFreshObservation,
  requireObservationForMutation,
} from './file-provenance.js';
import { TOOL_RESULT_MAX_BYTES, toolFailure, toolSuccess, utf8Prefix } from './result.js';
import {
  readTextSnapshot,
  restoreTextEncoding,
  withMutationLocks,
  writeFileAtomically,
} from './mutation.js';

const GLOB_OUTPUT_LIMIT = 1000;
const PATH_YIELD_INTERVAL = 128;
const LINE_YIELD_INTERVAL = 2_048;
// Every tool result over TOOL_RESULT_MAX_BYTES is clipped, with a notice that
// points at a file Read cannot open. A Read stops short of that clip instead,
// leaving room for its header and for the notice that names where to continue.
const READ_NOTICE_RESERVE_BYTES = 512;
const READ_OUTPUT_MAX_BYTES = TOOL_RESULT_MAX_BYTES - READ_NOTICE_RESERVE_BYTES;
const GREP_MATCH_LIMIT = 100;
const GREP_LINE_MAX_CHARS = 2_000;
const GREP_OUTPUT_MAX_BYTES = 50 * 1024;
const GREP_OUTPUT_NOTICE_RESERVE_BYTES = 256;
const GREP_BINARY_SAMPLE_BYTES = 8 * 1024;
const GREP_DEFAULT_IGNORES = [
  '**/.git/**',
  '**/.book/tool-output/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/coverage/**',
  '**/bin/**',
  '**/obj/**',
];
const GREP_BINARY_EXTENSIONS = new Set([
  '.7z',
  '.a',
  '.bin',
  '.bmp',
  '.class',
  '.dll',
  '.dylib',
  '.eot',
  '.exe',
  '.gif',
  '.gz',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.lib',
  '.mp3',
  '.mp4',
  '.o',
  '.obj',
  '.otf',
  '.pdf',
  '.png',
  '.so',
  '.tar',
  '.ttf',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
]);

function clipGrepText(text: string): string {
  if (text.length <= GREP_LINE_MAX_CHARS) return text;
  return `${text.slice(0, GREP_LINE_MAX_CHARS - 24)}... [line truncated]`;
}

async function isBinaryFile(filePath: string): Promise<boolean> {
  if (GREP_BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())) return true;

  const handle = await open(filePath, 'r');
  try {
    const sample = Buffer.allocUnsafe(GREP_BINARY_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(sample, 0, sample.byteLength, 0);
    if (bytesRead === 0) return false;
    let controlBytes = 0;
    for (let index = 0; index < bytesRead; index++) {
      const byte = sample[index];
      if (byte === 0) return true;
      if (byte < 7 || (byte > 13 && byte < 32)) controlBytes++;
    }
    return controlBytes / bytesRead > 0.1;
  } finally {
    await handle.close();
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

const EDIT_NOT_FOUND_REMEDIATION =
  'oldString must match the file content exactly, including whitespace and indentation. Do not ' +
  'include the "N: " line-number prefixes from Read output. If the file may have changed, Read ' +
  'it again and rebuild oldString from the actual content.';

interface GrepScope {
  /** Workspace-relative scope with forward slashes ('' = workspace root). */
  relativePath: string;
  absolutePath: string;
  isFile: boolean;
}

type GrepScopeResolution = { ok: true; scope: GrepScope } | { ok: false; failure: ToolResult };

async function resolveGrepScope(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<GrepScopeResolution> {
  const raw = args.path as string | undefined;
  if (!raw || raw === '.') {
    return {
      ok: true,
      scope: { relativePath: '', absolutePath: ctx.workspaceRoot, isFile: false },
    };
  }
  const resolved = resolveWorkspacePath(ctx.workspaceRoot, raw);
  if (!resolved) return { ok: false, failure: pathOutsideWorkspaceResult(raw) };
  try {
    const info = await stat(resolved.filePath);
    return {
      ok: true,
      scope: {
        relativePath: resolved.relativePath,
        absolutePath: resolved.filePath,
        isFile: info.isFile(),
      },
    };
  } catch {
    return {
      ok: false,
      failure: toolFailure(`Path not found: ${raw}`, {
        code: 'path_not_found',
        remediation: 'Pass an existing file or directory inside the workspace, or omit path.',
      }),
    };
  }
}

function grepContextWindow(args: Record<string, unknown>): { before: number; after: number } {
  const bound = (value: unknown): number => Math.max(0, Math.floor((value as number) ?? 0));
  const both = bound(args.C);
  return { before: Math.max(bound(args.B), both), after: Math.max(bound(args.A), both) };
}

async function countOccurrences(
  source: string,
  needle: string,
  signal?: AbortSignal,
): Promise<number> {
  if (needle.length === 0) return 0;

  let count = 0;
  let index = source.indexOf(needle);
  while (index !== -1) {
    count++;
    index = source.indexOf(needle, index + needle.length);
    if (count % LINE_YIELD_INTERVAL === 0) await yieldToEventLoop(signal);
  }
  return count;
}

export type EditApplication =
  { ok: true; content: string; note?: string } | { ok: false; failure: ToolResult };

/**
 * Apply one oldString→newString replacement: exact first, then the
 * whitespace-tolerant ladder (unique matches only, never for replaceAll).
 */
export async function applySingleEdit(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
  signal: AbortSignal | undefined,
  editLabel: string,
  atomicSuffix: string,
): Promise<EditApplication> {
  if (content.includes(oldStr)) {
    const occurrences = await countOccurrences(content, oldStr, signal);
    if (occurrences > 1 && !replaceAll) {
      return {
        ok: false,
        failure: toolFailure(
          `${editLabel}oldString matches ${occurrences} times; set replaceAll: true to replace all, or make oldString more specific${atomicSuffix}`,
          { code: 'ambiguous_text_match' },
        ),
      };
    }
    if (replaceAll) return { ok: true, content: content.split(oldStr).join(newStr) };
    // Splice manually: String.replace would interpret `$` patterns in newStr.
    const matchIndex = content.indexOf(oldStr);
    return {
      ok: true,
      content: content.slice(0, matchIndex) + newStr + content.slice(matchIndex + oldStr.length),
    };
  }
  if (!replaceAll) {
    const relaxed = await findRelaxedMatch(content, oldStr, newStr, signal);
    if (relaxed.status === 'found') {
      const { start, end, replacement, rung } = relaxed.match;
      return {
        ok: true,
        content: content.slice(0, start) + replacement + content.slice(end),
        note: `${editLabel}oldString matched with whitespace tolerance (${rung}).`,
      };
    }
    if (relaxed.status === 'ambiguous') {
      return {
        ok: false,
        failure: toolFailure(
          `${editLabel}oldString matches ${relaxed.count} locations under whitespace-tolerant matching; make oldString more specific${atomicSuffix}`,
          { code: 'ambiguous_text_match', remediation: EDIT_NOT_FOUND_REMEDIATION },
        ),
      };
    }
  }
  return {
    ok: false,
    failure: toolFailure(`${editLabel}oldString not found in file${atomicSuffix}`, {
      code: 'text_not_found',
      remediation: EDIT_NOT_FOUND_REMEDIATION,
    }),
  };
}

/**
 * The lines of a file that a survey is after, each with its line number, so the
 * model can decide what to read in full without paying for the whole file
 * (#217). Markdown is outlined by its headings, and JSON by its top-level keys.
 * Anything else: a line at indentation zero that is not blank, closing
 * punctuation or a comment is a declaration in most languages this tool sees,
 * and a shallowly indented declaration line is the next tier. Bodies stay out:
 * nothing deeper than `OUTLINE_MAX_INDENT` is shown. The shapes each language
 * gets are the "outline contract" table in file.test.ts; a shape outside it is
 * not promised.
 */
const OUTLINE_MAX_INDENT = 4;
/** A C# file with a block-scoped `namespace X {` indents every member one level deeper. */
const OUTLINE_MAX_INDENT_CSHARP_BLOCK_NAMESPACE = 8;
/** An outline is capped at the line count of a whole-file Read. */
const OUTLINE_MAX_ENTRIES = 2000;
/** An entry longer than this, such as a minified line, is cut and ends with `…`. */
const OUTLINE_ENTRY_MAX_BYTES = 512;
/** How far below a wrapped signature its closing `)` line is looked for. */
const OUTLINE_SIGNATURE_LOOKAHEAD = 40;
const OUTLINE_MODIFIERS =
  '(?:(?:export|public|private|protected|internal|static|async|abstract|override|virtual|sealed|partial|readonly|final|pub|open|suspend|inline|operator|infix|data|inner|synchronized|native|default|extern|unsafe)\\s+)*';
// Annotations and attributes on the declaration's own line:
// `@Override public String toString() {`, `@HostListener('click') onClick() {`,
// `[HttpGet] public IActionResult Get() {`.
const OUTLINE_ANNOTATIONS = '(?:(?:@[A-Za-z_][\\w.]*(?:\\([^()]*\\))?|\\[[^\\[\\]]*\\])\\s+)*';
/**
 * Where each place a statement word rules a line out:
 * - `call`: as the name of a method written name first, with or without a
 *   space before its `(` (`if (x) {`, `return (a) => {`), and as the name after
 *   a return type;
 * - `spaced`: as that name only with a space before the `(`, since a
 *   JavaScript method may be called `using()`, `lock()` or `match(pattern)`
 *   (`using (var s = open())`, `when (x) {`, `with (o) {`);
 * - `reserved`: as that name in Java and C#, space or not, where a method
 *   written name first is a constructor (`foreach(var x in xs)`, `lock(_gate)`);
 * - `type`: where a return type would stand (`else if (`, `return new Foo(`,
 *   `go func() {`, Rust's `match parse(x) {`, Java's `assert isValid(x);`).
 */
type OutlineStatementPlace = 'call' | 'spaced' | 'reserved' | 'type';
/** Words that start a statement, and the places where each one does. */
const OUTLINE_STATEMENT_WORDS: Record<string, readonly OutlineStatementPlace[]> = {
  if: ['call', 'type'],
  else: ['call', 'type'],
  elif: ['type'],
  for: ['call', 'type'],
  foreach: ['spaced', 'reserved', 'type'],
  while: ['call', 'type'],
  do: ['call', 'type'],
  switch: ['call', 'type'],
  case: ['type'],
  when: ['spaced', 'type'],
  match: ['spaced', 'type'],
  catch: ['call', 'type'],
  try: ['call', 'type'],
  finally: ['type'],
  return: ['call', 'type'],
  await: ['call', 'type'],
  async: ['call'],
  yield: ['type'],
  throw: ['type'],
  new: ['type'],
  delete: ['type'],
  typeof: ['type'],
  using: ['spaced', 'reserved', 'type'],
  lock: ['spaced', 'reserved', 'type'],
  fixed: ['spaced', 'reserved', 'type'],
  checked: ['spaced', 'reserved'],
  unchecked: ['spaced', 'reserved'],
  synchronized: ['spaced', 'reserved', 'type'],
  with: ['spaced', 'type'],
  go: ['type'],
  defer: ['type'],
  assert: ['type'],
};
function outlineStatementWords(place: OutlineStatementPlace): string {
  const words = Object.entries(OUTLINE_STATEMENT_WORDS)
    .filter(([, places]) => places.includes(place))
    .map(([word]) => word);
  return `(?:${words.join('|')})`;
}
const OUTLINE_STATEMENT_CALL = `${outlineStatementWords('call')}\\b`;
const OUTLINE_STATEMENT_SPACED = `${outlineStatementWords('spaced')}\\s`;
const OUTLINE_STATEMENT_RESERVED = `${outlineStatementWords('reserved')}\\b`;
const OUTLINE_STATEMENT_TYPE = `${outlineStatementWords('type')}\\b`;
// Type arguments nested up to three deep: `Map<String, List<Set<Integer>>>`.
const OUTLINE_GENERIC = '<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>';
const OUTLINE_TYPE = `[A-Za-z_$][\\w$.]*(?:${OUTLINE_GENERIC})?(?:\\[\\])*\\??`;
// A keyword declaration. A keyword followed by `:`, `,`, `;`, `=`, `?`, `)`,
// `.` or the end of the line is an object key, an import-list member or a
// property access (`set.add(x)`, `it.skip;`) instead.
const OUTLINE_KEYWORD = new RegExp(
  `^\\s+${OUTLINE_ANNOTATIONS}${OUTLINE_MODIFIERS}(?:function|class|interface|enum|namespace|def|func|fn|fun|struct|impl|trait|describe|it|test|constructor|get|set)\\b(?!\\s*[:,;=?).]|\\s*$)`,
);
// A test block reached through a modifier:
// `describe.each(cases)('x', …)`, `it.each<[number]>([[1]])('x', …)`.
const OUTLINE_TEST_CHAIN = new RegExp(
  `^\\s+(?:describe|it|test)(?:\\.[A-Za-z]+)+\\s*(?:${OUTLINE_GENERIC})?\\s*\\(`,
);
// A type whose members may sit deeper than OUTLINE_MAX_INDENT: a Java inner
// class, a nested C# class, an `impl` inside a Rust `mod`.
const OUTLINE_TYPE_DECLARATION = new RegExp(
  `^\\s*${OUTLINE_ANNOTATIONS}${OUTLINE_MODIFIERS}(?:class|interface|enum|record|struct|trait|impl|object|namespace)\\b(?!\\s*[:,;=?).]|\\s*$)`,
);
// A method named first: `name(`, `async *entries(`, `#secret(`, `map<K extends Record<string, V>>(`.
function outlineNameFirst(statement: string): RegExp {
  return new RegExp(
    `^\\s+${OUTLINE_ANNOTATIONS}${OUTLINE_MODIFIERS}(?!${statement})(?:\\*\\s*)?#?[A-Za-z_$][\\w$]*\\s*(?:${OUTLINE_GENERIC})?\\s*\\(`,
  );
}
const OUTLINE_NAME_FIRST = outlineNameFirst(
  `(?:${OUTLINE_STATEMENT_CALL}|${OUTLINE_STATEMENT_SPACED})`,
);
const OUTLINE_NAME_FIRST_JAVA_CSHARP = outlineNameFirst(
  `(?:${OUTLINE_STATEMENT_CALL}|${OUTLINE_STATEMENT_RESERVED}|${OUTLINE_STATEMENT_SPACED})`,
);
// A method whose return type comes first (Java, C#, Dart): `int getN(`,
// `public static <T> List<T> wrap(`, `Future<void> load(`.
const OUTLINE_TYPE_FIRST = new RegExp(
  `^\\s+${OUTLINE_ANNOTATIONS}${OUTLINE_MODIFIERS}(?:${OUTLINE_GENERIC}\\s+)?(?!${OUTLINE_STATEMENT_TYPE})${OUTLINE_TYPE}\\s+(?!${OUTLINE_STATEMENT_CALL})[A-Za-z_$][\\w$]*\\s*(?:${OUTLINE_GENERIC})?\\s*\\(`,
);
// A body on the method's own line: `public int get() { return n; }`,
// `record Point(int x, int y) {}`.
const OUTLINE_ONE_LINE_BODY = /^\s*(?:throws\s[^{;]*)?\{.*\}\s*;?\s*$/;
// C++: a member function or constructor with an optional return type (`int`,
// `static std::string`, `const std::vector<int>&`, `Foo*`), then its name: a
// destructor (`~Foo`), an operator, or a qualified name (`Foo::name`).
const CPP_TYPE_WORD = `(?:template\\s*${OUTLINE_GENERIC}\\s*)?[A-Za-z_][\\w:]*(?:${OUTLINE_GENERIC})?`;
const CPP_METHOD_HEAD = new RegExp(
  `^\\s+(?!${OUTLINE_STATEMENT_TYPE})(?:${CPP_TYPE_WORD}[\\s*&]+)*(?:[A-Za-z_]\\w*::)*(?:~?[A-Za-z_]\\w*|operator\\s*(?:\\(\\)|[^\\s(]+))\\s*\\(`,
);
// After a C++ member's parameter list: qualifiers, a qualifier macro such as
// `Q_DECL_OVERRIDE`, a trailing return type and `= 0`, `= default` or
// `= delete`, then `;`, a body on the line, `{`, a constructor's initializer
// list, or nothing (the body opens below).
const CPP_METHOD_TAIL =
  /^\s*(?:(?:const|volatile|noexcept(?:\([^()]*\))?|override|final|&&?|->\s*[^;{=]+?|[A-Z_][A-Z0-9_]*(?:\([^()]*\))?)\s*)*(?:=\s*(?:0|default|delete)\s*)?(?:;|\{.*\}\s*;?|\{|:[^;]*)?\s*$/;
// A C++ class body: the line above opens a class, struct or union, or is an
// access specifier (`public:`, Qt's `signals:`).
const CPP_CLASS_SCOPE =
  /^\s*(?:(?:template\s*<.*>\s*)?(?:class|struct|union)\b|(?:(?:public|private|protected)(?:\s+(?:slots|Q_SLOTS))?|signals|Q_SIGNALS)\s*:\s*$)/;
// A class member bound to an arrow function: `name = (...) => {`, `#name = async (...) => {`.
const OUTLINE_ARROW_MEMBER =
  /^\s+(?:(?:public|private|protected|static|readonly|override)\s+)*#?[A-Za-z_$][\w$]*\s*(?::[^=]*)?=\s*(?:async\s*)?\(.*\)\s*(?::[^=]*)?=>\s*\{\s*$/;
// The head of an arrow member whose parameter list wraps: `handle = async (`.
const OUTLINE_WRAPPED_ARROW =
  /^\s+(?:(?:public|private|protected|static|readonly|override)\s+)*#?[A-Za-z_$][\w$]*\s*(?::[^=]*)?=\s*(?:async\s*)?\(/;
// The line that closes a wrapped parameter list into a body: `): Promise<void> {`,
// or `}: Args): T {` after a destructured parameter. `).then(() => {` is a call.
const OUTLINE_WRAPPED_CLOSE = /^(?:\}[^()]*)?\)(?!\s*(?:\??\.|[,(])).*\{\s*$/;
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);
// `#` starts a comment only in these files; elsewhere a `#` line is a C
// preprocessor directive or a Rust attribute, and belongs in the outline.
const HASH_COMMENT_EXTENSIONS = new Set([
  '.py',
  '.pyi',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.yaml',
  '.yml',
  '.toml',
  '.rb',
  '.ps1',
  '.psm1',
  '.psd1',
  '.mk',
  '.dockerfile',
]);
// Files named for their tool rather than given an extension: `Makefile`,
// `Dockerfile.dev`. A code extension still wins: `makefile.c` is C.
const HASH_COMMENT_BASENAME = /^(?:(?:gnu)?makefile|dockerfile|containerfile)(?:\.[\w.-]+)?$/i;
// Code extensions whose `#` lines are code: C preprocessor directives, Rust
// attributes, C# and Swift directives, JavaScript private members.
const HASH_CODE_EXTENSIONS = new Set([
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.cxx',
  '.hpp',
  '.hh',
  '.hxx',
  '.m',
  '.mm',
  '.rs',
  '.cs',
  '.swift',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);
// Where a backtick opens a string that may run over several lines, and the
// scanner that finds its text can be trusted. JSX text is not JavaScript: a
// `/*` or a lone backtick in `<p>All requests to /api/* are proxied</p>` opens
// a comment or a template that never closes, and every later declaration would
// be dropped. So `.tsx`, `.jsx` and `.js`, which many toolchains compile as
// JSX, are outlined without the scanner.
const TEMPLATE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.mjs', '.cjs']);
// Kotlin declares every function with `fun`, so a `name(args) {` line there is a
// call taking a trailing lambda (`repeat(3) {`), not a method.
const KEYWORD_ONLY_EXTENSIONS = new Set(['.kt', '.kts']);
// Java and C#: interface and abstract methods are declared without a body
// (`int size();`), and their statement words are never a method's name.
const JAVA_CSHARP_EXTENSIONS = new Set(['.java', '.cs']);
// C++ sources and headers. A `.h` file may be C; the C++ rules only add lines
// a C header does not have.
const CPP_EXTENSIONS = new Set([
  '.cpp',
  '.cc',
  '.cxx',
  '.c++',
  '.hpp',
  '.hh',
  '.hxx',
  '.h',
  '.ipp',
  '.tpp',
  '.inl',
]);
const JSON_EXTENSIONS = new Set(['.json', '.jsonc', '.json5', '.webmanifest']);
// JSON configuration files named without an extension: `.babelrc`, `.prettierrc`.
const JSON_BASENAME = /^\.(?:babelrc|eslintrc|prettierrc|swcrc|jshintrc)$/;

interface OutlineProfile {
  hashComments: boolean;
  templates: boolean;
  keywordsOnly: boolean;
  bodilessMethods: boolean;
  reservedStatements: boolean;
  cpp: boolean;
  maxIndent: number;
}

function outlineProfile(filePath: string, lines: readonly string[]): OutlineProfile {
  const name = basename(filePath);
  const extension = extname(name).toLowerCase();
  return {
    hashComments:
      HASH_COMMENT_EXTENSIONS.has(extension) ||
      (HASH_COMMENT_BASENAME.test(name) && !HASH_CODE_EXTENSIONS.has(extension)) ||
      (extension === '' && lines[0]?.startsWith('#!') === true),
    templates: TEMPLATE_EXTENSIONS.has(extension),
    keywordsOnly: KEYWORD_ONLY_EXTENSIONS.has(extension),
    bodilessMethods: JAVA_CSHARP_EXTENSIONS.has(extension),
    reservedStatements: JAVA_CSHARP_EXTENSIONS.has(extension),
    cpp: CPP_EXTENSIONS.has(extension),
    maxIndent:
      extension === '.cs' && lines.some((line) => /^namespace\s+[\w.]+\s*\{?\s*$/.test(line))
        ? OUTLINE_MAX_INDENT_CSHARP_BLOCK_NAMESPACE
        : OUTLINE_MAX_INDENT,
  };
}

/** The index of the character that closes the quote opening at `start`, or the line's last index. */
function stringEnd(line: string, start: number): number {
  for (let index = start + 1; index < line.length; index++) {
    if (line[index] === '\\') index++;
    else if (line[index] === line[start]) return index;
  }
  return line.length - 1;
}

// What a `/` must follow to open a regex literal rather than divide: an
// operator, an opening bracket, a keyword such as `return`, or nothing but
// indentation. Only the last REGEX_LOOKBACK characters are examined, and a
// literal's closing `/` is looked for over at most REGEX_MAX_LENGTH, so a long
// minified line is scanned in linear time.
const REGEX_MAY_FOLLOW =
  /(?:[(,=:[!&|?{};+\-*%<>~^]|(?<![\w$.])(?:return|typeof|case|default|do|else|in|of|yield|await|void|throw|delete|instanceof))\s*$/;
const REGEX_LOOKBACK = 32;
const REGEX_MAX_LENGTH = 512;
// A `(` after one of these holds a control-flow condition, and a `/` right
// after its `)` opens a regex: `if (ok) /\d+/.test(s)`.
const CONDITION_KEYWORD = /(?:^|[^\w$.])(?:if|while|for|with)\s*$/;

/** Whether the `/` at `index` of a line indented by `indent` can open a regex literal. */
function regexMayStart(line: string, index: number, indent: number): boolean {
  if (index === indent) return true;
  const before = line.slice(Math.max(0, index - REGEX_LOOKBACK), index);
  // `i++ / 2` and `n-- / 2` divide: the `++` or `--` ends an operand.
  return !/(?:\+\+|--)\s*$/.test(before) && REGEX_MAY_FOLLOW.test(before);
}

/** The index of the `/` that closes a regex literal opening at `start`, or `start` when none does soon. */
function regexEnd(line: string, start: number): number {
  let inClass = false;
  const end = Math.min(line.length, start + REGEX_MAX_LENGTH);
  for (let index = start + 1; index < end; index++) {
    const char = line[index];
    if (char === '\\') index++;
    else if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) return index;
  }
  return start;
}

/** The index of the quote that closes a string at or after `start`, or undefined when it runs past the line. */
function quoteEnd(line: string, start: number, quote: string): number | undefined {
  for (let index = start; index < line.length; index++) {
    if (line[index] === '\\') index++;
    else if (line[index] === quote) return index;
  }
  return undefined;
}

/** Whether a line ends in a backslash that continues it, one not itself escaped. */
function continuesLine(line: string): boolean {
  return /(?:^|[^\\])(?:\\\\)*\\\r?$/.test(line);
}

/**
 * For each line of a JavaScript or TypeScript file, whether it starts inside a
 * template literal, a block comment or a string continued by a trailing
 * backslash, so is text rather than code. A small scanner, not a parser: any
 * other quoted string or regex literal ends with its line.
 */
function textLines(lines: readonly string[]): boolean[] {
  const text: boolean[] = [];
  // A template, or the brace depth of a `${` expression inside one.
  const stack: Array<'template' | number> = [];
  let comment = false;
  // The quote of a string continued onto the next line.
  let quote: string | undefined;
  for (const line of lines) {
    text.push(comment || quote !== undefined || stack.at(-1) === 'template');
    const indent = line.length - line.trimStart().length;
    // For each `(` open on this line, whether it holds a condition; and where
    // the last condition's `)` ended.
    const parens: boolean[] = [];
    let conditionEnd = -1;
    let start = 0;
    if (quote !== undefined) {
      const end = quoteEnd(line, 0, quote);
      if (end === undefined) {
        if (!continuesLine(line)) quote = undefined;
        continue;
      }
      quote = undefined;
      start = end + 1;
    }
    for (let index = start; index < line.length; index++) {
      const char = line[index];
      const top = stack.at(-1);
      if (comment) {
        if (char === '*' && line[index + 1] === '/') {
          comment = false;
          index++;
        }
      } else if (top === 'template') {
        if (char === '\\') index++;
        else if (char === '`') stack.pop();
        else if (char === '$' && line[index + 1] === '{') {
          stack.push(0);
          index++;
        }
      } else if (char === '/' && line[index + 1] === '/') {
        break;
      } else if (char === '/' && line[index + 1] === '*') {
        comment = true;
        index++;
      } else if (char === "'" || char === '"') {
        const end = quoteEnd(line, index + 1, char);
        if (end === undefined) {
          if (continuesLine(line)) quote = char;
          break;
        }
        index = end;
      } else if (char === '`') {
        stack.push('template');
      } else if (
        char === '/' &&
        (regexMayStart(line, index, indent) ||
          (conditionEnd >= 0 && line.slice(conditionEnd, index).trim().length === 0))
      ) {
        index = regexEnd(line, index);
      } else if (char === '(') {
        parens.push(CONDITION_KEYWORD.test(line.slice(Math.max(0, index - REGEX_LOOKBACK), index)));
      } else if (char === ')') {
        if (parens.pop() === true) conditionEnd = index + 1;
      } else if (typeof top === 'number' && char === '{') {
        stack[stack.length - 1] = top + 1;
      } else if (typeof top === 'number' && char === '}') {
        if (top === 0) stack.pop();
        else stack[stack.length - 1] = top - 1;
      }
    }
  }
  // A scan that ends inside a comment, a template or a continued string has
  // lost its place. Masking nothing then keeps the outline no worse than it is
  // without the scanner.
  return comment || quote !== undefined || stack.length > 0 ? text.map(() => false) : text;
}

/** Whether every parenthesis opened on the line is closed on it, quoted text aside. */
function balancedParentheses(line: string): boolean {
  let depth = 0;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === "'" || char === '"' || char === '`') index = stringEnd(line, index);
    else if (char === '(') depth++;
    else if (char === ')') depth--;
  }
  return depth === 0;
}

/** The text after the parameter list opening at `open`, or undefined when it does not close on the line. */
function afterParameters(line: string, open: number): string | undefined {
  let depth = 0;
  for (let index = open; index < line.length; index++) {
    const char = line[index];
    if (char === "'" || char === '"' || char === '`') index = stringEnd(line, index);
    else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return line.slice(index + 1);
  }
  return undefined;
}

/** Whether a `;` outside any brace ends a statement that more code follows: `foo(x); if (y) {`. */
function statementsFollow(tail: string): boolean {
  let depth = 0;
  for (let index = 0; index < tail.length; index++) {
    const char = tail[index];
    if (char === "'" || char === '"' || char === '`') index = stringEnd(tail, index);
    else if (char === '{') depth++;
    else if (char === '}') depth--;
    else if (char === ';' && depth === 0) {
      const rest = tail.slice(index + 1).trim();
      return rest.length > 0 && !rest.startsWith('//') && !rest.startsWith('/*');
    }
  }
  return false;
}

/** The next non-blank line, when it is a lone `{` at `indent`: an Allman-style body. */
function opensBodyBelow(lines: readonly string[], start: number, indent: number): boolean {
  for (let index = start + 1; index < lines.length; index++) {
    const trimmed = lines[index].trimStart();
    if (trimmed.length === 0) continue;
    return lines[index].length - trimmed.length === indent && /^\{\s*$/.test(trimmed);
  }
  return false;
}

function closesIntoBody(lines: readonly string[], start: number, indent: number): boolean {
  const end = Math.min(lines.length, start + 1 + OUTLINE_SIGNATURE_LOOKAHEAD);
  for (let index = start + 1; index < end; index++) {
    const trimmed = lines[index].trimStart();
    if (trimmed.length === 0) continue;
    const lineIndent = lines[index].length - trimmed.length;
    if (lineIndent < indent) return false;
    if (lineIndent === indent) return OUTLINE_WRAPPED_CLOSE.test(trimmed);
  }
  return false;
}

function isShallowDeclaration(
  lines: readonly string[],
  index: number,
  indent: number,
  profile: OutlineProfile,
  inCppClass: boolean,
): boolean {
  const line = lines[index];
  if (OUTLINE_KEYWORD.test(line) || OUTLINE_TEST_CHAIN.test(line)) return true;
  if (profile.cpp) return isCppMember(lines, index, indent, inCppClass);
  if (profile.keywordsOnly) return false;
  if (OUTLINE_ARROW_MEMBER.test(line)) return true;
  const typeFirst = OUTLINE_TYPE_FIRST.exec(line);
  const nameFirst = profile.reservedStatements
    ? OUTLINE_NAME_FIRST_JAVA_CSHARP
    : OUTLINE_NAME_FIRST;
  const method = typeFirst ?? nameFirst.exec(line);
  const head = method ?? OUTLINE_WRAPPED_ARROW.exec(line);
  if (!head) return false;
  const open = head[0].length - 1;
  // A parameter list that wraps onto the next lines counts once it closes into a body.
  if (!line.slice(open).includes(')')) return closesIntoBody(lines, index, indent);
  if (!method) return false;
  const tail = afterParameters(line, open);
  // Left open (`useEffect(() => {`), chained (`foo(x).then(`) or followed by
  // another statement (`foo(x); if (y) {`): a call, not a signature.
  if (
    tail === undefined ||
    !balancedParentheses(line) ||
    /^\s*(?:\??\.|[,(])/.test(tail) ||
    statementsFollow(tail)
  ) {
    return false;
  }
  if (/\{\s*$/.test(tail)) return true;
  if (!/[;{}=]/.test(tail) && opensBodyBelow(lines, index, indent)) return true;
  // The whole body on the line: `public int get() { return n; }`, and in Java
  // and C# a constructor's `public Foo(int n) { this.n = n; }`.
  if ((typeFirst || profile.reservedStatements) && OUTLINE_ONE_LINE_BODY.test(tail)) return true;
  if (!typeFirst) return false;
  // `int Twice(int x) => x * 2;` (C#, Dart), and `int size();` (Java, C#).
  if (/^\s*=>/.test(tail)) return true;
  return profile.bodilessMethods && /^(?:\s*throws\s[^;]*)?\s*;\s*$/.test(tail);
}

/**
 * A C++ member function, constructor, destructor or operator in a class body,
 * declared or defined; elsewhere only a definition, since `int x(5);` and
 * `Foo f(1);` in a function body are variables.
 */
function isCppMember(
  lines: readonly string[],
  index: number,
  indent: number,
  inClass: boolean,
): boolean {
  const line = lines[index];
  const head = CPP_METHOD_HEAD.exec(line);
  if (!head) return false;
  const open = head[0].length - 1;
  if (!line.slice(open).includes(')')) return closesIntoBody(lines, index, indent);
  const tail = afterParameters(line, open);
  if (tail === undefined || !balancedParentheses(line) || statementsFollow(tail)) return false;
  if (/\{\s*$/.test(tail) || OUTLINE_ONE_LINE_BODY.test(tail)) return true;
  // In a class body a declaration counts too: `void set(int v);`, `virtual void draw() = 0;`.
  if (inClass) return CPP_METHOD_TAIL.test(tail);
  return tail.trim().length === 0 && opensBodyBelow(lines, index, indent);
}

function codeOutlineIndexes(lines: readonly string[], profile: OutlineProfile): number[] {
  const output: number[] = [];
  const listed = new Set<number>();
  // The lines that open the blocks the current line sits in, innermost last. A
  // line deeper than `maxIndent` still counts when it declares a member of a
  // listed type, such as a Java inner class's method.
  const enclosing: Array<{ index: number; indent: number }> = [];
  // Template text is content at any indentation, column 0 included.
  const text = profile.templates ? textLines(lines) : undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (text?.[index]) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (/^[}\])]+[;,]?$/.test(trimmed)) continue;
    // A `*` opens a comment line only before a space, `/` or `*`: `*values() {` is a generator.
    if (/^(?:\/\/|\/\*|\*(?:[\s/*]|$)|--|<!--)/.test(trimmed)) continue;
    if (profile.hashComments && /^#(?!!)/.test(trimmed)) continue;
    // The closing line of a multi-line import is punctuation, not a declaration.
    if (/^\} from\b/.test(trimmed)) continue;
    // An Allman-style brace belongs to the line above it. Only a file that
    // opens with one lists it.
    if (trimmed === '{' && output.length > 0) continue;
    const indent = line.length - line.trimStart().length;
    while (enclosing.length > 0 && enclosing[enclosing.length - 1].indent >= indent) {
      enclosing.pop();
    }
    const parent = enclosing.at(-1);
    const parentLine = parent === undefined ? undefined : lines[parent.index];
    enclosing.push({ index, indent });
    if (indent === 0) {
      output.push(index);
      listed.add(index);
      continue;
    }
    const memberOfListedType =
      parent !== undefined &&
      listed.has(parent.index) &&
      OUTLINE_TYPE_DECLARATION.test(parentLine ?? '');
    if (indent > profile.maxIndent && !memberOfListedType) continue;
    const inCppClass = profile.cpp && parentLine !== undefined && CPP_CLASS_SCOPE.test(parentLine);
    if (isShallowDeclaration(lines, index, indent, profile, inCppClass)) {
      output.push(index);
      listed.add(index);
    }
  }
  return output;
}

function markdownOutlineIndexes(lines: readonly string[]): number[] {
  const output: number[] = [];
  let fence: string | undefined;
  for (let index = markdownContentStart(lines); index < lines.length; index++) {
    const line = lines[index];
    if (fence !== undefined) {
      const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1];
      if (closing && closing[0] === fence[0] && closing.length >= fence.length) fence = undefined;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (opening) {
      fence = opening;
      continue;
    }
    if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) {
      output.push(index);
      continue;
    }
    const next = lines[index + 1];
    if (next !== undefined && /^ {0,3}(?:=+|-+)\s*$/.test(next) && /^ {0,3}[^\s*+>|-]/.test(line)) {
      output.push(index);
    }
  }
  return output;
}

/** How far a JSON line moves the nesting depth: brackets inside strings and after `//` do not count. */
function jsonDepthChange(line: string): number {
  let change = 0;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') index = stringEnd(line, index);
    else if (char === '/' && line[index + 1] === '/') break;
    else if (char === '{' || char === '[') change++;
    else if (char === '}' || char === ']') change--;
  }
  return change;
}

/**
 * A JSON file's survey: the line that opens the root, then an object root's
 * keys, or an array root's elements, an object element by its first key and
 * any other by its own line. Depth decides, not indentation.
 */
function jsonOutlineIndexes(lines: readonly string[]): number[] {
  const output: number[] = [];
  let depth = 0;
  let arrayRoot = false;
  // An object element opened on a line of its own, whose first key is still to come.
  let elementOpen = false;
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    const start = depth;
    depth += jsonDepthChange(lines[index]);
    if (trimmed.length === 0 || trimmed.startsWith('//')) continue;
    const key = /^"(?:[^"\\]|\\.)*"\s*:/.test(trimmed);
    if (start === 0) {
      if (output.length === 0) {
        output.push(index);
        arrayRoot = trimmed.startsWith('[');
      }
    } else if (start === 1 && !arrayRoot) {
      if (key) output.push(index);
    } else if (start === 1) {
      elementOpen = /^\{\s*$/.test(trimmed);
      if (!elementOpen && !/^[}\]]+,?$/.test(trimmed)) output.push(index);
    } else if (start === 2 && elementOpen && key) {
      output.push(index);
      elementOpen = false;
    }
  }
  return output;
}

/** An entry's text, cut to OUTLINE_ENTRY_MAX_BYTES and closed with `…` when longer. */
function outlineEntryText(line: string): string {
  const text = line.trimEnd();
  if (Buffer.byteLength(text) <= OUTLINE_ENTRY_MAX_BYTES) return text;
  return `${utf8Prefix(text, OUTLINE_ENTRY_MAX_BYTES - Buffer.byteLength('…'))}…`;
}

function outlineLines(
  lines: readonly string[],
  filePath: string,
): Array<{ line: number; text: string }> {
  // A byte-order mark is not indentation: measure the first line from after it.
  const source =
    lines.length > 0 && lines[0].charCodeAt(0) === 0xfeff
      ? [lines[0].slice(1), ...lines.slice(1)]
      : lines;
  const name = basename(filePath);
  const extension = extname(name).toLowerCase();
  const indexes = MARKDOWN_EXTENSIONS.has(extension)
    ? markdownOutlineIndexes(source)
    : JSON_EXTENSIONS.has(extension) || JSON_BASENAME.test(name)
      ? jsonOutlineIndexes(source)
      : codeOutlineIndexes(source, outlineProfile(filePath, source));
  return indexes.map((index) => ({ line: index + 1, text: outlineEntryText(source[index]) }));
}

async function outlineFile(
  args: Record<string, unknown>,
  ctx: ToolContext,
  filePath: string,
  lines: readonly string[],
  lineCount: number,
): Promise<ToolResult> {
  if (args.offset !== undefined || args.limit !== undefined) {
    return toolFailure(
      `An outline covers the whole file and takes no offset or limit. Call Read with only filePath and outline: true to outline ${args.filePath}, or drop outline to read a line range.`,
      { code: 'invalid_arguments' },
    );
  }
  const entries = outlineLines(lines, filePath);
  const header = (shown: number) =>
    `Outline of ${args.filePath}: ${lineCount} lines, ${shown} shown. An outline is not the file's content: Read the file (whole, or with offset/limit) before editing it.`;
  const note = (shown: number, next: number) =>
    `[Outline truncated at ${shown} of ${entries.length} entries; the rest start at line ${next}. Read from there without outline, with offset/limit.]`;
  // Room for the header and the note at their widest, so neither a long path
  // nor the counts push the result past the tool-result clip, whose notice
  // names a file Read cannot open.
  const reserve =
    Buffer.byteLength(header(entries.length)) +
    Buffer.byteLength(note(entries.length, lineCount)) +
    2;
  // An outline stops at 2000 entries, or where the budget runs out.
  const shown: typeof entries = [];
  let bytes = 0;
  for (const entry of entries) {
    const size = Buffer.byteLength(`${entry.line}: ${entry.text}`) + 1;
    if (shown.length === OUTLINE_MAX_ENTRIES || bytes + size + reserve > TOOL_RESULT_MAX_BYTES) {
      break;
    }
    shown.push(entry);
    bytes += size;
  }
  const output = [header(shown.length), ...shown.map((entry) => `${entry.line}: ${entry.text}`)];
  if (entries.length > shown.length) output.push(note(shown.length, entries[shown.length].line));
  const observation = await observeFile(ctx, filePath, 'outline');
  return toolSuccess(output.join('\n'), { artifacts: { fileObservations: [observation] } });
}

async function readFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const resolved = resolveReadablePath(ctx, args.filePath as string);
  if (!resolved) return pathOutsideWorkspaceResult(args.filePath);
  const { filePath } = resolved;
  const offset = (args.offset as number) || 1;
  const limit = Math.max(1, (args.limit as number) || 2000);

  let content: string;
  try {
    content = await readTextFile(filePath, 'utf-8');
  } catch (error) {
    return toolFailure(
      isMissingFile(error)
        ? `File not found: ${args.filePath}`
        : `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  throwIfAborted(ctx.signal);
  const lines = content.split('\n');
  // A trailing newline ends the last line rather than starting another, and an
  // empty file has none; offset 1 still reads either.
  const lineCount = content.length === 0 ? 0 : lines.length - (content.endsWith('\n') ? 1 : 0);
  if (args.outline === true) return outlineFile(args, ctx, filePath, lines, lineCount);
  const maxOffset = Math.max(1, lineCount);
  if (offset > maxOffset) {
    return toolFailure(
      `Offset ${offset} is past the end of ${args.filePath}: the file has ${lineCount} ${lineCount === 1 ? 'line' : 'lines'}. Read with an offset of at most ${maxOffset}.`,
      { code: 'offset_out_of_range' },
    );
  }
  const end = Math.min(lines.length, offset - 1 + limit);
  const output: string[] = [];
  let bytes = 0;
  let last = offset - 1;
  for (let index = offset - 1; index < end; index++) {
    const text = `${index + 1}: ${lines[index]}`;
    const size = Buffer.byteLength(text) + 1;
    // A page stops at the byte budget, but always holds its first line.
    if (output.length > 0 && bytes + size > READ_OUTPUT_MAX_BYTES) break;
    output.push(text);
    bytes += size;
    last = index + 1;
    if ((index - offset + 2) % LINE_YIELD_INTERVAL === 0) await yieldToEventLoop(ctx.signal);
  }
  // A Read that stops before the end of the file, at the byte budget or at its
  // line limit, says so and names the offset to continue from.
  let notice: string | undefined;
  let pagination: ToolResult['pagination'];
  if (last < lineCount) {
    const reason = last < end ? ', the most one Read returns (50 KB)' : '';
    notice = `[Lines ${offset}-${last} of ${lineCount} shown${reason}. Continue with offset: ${last + 1}.]`;
    pagination = { truncated: true, nextCursor: String(last + 1) };
  }
  let page = notice === undefined ? output.join('\n') : `${output.join('\n')}\n${notice}`;
  // Only a page of one line can pass the clip. A line that does not fit even on
  // its own is shown cut to what the notice leaves, and the notice says so.
  if (Buffer.byteLength(page) > TOOL_RESULT_MAX_BYTES) {
    const cutNote = `Line ${last} (${Buffer.byteLength(lines[last - 1])} bytes) was cut to fit`;
    const cut =
      notice === undefined
        ? `[${cutNote} one Read (50 KB).]`
        : `${notice.slice(0, -1)} ${cutNote}.]`;
    const room = TOOL_RESULT_MAX_BYTES - Buffer.byteLength(cut) - 1;
    page = `${utf8Prefix(output[0], room)}\n${cut}`;
    pagination ??= { truncated: true };
  }
  const observation = await observeFile(ctx, filePath, 'read', {
    lineStart: offset,
    lineEnd: last,
  });
  return toolSuccess(page, {
    artifacts: { fileObservations: [observation] },
    pagination,
  });
}

async function writeFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const resolved = resolveWorkspacePath(ctx.workspaceRoot, args.filePath as string);
  if (!resolved) return pathOutsideWorkspaceResult(args.filePath);
  const { filePath, canonicalPath, relativePath } = resolved;
  return withMutationLocks([canonicalPath], async () => {
    const stale = await requireFreshObservation(ctx, filePath, relativePath);
    if (stale) return toolFailure(stale, { code: 'stale_file_observation' });
    let before;
    try {
      before = await readTextSnapshot(filePath, true);
    } catch (error) {
      return toolFailure(
        `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (before.binary)
      return toolFailure(`Binary file is unsupported: ${relativePath}`, {
        code: 'binary_file_unsupported',
      });
    if (before.exists) {
      const unobserved = requireObservationForMutation(ctx, relativePath, 'overwrite');
      if (unobserved) return unobserved;
    }
    const inputContent = args.content as string;
    const newContent = before.exists ? inputContent.replace(/\r\n/g, '\n') : inputContent;
    const { diff, stats } = await renderDiffWithStatsAsync(before.text, newContent, 3, ctx.signal);
    try {
      await writeFileAtomically(
        canonicalPath,
        before.exists ? restoreTextEncoding(newContent, before) : Buffer.from(newContent, 'utf8'),
        ctx.signal,
        before.mode,
      );
      const after = await readTextSnapshot(filePath);
      if (
        !after.bytes.equals(
          before.exists ? restoreTextEncoding(newContent, before) : Buffer.from(newContent, 'utf8'),
        )
      )
        return toolFailure('Post-write verification failed', { code: 'filesystem_error' });
    } catch (error) {
      return toolFailure(
        `Failed to write file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const observation = await observeFile(ctx, filePath, before.exists ? 'write' : 'create');
    return toolSuccess(diff || 'File written successfully', {
      artifacts: {
        fileMutation: {
          kind: before.exists ? 'update' : 'create',
          filePath: relativePath,
          addedLines: stats.addedLines,
          removedLines: stats.removedLines,
        },
        fileObservations: [observation],
      },
    });
  });
}

async function editFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const resolved = resolveWorkspacePath(ctx.workspaceRoot, args.filePath as string);
  if (!resolved) return pathOutsideWorkspaceResult(args.filePath);
  const { filePath, canonicalPath, relativePath } = resolved;
  return withMutationLocks([canonicalPath], async () => {
    const stale = await requireFreshObservation(ctx, filePath, relativePath);
    if (stale) return toolFailure(stale, { code: 'stale_file_observation' });
    let snapshot;
    try {
      snapshot = await readTextSnapshot(filePath);
    } catch (error) {
      return toolFailure(
        isMissingFile(error)
          ? `File not found: ${args.filePath}`
          : `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (snapshot.binary)
      return toolFailure(`Binary file is unsupported: ${relativePath}`, {
        code: 'binary_file_unsupported',
      });
    if (snapshot.mixedLineEndings)
      return toolFailure(`Mixed line endings are unsupported for Edit: ${relativePath}`, {
        code: 'text_conflict',
      });
    const unobserved = requireObservationForMutation(ctx, relativePath, 'edit');
    if (unobserved) return unobserved;
    const content = snapshot.text;
    const oldStr = (args.oldString as string).replace(/\r\n/g, '\n');
    const newStr = (args.newString as string).replace(/\r\n/g, '\n');
    const replaceAll = (args.replaceAll as boolean) ?? false;
    const application = await applySingleEdit(
      content,
      oldStr,
      newStr,
      replaceAll,
      ctx.signal,
      '',
      '',
    );
    if (!application.ok) return application.failure;
    const newContent = application.content;
    const toleranceNote = application.note ? `\n\nNote: ${application.note}` : '';
    const { diff, stats } = await renderDiffWithStatsAsync(content, newContent, 3, ctx.signal);
    try {
      await writeFileAtomically(
        canonicalPath,
        restoreTextEncoding(newContent, snapshot),
        ctx.signal,
        snapshot.mode,
      );
    } catch (error) {
      return toolFailure(
        `Failed to write file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const observation = await observeFile(ctx, filePath, 'edit');
    return toolSuccess((diff || 'File edited successfully (no textual change)') + toleranceNote, {
      artifacts: {
        fileMutation: {
          kind: 'update',
          filePath: relativePath,
          addedLines: stats.addedLines,
          removedLines: stats.removedLines,
        },
        fileObservations: [observation],
      },
    });
  });
}

async function multiEdit(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const resolved = resolveWorkspacePath(ctx.workspaceRoot, args.filePath as string);
  if (!resolved) return pathOutsideWorkspaceResult(args.filePath);
  const { filePath, canonicalPath, relativePath } = resolved;
  const edits =
    (args.edits as Array<{
      oldString: string;
      newString: string;
      replaceAll?: boolean;
    }>) ?? [];
  if (edits.length === 0) {
    return toolFailure('No edits provided');
  }

  return withMutationLocks([canonicalPath], async () => {
    const stale = await requireFreshObservation(ctx, filePath, relativePath);
    if (stale) return toolFailure(stale, { code: 'stale_file_observation' });
    const snapshot = await readTextSnapshot(filePath).catch(() => null);
    if (!snapshot) return toolFailure(`File not found: ${args.filePath}`);
    if (snapshot.binary)
      return toolFailure(`Binary file is unsupported: ${relativePath}`, {
        code: 'binary_file_unsupported',
      });
    if (snapshot.mixedLineEndings)
      return toolFailure(`Mixed line endings are unsupported for MultiEdit: ${relativePath}`, {
        code: 'text_conflict',
      });
    const unobserved = requireObservationForMutation(ctx, relativePath, 'edits');
    if (unobserved) return unobserved;
    const original = snapshot.text;
    let content = original;
    const notes: string[] = [];
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];
      const oldString = edit.oldString.replace(/\r\n/g, '\n');
      const newString = edit.newString.replace(/\r\n/g, '\n');
      const application = await applySingleEdit(
        content,
        oldString,
        newString,
        edit.replaceAll ?? false,
        ctx.signal,
        `Edit ${i + 1}: `,
        ' (no changes applied — MultiEdit is atomic)',
      );
      if (!application.ok) return application.failure;
      content = application.content;
      if (application.note) notes.push(application.note);
      await yieldToEventLoop(ctx.signal);
    }
    const toleranceNote = notes.length > 0 ? `\n\nNote: ${notes.join(' ')}` : '';
    const { diff, stats } = await renderDiffWithStatsAsync(original, content, 3, ctx.signal);
    try {
      await writeFileAtomically(
        canonicalPath,
        restoreTextEncoding(content, snapshot),
        ctx.signal,
        snapshot.mode,
      );
    } catch (error) {
      return toolFailure(
        `Failed to write file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const observation = await observeFile(ctx, filePath, 'edit');
    return toolSuccess((diff || 'File edited successfully (no textual change)') + toleranceNote, {
      artifacts: {
        fileMutation: {
          kind: 'update',
          filePath: relativePath,
          addedLines: stats.addedLines,
          removedLines: stats.removedLines,
        },
        fileObservations: [observation],
      },
    });
  });
}

async function globSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const files = await fg(pattern, {
    cwd: ctx.workspaceRoot,
    dot: true,
    ignore: ctx.gitignorePatterns ?? [],
  });

  throwIfAborted(ctx.signal);
  const seen = new Set<string>();
  const output: string[] = [];
  let truncated = false;

  for (let index = 0; index < files.length; index++) {
    const resolved = resolveWorkspacePath(ctx.workspaceRoot, files[index]);
    if (resolved && !seen.has(resolved.relativePath)) {
      seen.add(resolved.relativePath);
      if (output.length >= GLOB_OUTPUT_LIMIT) {
        truncated = true;
        break;
      }
      output.push(resolved.relativePath);
    }
    if (index > 0 && index % PATH_YIELD_INTERVAL === 0) await yieldToEventLoop(ctx.signal);
  }

  if (output.length === 0) {
    return toolSuccess('No files found', { data: { files: [] } });
  }

  const suffix = truncated ? `\n... (truncated at ${GLOB_OUTPUT_LIMIT} files; refine pattern)` : '';
  return toolSuccess(output.join('\n') + suffix, {
    data: { files: output },
    pagination: { truncated, omittedItems: truncated ? files.length - output.length : 0 },
  });
}

interface GrepMatch {
  line: number;
  text: string;
}

interface GrepFileMatches {
  matches: GrepMatch[];
  lines?: string[];
}

async function grepSearchPortable(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const includePattern = (args.include as string | undefined) ?? '**/*';
  const outputMode = (args.output_mode as 'content' | 'files_with_matches' | 'count') ?? 'content';
  const { before: contextBefore, after: contextAfter } = grepContextWindow(args);
  const multiline = (args.multiline as boolean) ?? false;
  const requestedHeadLimit = (args.head_limit as number) ?? GREP_MATCH_LIMIT;
  const headLimit = Math.min(
    GREP_MATCH_LIMIT,
    Math.max(1, Number.isFinite(requestedHeadLimit) ? Math.floor(requestedHeadLimit) : 1),
  );

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, multiline ? 'gms' : 'g');
  } catch {
    return toolFailure(`Invalid regex: ${pattern}`, { code: 'invalid_regex' });
  }

  const scoped = await resolveGrepScope(args, ctx);
  if (!scoped.ok) return scoped.failure;
  const scope = scoped.scope;
  // Glob from the workspace root so root-anchored .gitignore patterns keep
  // matching, then limit the results to the requested scope.
  const globbed = scope.isFile
    ? [scope.relativePath]
    : await fg(includePattern, {
        cwd: ctx.workspaceRoot,
        dot: true,
        ignore: [...GREP_DEFAULT_IGNORES, ...(ctx.gitignorePatterns ?? [])],
      });
  const files =
    scope.relativePath && !scope.isFile
      ? globbed.filter(
          (file) => file === scope.relativePath || file.startsWith(`${scope.relativePath}/`),
        )
      : globbed;
  throwIfAborted(ctx.signal);

  const inWorkspaceFiles: Array<{ file: string; filePath: string }> = [];
  const seenFiles = new Set<string>();
  for (let index = 0; index < files.length; index++) {
    const resolved = resolveWorkspacePath(ctx.workspaceRoot, files[index]);
    if (resolved && !seenFiles.has(resolved.relativePath)) {
      seenFiles.add(resolved.relativePath);
      inWorkspaceFiles.push({ file: resolved.relativePath, filePath: resolved.filePath });
    }
    if (index > 0 && index % PATH_YIELD_INTERVAL === 0) await yieldToEventLoop(ctx.signal);
  }

  const matchesByFile = new Map<string, GrepFileMatches>();
  let totalMatches = 0;

  for (let fileIndex = 0; fileIndex < inWorkspaceFiles.length; fileIndex++) {
    if (totalMatches >= headLimit) break;
    const { file, filePath } = inWorkspaceFiles[fileIndex];
    let content: string;
    try {
      if (await isBinaryFile(filePath)) continue;
      content = await readTextFile(filePath, 'utf-8');
    } catch {
      continue;
    }
    throwIfAborted(ctx.signal);

    const lines = content.split('\n');
    const matches: GrepMatch[] = [];

    if (multiline) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      let line = 1;
      let countedUntil = 0;
      let iterations = 0;
      while ((match = regex.exec(content)) !== null) {
        for (let index = countedUntil; index < match.index; index++) {
          if (content.charCodeAt(index) === 10) line++;
          if (index > countedUntil && index % LINE_YIELD_INTERVAL === 0) {
            await yieldToEventLoop(ctx.signal);
          }
        }
        countedUntil = match.index;
        matches.push({ line, text: clipGrepText(match[0].replace(/\n/g, '\\n')) });
        totalMatches++;
        iterations++;
        if (totalMatches >= headLimit) break;
        if (match.index === regex.lastIndex) regex.lastIndex++;
        if (iterations % PATH_YIELD_INTERVAL === 0) await yieldToEventLoop(ctx.signal);
      }
    } else {
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        regex.lastIndex = 0;
        if (regex.test(lines[lineIndex])) {
          matches.push({ line: lineIndex + 1, text: clipGrepText(lines[lineIndex]) });
          totalMatches++;
          if (totalMatches >= headLimit) break;
        }
        if (lineIndex > 0 && lineIndex % LINE_YIELD_INTERVAL === 0) {
          await yieldToEventLoop(ctx.signal);
        }
      }
    }

    if (matches.length > 0) {
      matchesByFile.set(file, {
        matches,
        lines: outputMode === 'content' ? lines : undefined,
      });
    }
    await yieldToEventLoop(ctx.signal);
  }

  const serializedMatches = Object.fromEntries(
    Array.from(matchesByFile.entries()).map(([file, result]) => [
      file,
      { matches: result.matches },
    ]),
  );

  if (outputMode === 'count') {
    const lines = Array.from(matchesByFile.entries()).map(
      ([file, result]) => `${file}:${result.matches.length}`,
    );
    return toolSuccess(lines.join('\n') || 'No matches found', {
      data: { mode: outputMode, matches: serializedMatches },
    });
  }

  if (outputMode === 'files_with_matches') {
    const matchedFiles = Array.from(matchesByFile.keys());
    return toolSuccess(matchedFiles.join('\n') || 'No matches found', {
      data: { mode: outputMode, files: matchedFiles },
    });
  }

  const output: string[] = [];
  let outputBytes = 0;
  let outputTruncated = false;
  const appendOutput = (line: string): boolean => {
    const clippedLine = clipGrepText(line);
    const additionalBytes = Buffer.byteLength(clippedLine) + (output.length > 0 ? 1 : 0);
    if (outputBytes + additionalBytes > GREP_OUTPUT_MAX_BYTES - GREP_OUTPUT_NOTICE_RESERVE_BYTES) {
      outputTruncated = true;
      return false;
    }
    output.push(clippedLine);
    outputBytes += additionalBytes;
    return true;
  };
  for (const [file, result] of matchesByFile) {
    const lines = result.lines ?? [];
    for (const match of result.matches) {
      const start = Math.max(1, match.line - contextBefore);
      const end = Math.min(lines.length, match.line + contextAfter);
      for (let line = start; line <= end; line++) {
        const text = lines[line - 1] ?? '';
        const marker = line === match.line ? ':' : '-';
        if (!appendOutput(`${file}:${line}${marker} ${text}`)) break;
        if (output.length >= headLimit) break;
      }
      if (output.length >= headLimit || outputTruncated) break;
    }
    if (output.length >= headLimit || outputTruncated) break;
    await yieldToEventLoop(ctx.signal);
  }
  const truncationNotice = outputTruncated
    ? '\n... (truncated at 50 KB; refine pattern or include)'
    : '';
  return toolSuccess((output.join('\n') || 'No matches found') + truncationNotice, {
    data: { mode: outputMode, totalMatches, matches: serializedMatches },
    pagination: { truncated: totalMatches >= headLimit || outputTruncated },
  });
}

interface RipgrepJsonEvent {
  type?: 'match' | 'context' | 'begin' | 'end' | 'summary';
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
}

type RipgrepOutcome = { kind: 'success'; result: ToolResult } | { kind: 'fallback' };

function stopSearchProcess(proc: ChildProcess): void {
  if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
}

async function grepSearchWithRipgrep(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<RipgrepOutcome> {
  const pattern = args.pattern as string;
  const includePattern = (args.include as string | undefined) ?? '**/*';
  const outputMode = (args.output_mode as 'content' | 'files_with_matches' | 'count') ?? 'content';
  const { before: contextBefore, after: contextAfter } = grepContextWindow(args);
  const multiline = (args.multiline as boolean) ?? false;
  const requestedHeadLimit = (args.head_limit as number) ?? GREP_MATCH_LIMIT;
  const headLimit = Math.min(
    GREP_MATCH_LIMIT,
    Math.max(1, Number.isFinite(requestedHeadLimit) ? Math.floor(requestedHeadLimit) : 1),
  );

  const scoped = await resolveGrepScope(args, ctx);
  if (!scoped.ok) return { kind: 'success', result: scoped.failure };
  const scope = scoped.scope;

  const rgArgs = ['--json', '--hidden', '--regexp', pattern, '--glob', includePattern];
  for (const ignored of GREP_DEFAULT_IGNORES) rgArgs.push('--glob', `!${ignored}`);
  if (contextBefore > 0) rgArgs.push('--before-context', String(contextBefore));
  if (contextAfter > 0) rgArgs.push('--after-context', String(contextAfter));
  if (multiline) rgArgs.push('--multiline', '--multiline-dotall');
  rgArgs.push(scope.relativePath || '.');

  return new Promise<RipgrepOutcome>((resolve, reject) => {
    const proc = spawn('rg', rgArgs, {
      cwd: ctx.workspaceRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let settled = false;
    let pending = '';
    let totalMatches = 0;
    let outputBytes = 0;
    let outputTruncated = false;
    const output: string[] = [];
    const matchesByFile = new Map<string, GrepFileMatches>();
    let aborting = false;

    const finish = (outcome: RipgrepOutcome) => {
      if (settled) return;
      settled = true;
      ctx.signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      ctx.signal?.removeEventListener('abort', onAbort);
      reject(error);
    };
    const onAbort = () => {
      if (aborting) return;
      aborting = true;
      stopSearchProcess(proc);
      const reason = ctx.signal?.reason ?? new Error('Grep cancelled');
      if (proc.exitCode !== null || proc.signalCode !== null) {
        fail(reason);
      } else {
        proc.once('close', () => fail(reason));
        setTimeout(() => fail(reason), 2_000).unref();
      }
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal?.aborted) onAbort();

    const appendOutput = (line: string): boolean => {
      const clippedLine = clipGrepText(line);
      const additionalBytes = Buffer.byteLength(clippedLine) + (output.length > 0 ? 1 : 0);
      if (
        outputBytes + additionalBytes >
        GREP_OUTPUT_MAX_BYTES - GREP_OUTPUT_NOTICE_RESERVE_BYTES
      ) {
        outputTruncated = true;
        stopSearchProcess(proc);
        return false;
      }
      output.push(clippedLine);
      outputBytes += additionalBytes;
      return true;
    };

    const processEvent = (event: RipgrepJsonEvent) => {
      if (totalMatches >= headLimit || outputTruncated) return;
      if (event.type !== 'match' && event.type !== 'context') return;
      const rawPath = event.data?.path?.text;
      const lineNumber = event.data?.line_number;
      const text = event.data?.lines?.text;
      if (!rawPath || !lineNumber || text === undefined) return;
      const resolved = resolveWorkspacePath(ctx.workspaceRoot, rawPath.replaceAll('\\', '/'));
      if (!resolved) return;
      const file = resolved.relativePath;

      if (event.type === 'match') {
        const fileMatches = matchesByFile.get(file) ?? { matches: [] };
        fileMatches.matches.push({
          line: lineNumber,
          text: clipGrepText(text.replace(/\r?\n$/, '').replace(/\r?\n/g, '\\n')),
        });
        matchesByFile.set(file, fileMatches);
        totalMatches++;
      }

      if (outputMode === 'content') {
        const eventLines = text.replace(/\r?\n$/, '').split(/\r?\n/);
        for (let index = 0; index < eventLines.length; index++) {
          const marker = event.type === 'match' ? ':' : '-';
          if (!appendOutput(`${file}:${lineNumber + index}${marker} ${eventLines[index]}`)) break;
        }
      }

      if (totalMatches >= headLimit || outputTruncated) stopSearchProcess(proc);
    };

    proc.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') finish({ kind: 'fallback' });
      else fail(error);
    });
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line) {
          try {
            processEvent(JSON.parse(line) as RipgrepJsonEvent);
          } catch {
            stopSearchProcess(proc);
            finish({ kind: 'fallback' });
            return;
          }
        }
        newline = pending.indexOf('\n');
      }
    });
    proc.once('close', (code) => {
      if (settled) return;
      if (code !== 0 && code !== 1 && totalMatches === 0 && !outputTruncated) {
        finish({ kind: 'fallback' });
        return;
      }
      const serializedMatches = Object.fromEntries(
        Array.from(matchesByFile.entries()).map(([file, result]) => [
          file,
          { matches: result.matches },
        ]),
      );
      if (outputMode === 'count') {
        const lines = Array.from(matchesByFile.entries()).map(
          ([file, result]) => `${file}:${result.matches.length}`,
        );
        finish({
          kind: 'success',
          result: toolSuccess(lines.join('\n') || 'No matches found', {
            data: { mode: outputMode, matches: serializedMatches },
            pagination: { truncated: totalMatches >= headLimit },
          }),
        });
        return;
      }
      if (outputMode === 'files_with_matches') {
        const matchedFiles = Array.from(matchesByFile.keys());
        finish({
          kind: 'success',
          result: toolSuccess(matchedFiles.join('\n') || 'No matches found', {
            data: { mode: outputMode, files: matchedFiles },
            pagination: { truncated: totalMatches >= headLimit },
          }),
        });
        return;
      }
      const truncationNotice = outputTruncated
        ? '\n... (truncated at 50 KB; refine pattern or include)'
        : '';
      finish({
        kind: 'success',
        result: toolSuccess((output.join('\n') || 'No matches found') + truncationNotice, {
          data: { mode: outputMode, totalMatches, matches: serializedMatches },
          pagination: { truncated: totalMatches >= headLimit || outputTruncated },
        }),
      });
    });
  });
}

async function grepSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pattern = args.pattern as string;
  try {
    new RegExp(pattern, (args.multiline as boolean) ? 'gms' : 'g');
  } catch {
    return toolFailure(`Invalid regex: ${pattern}`, { code: 'invalid_regex' });
  }
  throwIfAborted(ctx.signal);
  if (ctx.env.BOOK_GREP_BACKEND === 'typescript') return grepSearchPortable(args, ctx);
  const native = await grepSearchWithRipgrep(args, ctx);
  return native.kind === 'success' ? native.result : grepSearchPortable(args, ctx);
}

export const fileTools: ToolDefinition[] = [
  {
    name: 'Read',
    idempotent: true,
    policy: { concurrency: 'parallel' },
    argumentAliases: { file_path: 'filePath', path: 'filePath' },
    description:
      'Read a file from the workspace. Returns lines with line numbers. The default reads the whole file in one call, up to 2000 lines or 50 KB, whichever comes first — read files whole; use offset/limit only for a file larger than that, and never to read a file in small chunks. A Read that stops before the end of the file ends with a notice naming the offset to continue from. The "N: " line-number prefixes are display-only and are never part of the file content. Pass outline: true, without offset or limit, to survey a file\'s declarations (a Markdown file\'s headings) before deciding what to read; an outline is not a read, so Read the file before editing it.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description:
            'Path to the file relative to workspace root; absolute paths inside the workspace are also accepted',
        },
        offset: {
          type: 'number',
          description:
            'Line number to start reading from (1-indexed). Leave unset unless the file is larger than one Read returns (2000 lines or 50 KB); a Read that stops early names the offset to continue from.',
          default: 1,
        },
        limit: {
          type: 'number',
          description:
            'Maximum number of lines to read. Leave unset to read the whole file; only set it for a file larger than 2000 lines or 50 KB.',
          default: 2000,
        },
        outline: {
          type: 'boolean',
          description:
            "Return only the file's declarations with their line numbers (for Markdown, its headings), up to 2000 of them or 50 KB, to survey a file before deciding what to read in full. Cannot be combined with offset or limit. An outline does not count as reading the file: Edit and Write still need a Read.",
        },
      },
      required: ['filePath'],
    },
    execute: readFile,
  },
  {
    name: 'Write',
    argumentAliases: { file_path: 'filePath' },
    description: 'Write content to a file, overwriting if it exists. Returns a unified diff.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description:
            'Path to the file relative to workspace root; absolute paths inside the workspace are also accepted',
        },
        content: {
          type: 'string',
          description: 'Content to write to the file',
        },
      },
      required: ['filePath', 'content'],
    },
    execute: writeFile,
  },
  {
    name: 'Edit',
    argumentAliases: {
      file_path: 'filePath',
      old_string: 'oldString',
      new_string: 'newString',
      replace_all: 'replaceAll',
    },
    description:
      'Replace exact text in an existing file. oldString must match the file content exactly, including whitespace and indentation, and must not include the "N: " line-number prefixes from Read output. By default replaces the first occurrence; set replaceAll: true to replace every occurrence. Fails if oldString matches multiple times and replaceAll is not set. Returns a unified diff.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description:
            'Path to the file relative to workspace root; absolute paths inside the workspace are also accepted',
        },
        oldString: {
          type: 'string',
          description: 'Exact text to replace',
        },
        newString: {
          type: 'string',
          description: 'Text to replace it with',
        },
        replaceAll: {
          type: 'boolean',
          description: 'Replace every occurrence of oldString (default: false)',
          default: false,
        },
      },
      required: ['filePath', 'oldString', 'newString'],
    },
    execute: editFile,
  },
  {
    name: 'MultiEdit',
    argumentAliases: { file_path: 'filePath' },
    arrayItemArgumentAliases: {
      edits: { old_string: 'oldString', new_string: 'newString', replace_all: 'replaceAll' },
    },
    description:
      'Apply an ordered list of edits to one file atomically. If any edit fails, no changes are applied. Each edit supports replaceAll. Each oldString must match the file content exactly (whitespace included) without the line-number prefixes from Read output. Returns a unified diff of the net change.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description:
            'Path to the file relative to workspace root; absolute paths inside the workspace are also accepted',
        },
        edits: {
          type: 'array',
          description: 'Ordered list of edits to apply',
          items: {
            type: 'object',
            properties: {
              oldString: { type: 'string' },
              newString: { type: 'string' },
              replaceAll: { type: 'boolean', default: false },
            },
            required: ['oldString', 'newString'],
          },
        },
      },
      required: ['filePath', 'edits'],
    },
    execute: multiEdit,
  },
  {
    name: 'Glob',
    idempotent: true,
    policy: { concurrency: 'parallel' },
    description: 'Find files matching a glob pattern. Respects .gitignore.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern (e.g. src/**/*.ts)',
        },
      },
      required: ['pattern'],
    },
    execute: globSearch,
  },
  {
    name: 'Grep',
    idempotent: true,
    policy: { concurrency: 'parallel' },
    argumentAliases: { glob: 'include', '-A': 'A', '-B': 'B', '-C': 'C' },
    description:
      'Search file contents for a regex pattern. Scope with path (directory or file), filter filenames with include. output_mode: content (default), files_with_matches, or count. Supports context lines (A/B/C), multiline, and head_limit. Respects .gitignore.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: {
          type: 'string',
          description: 'Directory or file to scope the search to (defaults to the workspace root)',
        },
        include: {
          type: 'string',
          description: 'File glob pattern to filter (e.g. *.ts)',
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          default: 'content',
        },
        A: { type: 'number', description: 'Lines of context after match', default: 0 },
        B: { type: 'number', description: 'Lines of context before match', default: 0 },
        C: {
          type: 'number',
          description: 'Lines of context before and after match',
          default: 0,
        },
        multiline: {
          type: 'boolean',
          description: 'Match across newlines (dot matches newline)',
          default: false,
        },
        head_limit: {
          type: 'number',
          description: 'Max matches to return (default and maximum 100)',
          default: 100,
          maximum: 100,
        },
      },
      required: ['pattern'],
    },
    execute: grepSearch,
  },
];
