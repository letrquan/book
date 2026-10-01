import { open, readFile as readTextFile, stat } from 'fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import vm from 'node:vm';
import { basename, extname, join, resolve as resolvePath } from 'node:path';
import fg from 'fast-glob';
import type { ToolDefinition, ToolContext, ToolResult } from '../types/tools.js';
import { fastGlobPattern } from './glob-regex.js';
import { throwIfAborted, yieldToEventLoop } from '../async.js';
import { buildChildEnv } from '../child-env.js';
import { markdownContentStart } from '../frontmatter.js';
import { renderDiffWithStatsAsync } from './diff.js';
import { findRelaxedMatch } from './fuzzy-match.js';
import {
  isBookLocalSettingsUnderRoots,
  pathOutsideWorkspaceResult,
  resolveMutationPath,
  resolveReadablePath,
  type PathRoots,
  type ResolvedReadablePath,
} from './path-utils.js';
import {
  observeFile,
  requireFreshObservation,
  requireObservationForMutation,
} from './file-provenance.js';
import {
  readLineMetadata,
  READ_EMPTY_FILE_NOTICE,
  TOOL_RESULT_MAX_BYTES,
  toolFailure,
  toolSuccess,
  utf8Prefix,
} from './result.js';
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
  // Book's project-local settings can hold an API key; no search should return it (#264).
  '**/.book/settings.local.json',
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
  /** Relative to the root the scope resolved under, with forward slashes. */
  relativePath: string;
  absolutePath: string;
  isFile: boolean;
  /**
   * The root `relativePath` is relative to: the workspace, or the honored directory the scope
   * landed in. Grep globs from here, so a scope inside an honored directory searches that
   * directory rather than the workspace tree that does not contain it.
   */
  root: string;
}

type GrepScopeResolution = { ok: true; scope: GrepScope } | { ok: false; failure: ToolResult };

/**
 * The roots a Grep may search, which is `PathRoots` without the read-only ones.
 *
 * Grep is deliberately not given Book's memory directory: it walks a whole subtree and prints
 * matching lines, so a root that exists only so `Read` can open a file it remembers stays out of
 * it. An honored `additionalDirectory` is the user's own declaration and is the one root #300
 * adds, so it is included here.
 */
function grepRoots(ctx: ToolContext): PathRoots {
  return { workspaceRoot: ctx.workspaceRoot, additionalRoots: ctx.additionalRoots };
}

/**
 * Which root of {@link grepRoots} a resolved file came from, so a caller can be told to search
 * there. The resolved path answers it directly — the root that served it is the one it was
 * resolved against — so no root is compared with a path from ripgrep or fast-glob here.
 */
function grepRootFor(roots: PathRoots, resolved: ResolvedReadablePath): string {
  return resolved.inWorkspace ? roots.workspaceRoot : resolved.root;
}

/**
 * How a matched file is labelled in Glob and Grep output.
 *
 * A workspace match is labelled workspace-relative, because that is the form Read accepts. A match
 * in an honored directory is labelled with the absolute path it was found at: its relative form
 * would read as a workspace path that does not exist, so the model would try it and be told the
 * path is outside the workspace (#300). The spelling is the one the walk used — the root as the
 * caller gave it — so the label is a path Read opens rather than one that only looks right.
 */
function readableLabel(resolved: ResolvedReadablePath): string {
  return resolved.inWorkspace ? resolved.relativePath : resolved.filePath;
}

async function resolveGrepScope(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<GrepScopeResolution> {
  const raw = args.path as string | undefined;
  const roots = grepRoots(ctx);
  if (!raw || raw === '.') {
    return {
      ok: true,
      scope: {
        relativePath: '',
        absolutePath: ctx.workspaceRoot,
        isFile: false,
        root: ctx.workspaceRoot,
      },
    };
  }
  const resolved = resolveReadablePath(roots, raw);
  if (!resolved) return { ok: false, failure: pathOutsideWorkspaceResult(raw) };
  try {
    const info = await stat(resolved.filePath);
    return {
      ok: true,
      scope: {
        relativePath: resolved.relativePath,
        absolutePath: resolved.filePath,
        isFile: info.isFile(),
        root: grepRootFor(roots, resolved),
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
// Annotations are read off a line before it is matched, and only in languages
// that have them: in a Makefile `@go get` is a quiet command, in SCSS
// `@include mq(tablet) {` is a directive.
const OUTLINE_LEADING_ANNOTATIONS = new RegExp(`^(\\s*)${OUTLINE_ANNOTATIONS}`);
const ANNOTATION_EXTENSIONS = new Set([
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.groovy',
  '.cs',
  '.dart',
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

/** A line with its leading annotations removed, when its language has them; indentation kept. */
function declarationText(line: string, profile: OutlineProfile): string {
  return profile.annotations ? line.replace(OUTLINE_LEADING_ANNOTATIONS, '$1') : line;
}
// Where `describe`/`it`/`test` chains are test blocks. In Kotlin and Groovy,
// `it.split(",")` is a call on a lambda's implicit parameter.
const TEST_CHAIN_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);
/**
 * Where each place a statement word rules a line out:
 * - `call`: as the name of a method written name first, with or without a
 *   space before its `(` (`if (x) {`, `return (a) => {`);
 * - `name`: as a method's name after a return type (`int if(` is never a
 *   method, while `async return(` and `public do()` are);
 * - `spaced`: as that name only with a space before the `(`, since a
 *   JavaScript method may be called `using()`, `lock()` or `match(pattern)`
 *   (`using (var s = open())`, `when (x) {`, `with (o) {`);
 * - `reserved`: as that name in Java and C#, space or not, where a method
 *   written name first is a constructor (`foreach(var x in xs)`, `lock(_gate)`);
 * - `type`: where a return type would stand (`else if (`, `return new Foo(`,
 *   `go func() {`, Rust's `match parse(x) {`, Java's `assert isValid(x);`).
 */
type OutlineStatementPlace = 'call' | 'name' | 'spaced' | 'reserved' | 'type';
/** Words that start a statement, and the places where each one does. */
const OUTLINE_STATEMENT_WORDS: Record<string, readonly OutlineStatementPlace[]> = {
  if: ['call', 'name', 'type'],
  else: ['call', 'type'],
  elif: ['type'],
  for: ['call', 'name', 'type'],
  foreach: ['spaced', 'reserved', 'type'],
  while: ['call', 'name', 'type'],
  do: ['call', 'type'],
  switch: ['call', 'name', 'type'],
  case: ['type'],
  when: ['spaced', 'type'],
  match: ['spaced', 'type'],
  catch: ['call', 'name', 'type'],
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
const OUTLINE_STATEMENT_NAME = `${outlineStatementWords('name')}\\b`;
const OUTLINE_STATEMENT_SPACED = `${outlineStatementWords('spaced')}\\s`;
const OUTLINE_STATEMENT_RESERVED = `${outlineStatementWords('reserved')}\\b`;
const OUTLINE_STATEMENT_TYPE = `${outlineStatementWords('type')}\\b`;
// Type arguments nested up to three deep: `Map<String, List<Set<Integer>>>`.
const OUTLINE_GENERIC = '<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>';
const OUTLINE_TYPE = `[A-Za-z_$][\\w$.]*(?:${OUTLINE_GENERIC})?(?:\\[\\])*\\??`;
// A keyword declaration. A keyword followed by `:`, `,`, `;`, `=`, `?`, `)`,
// `.`, `->` or the end of the line is an object key, an import-list member or a
// property access (`set.add(x)`, `it.skip;`, `impl->value`) instead.
const OUTLINE_KEYWORD = new RegExp(
  `^\\s+${OUTLINE_MODIFIERS}(?:function|class|interface|enum|namespace|def|func|fn|fun|struct|impl|trait|describe|it|test|constructor|get|set)\\b(?!\\s*(?:[:,;=?).]|->)|\\s*$)`,
);
/**
 * A `union` at the indentation its class members sit at, which the keyword
 * list cannot hold: listed there it would also match a call or an assignment
 * named `union`, so what follows the word decides — a name (`union U {`) or the
 * anonymous form's brace (`union {`), never an argument list, a `=`, or the
 * punctuation that makes `union,` an import-list member.
 */
const OUTLINE_UNION_DECLARATION = /^\s+union\b(?!\s*(?:[:,;=?.]|->|\())/;
// A test block reached through a modifier: `it.skip('later', () => {`,
// `describe.each(cases)('x', …)`, `it.each<[number]>([[1]])('x', …)`,
// `it.for([1, 2])('x', …)`, `test.extend({})('z', …)`, and Jest's table form,
// `it.each` followed by a backtick.
const OUTLINE_TEST_MODIFIERS =
  '(?:skip|only|todo|each|for|concurrent|sequential|shuffle|fails|failing|runIf|skipIf|extend|serial|parallel|fixme|slow|describe|step)';
const OUTLINE_TEST_MODIFIER_CHAIN = new RegExp(
  `^\\s+(?:describe|it|test)(?:\\.${OUTLINE_TEST_MODIFIERS})+\\s*(?:(?:${OUTLINE_GENERIC})?\\s*\\(|\`)`,
);
/**
 * A chain of any other name counts when it is called with a title *and* a
 * second argument: `it.custom('titled', () => {`, `it.effect('adds', () => …`.
 * The callback is the second argument, and the comma before it is what says
 * so. A title alone does not (`it.next('resume');`), and neither does a body
 * somewhere on the line (`it.next('resume').then(() => {`) — a test call
 * passes the callback to the chain member itself (#316).
 */
const OUTLINE_TEST_TITLE_CHAIN =
  /^\s+(?:describe|it|test)(?:\.[A-Za-z_$][\w$]*)+\s*\(\s*(['"`])[^'"`\n]*\1\s*,/;
const OUTLINE_TEST_CHAIN = new RegExp(
  `${OUTLINE_TEST_MODIFIER_CHAIN.source}|${OUTLINE_TEST_TITLE_CHAIN.source}`,
);
/**
 * A type whose members may sit deeper than OUTLINE_MAX_INDENT: a Java inner
 * class, a nested C# class, a nested C++ `union`, an `impl` inside a Rust
 * `mod`. Its keyword is followed by a name, type arguments, or — for the
 * anonymous C/C++ forms — a brace, but never a `(`, so `union(a, b)` and
 * `union(setA, setB);` are calls and not declarations.
 */
const OUTLINE_TYPE_DECLARATION = new RegExp(
  `^\\s*${OUTLINE_MODIFIERS}(?:(?:class|interface|enum|record|struct|union|trait|impl|object|namespace)(?:\\s+[A-Za-z_$@[]|\\s*<)|(?:struct|union)\\s*\\{)`,
);
// A method named first: `name(`, `async *entries(`, `#secret(`, `map<K extends Record<string, V>>(`.
function outlineNameFirst(statement: string): RegExp {
  return new RegExp(
    `^\\s+${OUTLINE_MODIFIERS}(?!${statement})(?:\\*\\s*)?#?[A-Za-z_$][\\w$]*\\s*(?:${OUTLINE_GENERIC})?\\s*\\(`,
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
  `^\\s+${OUTLINE_MODIFIERS}(?:${OUTLINE_GENERIC}\\s+)?(?!${OUTLINE_STATEMENT_TYPE})${OUTLINE_TYPE}\\s+(?!${OUTLINE_STATEMENT_NAME})[A-Za-z_$][\\w$]*\\s*(?:${OUTLINE_GENERIC})?\\s*\\(`,
);
// A body on the method's own line: `public int get() { return n; }`,
// `record Point(int x, int y) {}`.
const OUTLINE_ONE_LINE_BODY = /^\s*(?:throws\s[^{;]*)?\{.*\}\s*;?\s*$/;
// C++: `[[nodiscard]]` attributes first, then a member function or constructor
// with an optional return type (`int`, `static std::string`,
// `const std::vector<int>&`, `Foo*`), then its name: a destructor (`~Foo`), an
// operator, or a qualified name (`Foo::name`).
// The return type is a sequence of two units, and a template head is one of them rather than an
// optional prefix of the other: a prefix inside a repeated unit splits two ways — `template<a> `
// is either that prefix or the word `template` plus the generic `<a>` — and every repetition
// doubles the work, so a line of them backtracked exponentially (#326). A type word refuses to
// start where a head starts, so each unit has exactly one parse and the repetition stays linear,
// and because the head is a unit it is read at any position, in either spelling:
// `template<typename T> template <typename U> void bar(U u) {` outlines as it should.
const CPP_STATEMENT_GUARD = `(?!${OUTLINE_STATEMENT_TYPE}|(?:static_assert|co_await|co_return|co_yield)\\b)`;
const CPP_TEMPLATE_UNIT = `template\\s*${OUTLINE_GENERIC}\\s*${CPP_STATEMENT_GUARD}`;
const CPP_TYPE_UNIT = `(?!template\\s*<)[A-Za-z_][\\w:]*(?:${OUTLINE_GENERIC})?[\\s*&]+`;
const CPP_METHOD_HEAD = new RegExp(
  `^\\s+(?:\\[\\[[^\\]]*\\]\\]\\s*)*${CPP_STATEMENT_GUARD}(?<returnType>(?:${CPP_TEMPLATE_UNIT}|${CPP_TYPE_UNIT})*)(?<name>(?:[A-Za-z_]\\w*::)*(?:~?[A-Za-z_]\\w*|operator\\s*(?:\\(\\)|[^\\s(]+)))\\s*\\(`,
);
// A C++ class body opens on a type definition's head: `class Foo {`,
// `template <typename T> struct Vec : Base<T>`, `class EXPORT Foo final {`,
// `class __declspec(dllexport) Bar {`, `class alignas(16) Vec {`. A function
// returning a struct (`struct node *node_new(int v) {`) is not one. Tested
// against a line with its trailing comment removed.
const CPP_CLASS_SCOPE =
  /^\s*(?:template\s*<.*>\s*)?(?:class|struct|union)\s+(?:(?:\[\[[^\]]*\]\]|__declspec\([^()]*\)|__attribute__\(\([^()]*\)\)|alignas\([^()]*\)|[A-Z_][A-Z0-9_]*)\s+)*[A-Za-z_][\w:]*(?:<[^(){};]*>)?(?:\s+final)?\s*(?::[^(){};]*)?\{?\s*$/;
// Lines that open no block, so never enclose what follows: C preprocessor
// directives (`#ifdef DEBUG` inside a class), C# regions, Rust attributes and
// C++ access specifiers (`public:`, Qt's `signals:`). Tested without a trailing comment.
const OUTLINE_TRANSPARENT_LINE =
  /^(?:#\s*(?:if|ifdef|ifndef|elif|else|endif|define|undef|include|pragma|region|endregion|error|warning|line)\b|#!?\[|(?:(?:public|private|protected)(?:\s+(?:slots|Q_SLOTS))?|signals|Q_SIGNALS)\s*:\s*$)/;
/**
 * A parenthesised group nested as deep as `OUTLINE_GENERIC` is, the way a macro argument
 * list holding a call is: `noexcept(noexcept(a.swap(b)))`, `GUARDED_BY(mu_.lock())`. A flat
 * `[^()]*` cannot hold even one inner `(`, and stops on the first `)`, which leaves the
 * qualifier half-read and drops the member it belongs to (#316).
 */
const CPP_PARENS = String.raw`\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)`;
// One thing that may follow a C++ member's parameter list before its body or
// `;`: a qualifier, a qualifier macro such as `Q_DECL_OVERRIDE`, an attribute
// or a trailing return type. `cppTailRest` reads it sticky from a local copy,
// so a tail is read in one pass whatever it holds.
const CPP_QUALIFIER = new RegExp(
  `\\s*(?:(?:const|volatile|override|final)\\b|noexcept\\b(?:\\s*${CPP_PARENS})?|&&?|\\[\\[[^\\]]*\\]\\]|[A-Z_][A-Z0-9_]*\\b(?:\\s*${CPP_PARENS})?|->[^;{=]*)`,
);
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
// JSON configuration files named without an extension,
// when they hold JSON rather than YAML: `.babelrc`, `.prettierrc`.
const JSON_BASENAME = /^\.(?:babelrc|eslintrc|prettierrc|swcrc|jshintrc)$/;

interface OutlineProfile {
  hashComments: boolean;
  templates: boolean;
  keywordsOnly: boolean;
  bodilessMethods: boolean;
  reservedStatements: boolean;
  cpp: boolean;
  annotations: boolean;
  testChains: boolean;
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
    annotations: ANNOTATION_EXTENSIONS.has(extension),
    testChains: TEST_CHAIN_EXTENSIONS.has(extension),
    maxIndent:
      extension === '.cs' && lines.some((line) => /^namespace\s+[\w.]+\s*\{?\s*$/.test(line))
        ? OUTLINE_MAX_INDENT_CSHARP_BLOCK_NAMESPACE
        : OUTLINE_MAX_INDENT,
  };
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

/**
 * What may stand immediately before a character literal's opening quote. Only
 * `u8` needs naming: a `'` between digits (`1'000`, a C++14 separator) opens
 * nothing, and the digit check below already rejects `U'x'` and `L'y'` because
 * no hex digit follows their quote. `u8'a'` is the one shape where a letter
 * does, and `U8` is not a C++ prefix, so the encoding prefix is what tells them
 * apart (#316).
 */
const CHARACTER_LITERAL_PREFIX = /u8$/;

/**
 * Where the quoted text opening at `index` ends: the index of its closing
 * quote, or -1 when it runs past the line. A C# verbatim string (`@"C:\"`)
 * takes no backslash escapes, only a doubled quote, and a `'` between digits
 * (`1'000`, a C++14 separator) opens nothing, so its own index comes back —
 * unless the quote carries an encoding prefix, which is what tells `u8'a'`
 * from `1'000` (#316).
 */
function quotedEnd(line: string, index: number): number {
  const quote = line[index];
  if (
    quote === "'" &&
    !CHARACTER_LITERAL_PREFIX.test(line.slice(Math.max(0, index - 2), index)) &&
    /\d/.test(line[index - 1] ?? '') &&
    /[\dA-Fa-f]/.test(line[index + 1] ?? '')
  ) {
    return index;
  }
  if (quote === '"' && /(?:@\$?|\$@)$/.test(line.slice(Math.max(0, index - 2), index))) {
    for (let position = index + 1; position < line.length; position++) {
      if (line[position] !== '"') continue;
      if (line[position + 1] !== '"') return position;
      position++;
    }
    return -1;
  }
  return quoteEnd(line, index + 1, quote) ?? -1;
}

/** The index to continue a scan from after the quoted text opening at `index`: its closing quote, or the line's end. */
function skipQuoted(line: string, index: number): number {
  const end = quotedEnd(line, index);
  return end < 0 ? line.length - 1 : end;
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

/** Whether every parenthesis opened on the line is closed on it, quoted text and comments aside. */
function balancedParentheses(line: string): boolean {
  let depth = 0;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === "'" || char === '"' || char === '`') index = skipQuoted(line, index);
    else if (char === '/' && line[index + 1] === '/') break;
    else if (char === '/' && line[index + 1] === '*') {
      const close = line.indexOf('*/', index + 2);
      if (close < 0) break;
      index = close + 1;
    } else if (char === '(') depth++;
    else if (char === ')') depth--;
  }
  return depth === 0;
}

/** The text after the parameter list opening at `open`, or undefined when it does not close on the line. */
function afterParameters(line: string, open: number): string | undefined {
  let depth = 0;
  for (let index = open; index < line.length; index++) {
    const char = line[index];
    if (char === "'" || char === '"' || char === '`') index = skipQuoted(line, index);
    else if (char === '/' && line[index + 1] === '/') break;
    else if (char === '/' && line[index + 1] === '*') {
      const close = line.indexOf('*/', index + 2);
      if (close < 0) break;
      index = close + 1;
    } else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return line.slice(index + 1);
  }
  return undefined;
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

/**
 * A line or a tail after a parameter list, read once: the code with its comments removed: a block comment that closes on the
 * line reads as a space, and a `//` or an unclosed `/*` ends it, and whether a
 * `;` outside braces ends a statement that more code follows (`foo(x); if (y) {`). Quoted text is skipped.
 */
function splitCode(text: string): { code: string; statementsFollow: boolean } {
  let depth = 0;
  let semicolon = -1;
  let code = '';
  let from = 0;
  let end = text.length;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "'" || char === '"' || char === '`') {
      index = skipQuoted(text, index);
    } else if (char === '/' && text[index + 1] === '/') {
      end = index;
      break;
    } else if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      if (close < 0) {
        end = index;
        break;
      }
      // `run() /* entry */ {`: the comment reads as a space.
      code += `${text.slice(from, index)} `;
      from = close + 2;
      index = close + 1;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
    } else if (char === ';' && depth === 0 && semicolon < 0) {
      semicolon = code.length + index - from;
    }
  }
  code += text.slice(from, Math.max(from, end));
  return {
    code,
    statementsFollow: semicolon >= 0 && code.slice(semicolon + 1).trim().length > 0,
  };
}

/** What is left of a C++ member's tail once its qualifiers are read off. */
function cppTailRest(tail: string): string {
  const qualifier = new RegExp(CPP_QUALIFIER.source, 'y');
  let position = 0;
  for (;;) {
    qualifier.lastIndex = position;
    if (!qualifier.exec(tail) || qualifier.lastIndex === position) break;
    position = qualifier.lastIndex;
  }
  return tail.slice(position).trim();
}

function isShallowDeclaration(
  lines: readonly string[],
  index: number,
  indent: number,
  profile: OutlineProfile,
  inCppClass: boolean,
): boolean {
  const line = declarationText(lines[index], profile);
  if (
    OUTLINE_KEYWORD.test(line) ||
    OUTLINE_UNION_DECLARATION.test(line) ||
    (profile.testChains && OUTLINE_TEST_CHAIN.test(line))
  )
    return true;
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
  if (tail === undefined || !balancedParentheses(line) || /^\s*(?:\??\.|[,(])/.test(tail)) {
    return false;
  }
  const { code, statementsFollow } = splitCode(tail);
  if (statementsFollow) return false;
  if (/\{\s*$/.test(code)) return true;
  if (!/[;{}=]/.test(code) && opensBodyBelow(lines, index, indent)) return true;
  // The whole body on the line: `public int get() { return n; }`, and in Java
  // and C# a constructor's `public Foo(int n) { this.n = n; }`.
  if ((typeFirst || profile.reservedStatements) && OUTLINE_ONE_LINE_BODY.test(code)) return true;
  if (!typeFirst) return false;
  // `int Twice(int x) => x * 2;` (C#, Dart), and `int size();` (Java, C#).
  if (/^\s*=>/.test(code)) return true;
  return profile.bodilessMethods && /^(?:\s*throws\s[^;]*)?\s*;\s*$/.test(code);
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
  // A macro: a capitalised name with an underscore (`Q_PROPERTY(int x READ x)`,
  // `GENERATED_BODY()`, a field's `ABSL_GUARDED_BY(mu_)`) or a compiler
  // builtin (`__attribute__((packed))`). Only a body makes one a declaration:
  // `BOOST_AUTO_TEST_CASE(works) {`. `RGB(int r, int g, int b);` is a constructor.
  const macro = /^(?:[A-Z][A-Z0-9]*_[A-Z0-9_]*|__\w+)$/.test(head.groups?.name ?? '');
  const open = head[0].length - 1;
  if (!line.slice(open).includes(')')) return closesIntoBody(lines, index, indent);
  const after = afterParameters(line, open);
  if (after === undefined || !balancedParentheses(line)) return false;
  const { code, statementsFollow } = splitCode(after);
  if (statementsFollow) return false;
  const rest = cppTailRest(code);
  // A body: on the line (`int get() const { return n_; }`), opening at its
  // end, or after a constructor's initializer list (`Foo(int n) : n_(n) {`).
  if (rest.startsWith('{') || /^:.*\{/.test(rest)) return true;
  // Nothing after the qualifiers: the body opens below, or in a class body a
  // declaration without `;` (but not a macro such as `Q_DISABLE_COPY(Foo)`).
  if (rest.length === 0) return (inClass && !macro) || opensBodyBelow(lines, index, indent);
  if (macro) return false;
  // In a class body a declaration counts too: `void set(int v);`,
  // `virtual void draw() = 0;`, and an initializer list that wraps.
  return inClass && /^(?:(?:=\s*(?:0|default|delete)\s*)?;|:.*)$/.test(rest);
}

function codeOutlineIndexes(lines: readonly string[], profile: OutlineProfile): number[] {
  const output: number[] = [];
  // The lines that open the blocks the current line sits in, innermost last,
  // with what a child needs to know about each: whether it was listed, and
  // whether it declares a type or opens a C++ class body. A line deeper than
  // `maxIndent` still counts when it declares a member of a listed type, such
  // as a Java inner class's method.
  const enclosing: Array<{
    indent: number;
    listed: boolean;
    typeDeclaration: boolean;
    cppClass: boolean;
  }> = [];
  const close = (indent: number) => {
    while (enclosing.length > 0 && enclosing[enclosing.length - 1].indent >= indent) {
      enclosing.pop();
    }
  };
  // Template text is content at any indentation, column 0 included.
  const text = profile.templates ? textLines(lines) : undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (text?.[index]) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // A `*` line is a comment unless it opens a generator method: `*values() {`.
    if (/^(?:\/\/|\/\*|\*(?![A-Za-z_$#][\w$]*\s*[<(])|--|<!--)/.test(trimmed)) continue;
    if (profile.hashComments && /^#(?!!)/.test(trimmed)) continue;
    const indent = line.length - line.trimStart().length;
    // The line without a trailing comment (`{  // NOLINT`, `};  // class Foo`).
    // Most lines hold no `/`, and are not split at all.
    const code = trimmed.includes('/') ? splitCode(trimmed).code.trim() : trimmed;
    // A closing line ends the blocks opened at its indentation or deeper: after
    // `};` a class is no longer the parent of what follows.
    if (/^[}\])]+[;,]?$/.test(code)) {
      close(indent);
      continue;
    }
    // The closing line of a multi-line import is punctuation, not a declaration.
    if (/^\} from\b/.test(code)) continue;
    // An Allman-style brace belongs to the line above it. Only a file that
    // opens with one lists it.
    if (code === '{' && output.length > 0) continue;
    // A preprocessor line or an access specifier neither closes nor opens a
    // block, so the class around it stays the parent of what follows.
    const transparent = OUTLINE_TRANSPARENT_LINE.test(code);
    if (!transparent) close(indent);
    const parent = transparent ? undefined : enclosing.at(-1);
    const entry = { indent, listed: false, typeDeclaration: false, cppClass: false };
    if (!transparent) enclosing.push(entry);
    const list = () => {
      output.push(index);
      entry.listed = true;
      entry.typeDeclaration = OUTLINE_TYPE_DECLARATION.test(declarationText(code, profile));
      entry.cppClass = profile.cpp && CPP_CLASS_SCOPE.test(code);
    };
    if (indent === 0) {
      list();
      continue;
    }
    const memberOfListedType = parent !== undefined && parent.listed && parent.typeDeclaration;
    if (indent > profile.maxIndent && !memberOfListedType) continue;
    if (isShallowDeclaration(lines, index, indent, profile, parent?.cppClass === true)) list();
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

/** Whether the next character after spaces and tabs from `index` is a `:`. */
function colonFollows(line: string, index: number): boolean {
  let position = index;
  while (line[position] === ' ' || line[position] === '\t') position++;
  return line[position] === ':';
}

/**
 * A JSON line read from nesting depth `depth`: the depth after it, where its
 * first character of code sits (-1 for a line of comments or blanks), and the
 * depth of each key on it, quoted or JSON5-bare. Brackets inside strings and
 * comments do not count; `state.comment` carries a block comment over to the
 * next line.
 */
function jsonScan(
  line: string,
  state: { comment: boolean },
  depth: number,
): { depth: number; first: number; keyDepths: number[] } {
  let current = depth;
  let first = -1;
  const keyDepths: number[] = [];
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (state.comment) {
      if (char === '*' && line[index + 1] === '/') {
        state.comment = false;
        index++;
      }
    } else if (char === '/' && line[index + 1] === '/') {
      break;
    } else if (char === '/' && line[index + 1] === '*') {
      state.comment = true;
      index++;
    } else if (line.charCodeAt(index) > 32) {
      if (first < 0) first = index;
      if (char === '"' || char === "'") {
        index = skipQuoted(line, index);
        if (colonFollows(line, index + 1)) keyDepths.push(current);
      } else if (char === '{' || char === '[') {
        current++;
      } else if (char === '}' || char === ']') {
        current--;
      } else if (/[A-Za-z_$]/.test(char)) {
        let end = index + 1;
        while (end < line.length && /[\w$]/.test(line[end])) end++;
        if (colonFollows(line, end)) keyDepths.push(current);
        index = end - 1;
      }
    }
  }
  return { depth: current, first, keyDepths };
}

/**
 * A JSON file's survey: the line that opens each top-level value (the root,
 * or every record of a file with one per line), then an object's keys, or an
 * array's elements, an object element by its first key and any other by its
 * own line. Depth decides, not indentation.
 */
function jsonOutlineIndexes(lines: readonly string[]): number[] {
  const output: number[] = [];
  const state = { comment: false };
  let depth = 0;
  let root: 'object' | 'array' = 'object';
  // An array element whose object opened at the end of a line (`{`, `}, {`)
  // and whose first key is still to come.
  let elementOpen = false;
  for (let index = 0; index < lines.length; index++) {
    const start = depth;
    const scan = jsonScan(lines[index], state, depth);
    depth = scan.depth;
    if (scan.first < 0) continue;
    const code = lines[index].slice(scan.first).trimEnd();
    const opensElement = depth === 2 && /\{\s*$/.test(code);
    if (start === 0) {
      output.push(index);
      root = lines[index][scan.first] === '[' ? 'array' : 'object';
    } else if (root === 'object') {
      // `/* c */ "a": 1,` and `}, "c": 2,` hold a top-level key too.
      if (scan.keyDepths.includes(1)) output.push(index);
    } else if (elementOpen && scan.keyDepths.includes(2)) {
      output.push(index);
      elementOpen = false;
    } else if (start === 1 && !opensElement && !/^[}\]]+,?$/.test(code)) {
      output.push(index);
    }
    // An element opened at the end of this line waits for its first key; one
    // that closed (`},`) takes its wait with it.
    if (root === 'array') elementOpen = opensElement || (elementOpen && depth >= 2);
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
  const firstLine =
    source.find((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !/^(?:\/\/|\/\*|\*)/.test(trimmed);
    }) ?? '';
  const json =
    JSON_EXTENSIONS.has(extension) || (JSON_BASENAME.test(name) && /^\s*[[{]/.test(firstLine));
  const indexes = MARKDOWN_EXTENSIONS.has(extension)
    ? markdownOutlineIndexes(source)
    : json
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
  // Floored as well as validated, and clamped: the schema rejects a fraction
  // and anything below 1, but a caller that reaches the tool directly must
  // never be handed `0: undefined` or `offset: -2.5` as the next page (#310).
  const offset = Math.max(1, Math.floor((args.offset as number) || 1));
  const limit = Math.max(1, Math.floor((args.limit as number) || 2000));

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
  // A file with no lines at all gets one notice line: an empty tool result
  // reads as a call that produced no output, which is not what an empty file
  // is, and the row for it would have no lines to count (#309).
  if (lineCount === 0) {
    const observation = await observeFile(ctx, filePath, 'read', { lineStart: 1, lineEnd: 0 });
    return toolSuccess(READ_EMPTY_FILE_NOTICE, {
      artifacts: { fileObservations: [observation] },
      presentation: {
        kind: 'file',
        summary: `Read ${args.filePath}`,
        metadata: readLineMetadata(1, 0),
      },
    });
  }
  // Bounded by lineCount, never by lines.length: `split` leaves an empty
  // element after a file's final newline, and numbering that phantom line is
  // what made `a\nb\n` read as three lines and an empty file as `1: ` (#309).
  const end = Math.min(lineCount, offset - 1 + limit);
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
    // Only Read knows which lines of the file the page holds: a notice when it
    // stops early, and a line cut to fit at the clip, so both have to be read
    // back out of the text rather than counted from it.
    presentation: {
      kind: 'file',
      summary: `Read ${args.filePath}`,
      metadata: readLineMetadata(offset, last - offset + 1),
    },
  });
}

async function writeFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const resolved = resolveMutationPath(ctx, args.filePath as string);
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
      const unobserved = requireObservationForMutation(ctx, filePath, relativePath, 'overwrite');
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
  const resolved = resolveMutationPath(ctx, args.filePath as string);
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
    const unobserved = requireObservationForMutation(ctx, filePath, relativePath, 'edit');
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
  const resolved = resolveMutationPath(ctx, args.filePath as string);
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
    const unobserved = requireObservationForMutation(ctx, filePath, relativePath, 'edits');
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

/**
 * The one `cwd` a Glob walks, and why there is only one.
 *
 * fast-glob resolves a *relative* pattern against its `cwd` and an *absolute* one against the file
 * system, so the two cases need different handling and neither benefits from a loop:
 *
 * - A relative pattern searches the **workspace only**. It is anchored there the way `Read`
 *   anchors a relative path and the way `Grep` anchors a relative scope, so all three agree about
 *   what a bare `*.ts` means. Searching the honored roots as well surfaced files from a root the
 *   user approved for other work, in answer to a pattern that never named it (PR #334 finding 9).
 * - An absolute pattern names its own root. It is walked **once**: `cwd` is ignored for it, so
 *   running it per root repeated the identical walk and the duplicates were removed by a dedupe
 *   that existed only to undo the loop. Which root holds the base is then checked by the filter
 *   below, exactly as a Grep scope is resolved against the roots.
 */
function globSearchDir(ctx: ToolContext): string[] {
  return [ctx.workspaceRoot];
}

async function globSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const roots = grepRoots(ctx);
  const files: string[] = [];
  for (const cwd of globSearchDir(ctx)) {
    // Converted for fast-glob, which reads `\` as an escape and so walks nothing at all for a
    // Windows pattern (`C:\ws\**\*.ts`): an absolute Glob came back empty. Which root holds the
    // base is then decided by the filter below, against the roots in canonical form.
    const found = await fg(fastGlobPattern(pattern), {
      cwd,
      dot: true,
      ignore: ctx.gitignorePatterns ?? [],
    });
    files.push(...found.map((file) => resolvePath(cwd, file)));
  }

  throwIfAborted(ctx.signal);
  const seen = new Set<string>();
  const output: string[] = [];
  let truncated = false;

  for (let index = 0; index < files.length; index++) {
    // Filtered through the read roots, so a pattern that walked out of them (a symlinked entry,
    // an `absolute` base) is dropped rather than listed.
    const resolved = resolveReadablePath(roots, files[index]);
    if (resolved && !seen.has(resolved.canonicalPath)) {
      seen.add(resolved.canonicalPath);
      if (output.length >= GLOB_OUTPUT_LIMIT) {
        truncated = true;
        break;
      }
      output.push(readableLabel(resolved));
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

/** The structured counts a Grep result carries, in every `output_mode`. */
interface GrepCounts {
  mode: 'content' | 'files_with_matches' | 'count';
  totalMatches?: number;
  matches?: Record<string, GrepFileMatches>;
  files?: string[];
}

/**
 * A Grep row's count, from the counts Grep already collected rather than by
 * re-reading its own page. The text cannot be counted back: a context line's
 * own text can hold a `12:30` of its own, and a match spanning several lines
 * is several lines of the page (#311). In the unit `output_mode` asks for —
 * matches in `content` and `count` mode, files in `files_with_matches` — and
 * the summary follows the same count and noun.
 */
function grepPresentation(data: GrepCounts): {
  kind: 'search';
  metadata: string[];
  summary: string;
} {
  const files = data.mode === 'files_with_matches';
  const count = files ? (data.files?.length ?? 0) : (data.totalMatches ?? sumMatches(data.matches));
  const noun = files ? 'file' : 'match';
  const label = `${count} ${count === 1 ? noun : files ? 'files' : 'matches'}`;
  return { kind: 'search', metadata: [label], summary: `Found ${label}` };
}

function sumMatches(matches: Record<string, GrepFileMatches> | undefined): number {
  if (!matches) return 0;
  return Object.values(matches).reduce((total, file) => total + file.matches.length, 0);
}

/**
 * How long one file's regex may run inside the sandbox before the search gives up on it (#349).
 * Ordinary patterns finish in microseconds, so this is a ceiling on a pattern that is not
 * ordinary rather than a budget the search spends.
 */
const GREP_REGEX_FILE_BUDGET_MS = 1_500;

/**
 * How long a whole search may spend inside the sandbox, so a pattern that is slow on every file
 * it is pointed at is reported once rather than once per file. Only time actually spent matching
 * counts; reading a file, and the yield between files, cost the search nothing here.
 */
const GREP_REGEX_TOTAL_BUDGET_MS = 10_000;

/**
 * What has to be left of the search's budget for another run to start at all. A leftover of a
 * few milliseconds would interrupt an ordinary batch and report a timeout the pattern did not
 * earn, so the search stops here instead, up to this much early.
 */
const GREP_REGEX_MIN_BUDGET_MS = 250;

/**
 * The matching half of the portable backend, run where a `timeout` can interrupt it.
 *
 * The portable backend exists for the machines without ripgrep, and it runs the model's own regex
 * on the main thread: `(a+)+$` against a line of a's that ends in something else is exponential,
 * and for the minutes it takes, nothing in the process can run — not the abort signal the caller
 * holds, not the yield between files, not the session's own timers. Inside a `vm` context the same
 * regex is the same work, but V8 can interrupt it mid-backtrack, which is the whole point.
 *
 * Only the payload crosses the boundary, and only indices cross back: the caller owns line
 * numbering, the head limit, and the clipping, so what the sandbox returns is a list of where the
 * matches are, never the file content it read.
 */
const GREP_MATCH_SCRIPT = `
(function () {
  var payload = __bookGrepPayload;
  var regex = new RegExp(payload.pattern, payload.flags);
  var found = [];
  var index;
  if (payload.multiline) {
    regex.lastIndex = 0;
    var match;
    while ((match = regex.exec(payload.text)) !== null) {
      found.push({ index: match.index, text: match[0] });
      if (found.length >= payload.limit) break;
      // A pattern that matches the empty string does not advance lastIndex on its own.
      if (match.index === regex.lastIndex) regex.lastIndex++;
    }
  } else {
    for (index = 0; index < payload.lines.length; index++) {
      regex.lastIndex = 0;
      if (regex.test(payload.lines[index])) {
        found.push({ line: index });
        if (found.length >= payload.limit) break;
      }
    }
  }
  return found;
})()
`;

/** One match as the sandbox reports it: an offset in `text`, or a line index in `lines`. */
interface SandboxMatch {
  line?: number;
  index?: number;
  text?: string;
}

type SandboxOutcome =
  { kind: 'ok'; matches: SandboxMatch[] } | { kind: 'timeout' } | { kind: 'invalid' };

/**
 * The file, or the lines of it, as the sandbox receives them: the pattern and its flags, and how
 * many matches are still wanted.
 */
type SandboxPayload = { pattern: string; flags: string; limit: number } & (
  { multiline: true; text: string } | { multiline: false; lines: string[] }
);

/**
 * A compiled matcher in its own context, reused across the files of one search.
 */
class GrepRegexSandbox {
  private readonly context: vm.Context;
  private readonly script: vm.Script;

  constructor() {
    this.context = vm.createContext({});
    this.script = new vm.Script(GREP_MATCH_SCRIPT);
  }

  run(payload: SandboxPayload, timeoutMs: number): SandboxOutcome {
    this.context.__bookGrepPayload = payload;
    try {
      const found = this.script.runInContext(this.context, { timeout: timeoutMs });
      return { kind: 'ok', matches: found as SandboxMatch[] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        return { kind: 'timeout' };
      }
      // Only the pattern can fail to compile, and the host compiled it already to reject an
      // invalid one before any file was read. Judged by name, not by `instanceof`: an error raised
      // inside the context belongs to that realm, so the host's SyntaxError is not its prototype.
      if ((error as Error).name === 'SyntaxError') return { kind: 'invalid' };
      throw error;
    }
  }
}

/** What the model is told when a pattern outruns the budget, and the code that goes with it. */
function regexTimeoutFailure(pattern: string, budgetMs: number): ToolResult {
  return toolFailure(
    `Grep gave up on pattern ${pattern} after ${budgetMs}ms of matching. A pattern like ` +
      `(a+)+$ backtracks exponentially against a line it cannot match at the end. Simplify ` +
      `the pattern — search for the literal text, bound the repetition, or narrow the search ` +
      `with path/include — and run it again.`,
    { code: 'regex_timeout' },
  );
}

/**
 * Why and where the portable search stopped, on a search that had matches to report anyway (#349).
 *
 * The numbers in these are measured rather than nominal: the matching time the search actually
 * spent, and the budget the run that ran out was given. The page reports what the search did, not
 * the ceiling it was allowed.
 */
interface GrepBudgetStop {
  /** What ran out, in the words the page reports. */
  cause: string;
  /** The part of the search the page never reached, so a partial page is not read as complete. */
  unread: string;
}

/**
 * The page's notice when a budget ran out on a search that had already found something.
 *
 * Those matches are what the model asked for and they are already read, so the timeout makes the
 * page partial rather than empty. The file is named because that is the file to narrow the search
 * on, and what is missing is named with it.
 */
function regexPartialNotice(stop: GrepBudgetStop): string {
  return `... (stopped: ${stop.cause}; ${stop.unread} was not searched — refine the pattern or narrow the search)`;
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

  try {
    // Compiled here for the verdict, not for use: the pattern itself is compiled in the sandbox,
    // where a run of it can be interrupted.
    new RegExp(pattern, multiline ? 'gms' : 'g');
  } catch {
    return toolFailure(`Invalid regex: ${pattern}`, { code: 'invalid_regex' });
  }

  const scoped = await resolveGrepScope(args, ctx);
  if (!scoped.ok) return scoped.failure;
  const scope = scoped.scope;
  const roots = grepRoots(ctx);
  // Glob from the scope's own root so root-anchored .gitignore patterns keep matching there too
  // (#300): a scope inside an honored directory is not in the workspace tree at all, so globbing
  // from the workspace would find nothing. Then limit the results to the requested scope.
  const globbed = scope.isFile
    ? [scope.relativePath]
    : await fg(includePattern, {
        cwd: scope.root,
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
    // `files` came from a glob whose cwd was `scope.root`, so each entry is relative to that
    // root rather than to the workspace — rejoined before resolution (#300).
    const resolved = resolveReadablePath(roots, join(scope.root, files[index]));
    if (
      resolved &&
      !seenFiles.has(resolved.canonicalPath) &&
      // Book's local settings can hold an API key: never search them, whatever path (a link, an
      // explicit `path`, an honored directory) led here (#264, #300).
      !isBookLocalSettingsUnderRoots(resolved.canonicalPath, roots)
    ) {
      seenFiles.add(resolved.canonicalPath);
      inWorkspaceFiles.push({ file: readableLabel(resolved), filePath: resolved.filePath });
    }
    if (index > 0 && index % PATH_YIELD_INTERVAL === 0) await yieldToEventLoop(ctx.signal);
  }

  const matchesByFile = new Map<string, GrepFileMatches>();
  const sandbox = new GrepRegexSandbox();
  let totalMatches = 0;
  let regexBudgetLeft = GREP_REGEX_TOTAL_BUDGET_MS;
  /** Set when a budget ran out on a search that had matches to report; see `regexPartialNotice`. */
  let budgetStop: GrepBudgetStop | undefined;

  /** How long the next sandbox run may take: the file's own ceiling, and what is left of the search's. */
  const budgetForNextRun = () => Math.min(GREP_REGEX_FILE_BUDGET_MS, regexBudgetLeft);
  const budgetSpent = () => regexBudgetLeft < GREP_REGEX_MIN_BUDGET_MS;
  /** The matching time the search has actually spent, which is what a budget is spent on. */
  const elapsedMatchingMs = () => Math.max(0, GREP_REGEX_TOTAL_BUDGET_MS - regexBudgetLeft);
  /**
   * What a run that ran out of budget means for the page: nothing found yet is still the failure
   * the budgets exist to report, but matches already collected are results, and one file that will
   * not finish matching is a reason to stop and report them rather than to throw them away.
   */
  const stopOnTimeout = (file: string, budgetMs: number): boolean => {
    if (totalMatches === 0) return false;
    budgetStop = {
      cause: `the pattern ran past the ${budgetMs}ms budget for ${file}`,
      unread: `the rest of ${file} and the files after it`,
    };
    return true;
  };
  /** The same, for the search's whole budget running out between runs rather than inside one. */
  const stopOnSearchBudget = (file: string, midFile: boolean): void => {
    budgetStop = {
      cause: `the search's budget was spent after ${elapsedMatchingMs()}ms of matching`,
      unread: midFile
        ? `the rest of ${file} and the files after it`
        : `${file} and the files after it`,
    };
  };

  for (let fileIndex = 0; fileIndex < inWorkspaceFiles.length; fileIndex++) {
    if (totalMatches >= headLimit) break;
    if (budgetSpent()) {
      // A search that spent its whole budget without a single run running out of time still has
      // partial results to report, so the page names what it did not reach.
      if (totalMatches > 0) {
        stopOnSearchBudget(inWorkspaceFiles[fileIndex].file, false);
        break;
      }
      return regexTimeoutFailure(pattern, elapsedMatchingMs());
    }
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
    let stopped = false;

    if (multiline) {
      // A multiline match is a match across the file, so the sandbox holds the whole of it and
      // the line counting below is what the caller can still be interrupted during. A pattern that
      // backtracks here is what the per-file budget is for.
      const budget = budgetForNextRun();
      const started = Date.now();
      const outcome = sandbox.run(
        { pattern, flags: 'gms', limit: headLimit - totalMatches, multiline: true, text: content },
        budget,
      );
      regexBudgetLeft -= Date.now() - started;
      if (outcome.kind === 'timeout') {
        if (!stopOnTimeout(file, budget)) return regexTimeoutFailure(pattern, budget);
        stopped = true;
      }
      if (outcome.kind === 'invalid') {
        return toolFailure(`Invalid regex: ${pattern}`, { code: 'invalid_regex' });
      }
      if (outcome.kind === 'ok') {
        let line = 1;
        let countedUntil = 0;
        let iterations = 0;
        for (const match of outcome.matches) {
          const matchIndex = match.index ?? 0;
          for (let index = countedUntil; index < matchIndex; index++) {
            if (content.charCodeAt(index) === 10) line++;
            if (index > countedUntil && index % LINE_YIELD_INTERVAL === 0) {
              await yieldToEventLoop(ctx.signal);
            }
          }
          countedUntil = matchIndex;
          matches.push({ line, text: clipGrepText((match.text ?? '').replace(/\n/g, '\\n')) });
          totalMatches++;
          iterations++;
          if (totalMatches >= headLimit) break;
          if (iterations % PATH_YIELD_INTERVAL === 0) await yieldToEventLoop(ctx.signal);
        }
      }
    } else {
      // Line by line, in batches as long as the yield interval the loop used to keep: a batch is
      // one sandbox run, so a slow pattern is interrupted between batches rather than at the end
      // of the file.
      for (let batchStart = 0; batchStart < lines.length; batchStart += LINE_YIELD_INTERVAL) {
        if (budgetSpent()) {
          if (totalMatches > 0) {
            stopOnSearchBudget(file, true);
            stopped = true;
            break;
          }
          return regexTimeoutFailure(pattern, elapsedMatchingMs());
        }
        const budget = budgetForNextRun();
        const batch = lines.slice(batchStart, batchStart + LINE_YIELD_INTERVAL);
        const started = Date.now();
        const outcome = sandbox.run(
          {
            pattern,
            flags: 'g',
            limit: headLimit - totalMatches,
            multiline: false,
            lines: batch,
          },
          budget,
        );
        regexBudgetLeft -= Date.now() - started;
        if (outcome.kind === 'timeout') {
          if (!stopOnTimeout(file, budget)) return regexTimeoutFailure(pattern, budget);
          stopped = true;
          break;
        }
        if (outcome.kind === 'invalid') {
          return toolFailure(`Invalid regex: ${pattern}`, { code: 'invalid_regex' });
        }
        for (const match of outcome.matches) {
          const lineIndex = batchStart + (match.line ?? 0);
          matches.push({ line: lineIndex + 1, text: clipGrepText(lines[lineIndex]) });
          totalMatches++;
          if (totalMatches >= headLimit) break;
        }
        if (totalMatches >= headLimit) break;
        // The last batch of a file is followed at once by the per-file yield below, so yielding
        // here as well would spend two yields on one boundary of the loop.
        if (batchStart + LINE_YIELD_INTERVAL >= lines.length) break;
        await yieldToEventLoop(ctx.signal);
      }
    }

    if (matches.length > 0) {
      matchesByFile.set(file, {
        matches,
        lines: outputMode === 'content' ? lines : undefined,
      });
    }
    if (stopped) break;
    await yieldToEventLoop(ctx.signal);
  }

  const serializedMatches = Object.fromEntries(
    Array.from(matchesByFile.entries()).map(([file, result]) => [
      file,
      { matches: result.matches },
    ]),
  );

  const partialNotice = budgetStop ? regexPartialNotice(budgetStop) : '';

  if (outputMode === 'count') {
    const lines = Array.from(matchesByFile.entries()).map(
      ([file, result]) => `${file}:${result.matches.length}`,
    );
    const data: GrepCounts = { mode: outputMode, totalMatches, matches: serializedMatches };
    return toolSuccess(
      [lines.join('\n'), partialNotice].filter(Boolean).join('\n') || 'No matches found',
      {
        data,
        pagination: { truncated: budgetStop !== undefined },
        presentation: grepPresentation(data),
      },
    );
  }

  if (outputMode === 'files_with_matches') {
    const matchedFiles = Array.from(matchesByFile.keys());
    const data: GrepCounts = { mode: outputMode, files: matchedFiles };
    return toolSuccess(
      [matchedFiles.join('\n'), partialNotice].filter(Boolean).join('\n') || 'No matches found',
      {
        data,
        pagination: { truncated: budgetStop !== undefined },
        presentation: grepPresentation(data),
      },
    );
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
    ? '... (truncated at 50 KB; refine pattern or include)'
    : '';
  const data: GrepCounts = { mode: outputMode, totalMatches, matches: serializedMatches };
  return toolSuccess(
    [output.join('\n'), truncationNotice, partialNotice].filter(Boolean).join('\n') ||
      'No matches found',
    {
      data,
      pagination: {
        truncated: totalMatches >= headLimit || outputTruncated || budgetStop !== undefined,
      },
      presentation: grepPresentation(data),
    },
  );
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

/**
 * The lines the reader dropped for being over the cap, as the model is told about them (#349).
 *
 * A dropped line is a result the search looked at and could not show, so the page says so instead
 * of reporting a search that appears to have seen everything. It matters most when the dropped
 * line was the only event: "No matches found" would answer a question about the files that this
 * search never finished asking.
 */
function grepDroppedEventsNotice(droppedLines: number): string {
  const plural = droppedLines === 1 ? 'event' : 'events';
  return `(${droppedLines} ${plural} skipped: line over ${GREP_EVENT_MAX_CHARS / (1024 * 1024)} MiB)`;
}

/**
 * The longest ripgrep event the reader will hold, in characters (#349).
 *
 * ripgrep writes one JSON event per line, so the reader accumulates until it sees a newline, and
 * one line can be a whole file: a minified bundle, a data fixture, a line of base64. The
 * accumulation is what makes that unbounded — not ripgrep, which is streaming, but the string the
 * reader keeps while it waits for the newline that ends the event.
 */
export const GREP_EVENT_MAX_CHARS = 1024 * 1024;

/**
 * The line splitter between ripgrep's stdout and `processEvent`.
 *
 * Every complete line is handed on, and the buffer between them is bounded: a line longer than
 * `maxChars` is dropped rather than held, and the reader stays in a discarding state until that
 * line's newline arrives, so the search continues with the events after it. The dropped line is
 * not emitted truncated either — a JSON prefix does not parse, and the reader treats a parse
 * failure as "ripgrep is not what we asked it to be" and falls back to the portable backend, which
 * re-runs the same search under the budgets of the vm sandbox rather than ripgrep's.
 */
export class RipgrepLineReader {
  private pending = '';
  private discarding = false;
  private dropped = 0;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxChars: number = GREP_EVENT_MAX_CHARS,
  ) {}

  /** Characters held for the line being assembled; zero whenever the buffer is between lines. */
  get bufferedLength(): number {
    return this.pending.length;
  }

  /** True while the tail of an oversized line is being skipped, up to its newline. */
  get isDiscarding(): boolean {
    return this.discarding;
  }

  /** How many lines over the cap this reader has dropped. */
  get droppedLines(): number {
    return this.dropped;
  }

  push(chunk: string): void {
    let start = 0;
    while (start < chunk.length) {
      if (this.discarding) {
        const newline = chunk.indexOf('\n', start);
        if (newline < 0) return;
        this.discarding = false;
        start = newline + 1;
        continue;
      }
      const newline = chunk.indexOf('\n', start);
      if (newline < 0) {
        this.append(chunk.slice(start));
        return;
      }
      // A part that crosses the cap is dropped, and the newline this chunk already carries is the
      // end of that line: the drop stops here rather than eating the lines after it.
      const dropped = this.append(chunk.slice(start, newline));
      start = newline + 1;
      if (dropped) {
        this.discarding = false;
        continue;
      }
      const line = this.pending;
      this.pending = '';
      if (line) this.onLine(line);
    }
  }

  /** Appends a part, reporting whether the cap stopped it from being held. */
  private append(part: string): boolean {
    if (this.pending.length + part.length > this.maxChars) {
      this.pending = '';
      this.discarding = true;
      this.dropped++;
      return true;
    }
    this.pending += part;
    return false;
  }
}

function stopSearchProcess(proc: ChildProcess): void {
  if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
}

export interface RipgrepArgOptions {
  pattern: string;
  includePattern: string;
  contextBefore: number;
  contextAfter: number;
  multiline: boolean;
  /** The scope's path relative to the root ripgrep runs in; '' for the root itself. */
  relativePath: string;
}

/**
 * The argv of one `rg` call, as a pure function of the search's options.
 *
 * The path is the one operand here that a model chooses, so it goes last, behind a `--`. Without
 * the separator a repository that commits a directory named `--pre=.` beside an executable `x`
 * turns `path: "--pre=./x"` into the option `--pre=./x`, and ripgrep runs `./x` as a preprocessor
 * on every file it searches (#324) — with no prompt, because workspace Grep is auto-allowed. The
 * pattern and the include are behind `--regexp` and `--glob` for the same reason: a value that
 * starts with `-` stays data.
 *
 * `--no-config` closes what the environment rather than the model can add: a `RIPGREP_CONFIG_PATH`
 * handed down in this process is a file of flags read ahead of the command line, so a `--pre`
 * there lands in front of the separator, and a `--json` of its own would leave Book parsing
 * output it did not ask for.
 */
export function buildRipgrepArgs(options: RipgrepArgOptions): string[] {
  const argv = [
    '--json',
    '--hidden',
    '--no-config',
    '--regexp',
    options.pattern,
    '--glob',
    options.includePattern,
  ];
  for (const ignored of GREP_DEFAULT_IGNORES) argv.push('--glob', `!${ignored}`);
  if (options.contextBefore > 0) argv.push('--before-context', String(options.contextBefore));
  if (options.contextAfter > 0) argv.push('--after-context', String(options.contextAfter));
  if (options.multiline) argv.push('--multiline', '--multiline-dotall');
  // A bare `-` is ripgrep's own spelling of stdin, separator or not, and this rg has stdin
  // ignored — so a workspace file named `-` would report no matches at all. `./-` is that file.
  argv.push('--', options.relativePath === '-' ? './-' : options.relativePath || '.');
  return argv;
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
  const roots = grepRoots(ctx);

  const rgArgs = buildRipgrepArgs({
    pattern,
    includePattern,
    contextBefore,
    contextAfter,
    multiline,
    relativePath: scope.relativePath,
  });

  return new Promise<RipgrepOutcome>((resolve, reject) => {
    const proc = spawn('rg', rgArgs, {
      cwd: scope.root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: buildChildEnv(process.env, ctx.env),
    });
    let settled = false;
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
      // ripgrep reports paths relative to its `cwd`, which is the scope's root — not necessarily
      // the workspace — so the path is rejoined to that root before it is resolved (#300).
      const resolved = resolveReadablePath(roots, join(scope.root, rawPath.replaceAll('\\', '/')));
      if (!resolved) return;
      if (isBookLocalSettingsUnderRoots(resolved.canonicalPath, roots)) return;
      const file = readableLabel(resolved);

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
    const reader = new RipgrepLineReader((line) => {
      // The reader hands over every line of a chunk, and a parse failure means the rest of them
      // are not worth reading: the outcome is the portable backend's search, not this one's.
      if (settled) return;
      try {
        processEvent(JSON.parse(line) as RipgrepJsonEvent);
      } catch {
        stopSearchProcess(proc);
        finish({ kind: 'fallback' });
      }
    });
    proc.stdout?.on('data', (chunk: string) => reader.push(chunk));
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
      const droppedNotice =
        reader.droppedLines > 0 ? grepDroppedEventsNotice(reader.droppedLines) : '';
      const droppedTruncated = reader.droppedLines > 0;
      if (outputMode === 'count') {
        const lines = Array.from(matchesByFile.entries()).map(
          ([file, result]) => `${file}:${result.matches.length}`,
        );
        const data: GrepCounts = { mode: outputMode, totalMatches, matches: serializedMatches };
        finish({
          kind: 'success',
          result: toolSuccess(
            [lines.join('\n'), droppedNotice].filter(Boolean).join('\n') || 'No matches found',
            {
              data,
              pagination: { truncated: totalMatches >= headLimit || droppedTruncated },
              presentation: grepPresentation(data),
            },
          ),
        });
        return;
      }
      if (outputMode === 'files_with_matches') {
        const matchedFiles = Array.from(matchesByFile.keys());
        const data: GrepCounts = { mode: outputMode, files: matchedFiles };
        finish({
          kind: 'success',
          result: toolSuccess(
            [matchedFiles.join('\n'), droppedNotice].filter(Boolean).join('\n') ||
              'No matches found',
            {
              data,
              pagination: { truncated: totalMatches >= headLimit || droppedTruncated },
              presentation: grepPresentation(data),
            },
          ),
        });
        return;
      }
      const truncationNotice = outputTruncated
        ? '... (truncated at 50 KB; refine pattern or include)'
        : '';
      const data: GrepCounts = { mode: outputMode, totalMatches, matches: serializedMatches };
      finish({
        kind: 'success',
        result: toolSuccess(
          [output.join('\n'), truncationNotice, droppedNotice].filter(Boolean).join('\n') ||
            'No matches found',
          {
            data,
            pagination: {
              truncated: totalMatches >= headLimit || outputTruncated || droppedTruncated,
            },
            presentation: grepPresentation(data),
          },
        ),
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
          type: 'integer',
          minimum: 1,
          description:
            'Line number to start reading from (1-indexed). Leave unset unless the file is larger than one Read returns (2000 lines or 50 KB); a Read that stops early names the offset to continue from.',
          default: 1,
        },
        limit: {
          type: 'integer',
          minimum: 1,
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
