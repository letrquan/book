import { open, readFile as readTextFile, stat } from 'fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { basename, extname } from 'node:path';
import fg from 'fast-glob';
import type { ToolDefinition, ToolContext, ToolResult } from '../types/tools.js';
import { throwIfAborted, yieldToEventLoop } from '../async.js';
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
import { toolFailure, toolSuccess } from './result.js';
import {
  readTextSnapshot,
  restoreTextEncoding,
  withMutationLocks,
  writeFileAtomically,
} from './mutation.js';

const GLOB_OUTPUT_LIMIT = 1000;
const PATH_YIELD_INTERVAL = 128;
const LINE_YIELD_INTERVAL = 2_048;
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
 * (#217). Markdown is outlined by its headings. Anything else: a line at
 * indentation zero that is not blank, closing punctuation or a comment is a
 * declaration in most languages this tool sees, and a shallowly indented
 * declaration line is the next tier. Bodies stay out: nothing deeper than
 * `OUTLINE_MAX_INDENT` is shown. The shapes each language gets are the
 * "outline contract" table in file.test.ts; a shape outside it is not promised.
 */
const OUTLINE_MAX_INDENT = 4;
/** A C# file with a block-scoped `namespace X {` indents every member one level deeper. */
const OUTLINE_MAX_INDENT_CSHARP_BLOCK_NAMESPACE = 8;
/** An outline is capped at the line count of a whole-file Read. */
const OUTLINE_MAX_ENTRIES = 2000;
/** How far below a wrapped signature its closing `)` line is looked for. */
const OUTLINE_SIGNATURE_LOOKAHEAD = 40;
const OUTLINE_MODIFIERS =
  '(?:(?:export|public|private|protected|internal|static|async|abstract|override|virtual|sealed|partial|readonly|final|pub|open|suspend|inline|operator|infix|data|inner|synchronized|native|default|extern|unsafe)\\s+)*';
// Statements shaped like a method line: `if (x) {`, `return (a) => {`, and with
// a space before the parenthesis, `foreach (var x in xs)`, `lock (gate)`, `when (x) {`.
// A method may still be called `lock()` or `match(pattern)`.
const OUTLINE_STATEMENT =
  '(?:(?:if|for|while|switch|catch|else|do|try|return|await|async)\\b|(?:foreach|using|lock|fixed|when|match|with|synchronized)\\s)';
// Words that start a statement where a return type would stand: `else if (`,
// `return new Foo(`, `go func() {`, `defer func() {`, Rust's `match parse(x) {`.
const OUTLINE_STATEMENT_WORD =
  '(?:if|else|elif|for|foreach|while|do|switch|case|when|match|catch|try|finally|return|await|yield|throw|new|delete|typeof|using|lock|fixed|synchronized|with|go|defer)\\b';
// Type arguments nested up to three deep: `Map<String, List<Set<Integer>>>`.
const OUTLINE_GENERIC = '<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>';
const OUTLINE_TYPE = `[A-Za-z_$][\\w$.]*(?:${OUTLINE_GENERIC})?(?:\\[\\])*\\??`;
// A keyword declaration. A keyword followed by `:`, `,`, `;`, `=`, `?`, `)` or
// the end of the line is an object key or an import-list member instead.
const OUTLINE_KEYWORD = new RegExp(
  `^\\s+${OUTLINE_MODIFIERS}(?:function|class|interface|enum|namespace|def|func|fn|fun|struct|impl|trait|describe|it|test|constructor|get|set)\\b(?!\\s*[:,;=?)]|\\s*$)`,
);
// A method named first: `name(`, `async *entries(`, `#secret(`, `map<K extends Record<string, V>>(`.
const OUTLINE_NAME_FIRST = new RegExp(
  `^\\s+${OUTLINE_MODIFIERS}(?!${OUTLINE_STATEMENT})(?:\\*\\s*)?#?[A-Za-z_$][\\w$]*\\s*(?:${OUTLINE_GENERIC})?\\s*\\(`,
);
// A method whose return type comes first (Java, C#, Dart): `int getN(`,
// `public static <T> List<T> wrap(`, `Future<void> load(`.
const OUTLINE_TYPE_FIRST = new RegExp(
  `^\\s+${OUTLINE_MODIFIERS}(?:${OUTLINE_GENERIC}\\s+)?(?!${OUTLINE_STATEMENT_WORD})${OUTLINE_TYPE}\\s+(?!(?:if|for|while|switch|catch)\\b)[A-Za-z_$][\\w$]*\\s*(?:${OUTLINE_GENERIC})?\\s*\\(`,
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
// Files named for their tool rather than given an extension: `Makefile`, `Dockerfile.dev`.
const HASH_COMMENT_BASENAME = /^(?:(?:gnu)?makefile|dockerfile|containerfile)(?:\.[\w.-]+)?$/i;
// Where a backtick opens a string that may run over several lines.
const TEMPLATE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
// Kotlin declares every function with `fun`, so a `name(args) {` line there is a
// call taking a trailing lambda (`repeat(3) {`), not a method.
const KEYWORD_ONLY_EXTENSIONS = new Set(['.kt', '.kts']);
// Java and C# declare interface and abstract methods without a body: `int size();`.
const BODILESS_METHOD_EXTENSIONS = new Set(['.java', '.cs']);
const FRONT_MATTER_KEY = /^[A-Za-z_][\w.-]*\s*:(?:\s|$)/;

interface OutlineProfile {
  hashComments: boolean;
  templates: boolean;
  keywordsOnly: boolean;
  bodilessMethods: boolean;
  maxIndent: number;
}

function outlineProfile(filePath: string, lines: readonly string[]): OutlineProfile {
  const name = basename(filePath);
  const extension = extname(name).toLowerCase();
  return {
    hashComments:
      HASH_COMMENT_EXTENSIONS.has(extension) ||
      HASH_COMMENT_BASENAME.test(name) ||
      (extension === '' && lines[0]?.startsWith('#!') === true),
    templates: TEMPLATE_EXTENSIONS.has(extension),
    keywordsOnly: KEYWORD_ONLY_EXTENSIONS.has(extension),
    bodilessMethods: BODILESS_METHOD_EXTENSIONS.has(extension),
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
// operator, an opening bracket, a keyword such as `return`, or nothing.
const REGEX_MAY_FOLLOW =
  /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|do|else|in|of|yield|await|void|throw|delete|instanceof))\s*$/;

/** The index of the `/` that closes a regex literal opening at `start`, or `start` when none does on the line. */
function regexEnd(line: string, start: number): number {
  let inClass = false;
  for (let index = start + 1; index < line.length; index++) {
    const char = line[index];
    if (char === '\\') index++;
    else if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) return index;
  }
  return start;
}

/**
 * For each line of a JavaScript or TypeScript file, whether it starts inside a
 * template literal or a block comment, so is text rather than code. A small
 * scanner, not a parser: a quoted string or a regex literal ends with its line.
 */
function textLines(lines: readonly string[]): boolean[] {
  const text: boolean[] = [];
  // A template, or the brace depth of a `${` expression inside one.
  const stack: Array<'template' | number> = [];
  let comment = false;
  for (const line of lines) {
    text.push(comment || stack.at(-1) === 'template');
    for (let index = 0; index < line.length; index++) {
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
        index = stringEnd(line, index);
      } else if (char === '`') {
        stack.push('template');
      } else if (char === '/' && REGEX_MAY_FOLLOW.test(line.slice(0, index))) {
        index = regexEnd(line, index);
      } else if (typeof top === 'number' && char === '{') {
        stack[stack.length - 1] = top + 1;
      } else if (typeof top === 'number' && char === '}') {
        if (top === 0) stack.pop();
        else stack[stack.length - 1] = top - 1;
      }
    }
  }
  return text;
}

/** Whether every parenthesis opened on the line is closed on it. */
function balancedParentheses(line: string): boolean {
  let depth = 0;
  for (const char of line) {
    if (char === '(') depth++;
    else if (char === ')') depth--;
  }
  return depth === 0;
}

/** The text after the parameter list opening at `open`, or undefined when it does not close on the line. */
function afterParameters(line: string, open: number): string | undefined {
  let depth = 0;
  for (let index = open; index < line.length; index++) {
    if (line[index] === '(') depth++;
    else if (line[index] === ')' && --depth === 0) return line.slice(index + 1);
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

function isShallowDeclaration(
  lines: readonly string[],
  index: number,
  indent: number,
  profile: OutlineProfile,
): boolean {
  const line = lines[index];
  if (OUTLINE_KEYWORD.test(line)) return true;
  if (profile.keywordsOnly) return false;
  if (OUTLINE_ARROW_MEMBER.test(line)) return true;
  const typeFirst = OUTLINE_TYPE_FIRST.exec(line);
  const method = typeFirst ?? OUTLINE_NAME_FIRST.exec(line);
  const head = method ?? OUTLINE_WRAPPED_ARROW.exec(line);
  if (!head) return false;
  const open = head[0].length - 1;
  // A parameter list that wraps onto the next lines counts once it closes into a body.
  if (!line.slice(open).includes(')')) return closesIntoBody(lines, index, indent);
  if (!method) return false;
  const tail = afterParameters(line, open);
  // Left open (`useEffect(() => {`) or chained (`foo(x).then(`): a call, not a signature.
  if (tail === undefined || !balancedParentheses(line) || /^\s*(?:\??\.|[,(])/.test(tail)) {
    return false;
  }
  if (/\{\s*$/.test(tail)) return true;
  if (!/[;{}=]/.test(tail) && opensBodyBelow(lines, index, indent)) return true;
  if (!typeFirst) return false;
  // `int Twice(int x) => x * 2;` (C#, Dart), and `int size();` (Java, C#).
  if (/^\s*=>/.test(tail)) return true;
  return profile.bodilessMethods && /^(?:\s*throws\s[^;]*)?\s*;\s*$/.test(tail);
}

function codeOutlineIndexes(lines: readonly string[], profile: OutlineProfile): number[] {
  const output: number[] = [];
  // Template text is content at any indentation, column 0 included.
  const text = profile.templates ? textLines(lines) : undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (text?.[index]) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (/^[}\])]+[;,]?$/.test(trimmed)) continue;
    if (/^(?:\/\/|\/\*|\*|--|<!--)/.test(trimmed)) continue;
    if (profile.hashComments && /^#(?!!)/.test(trimmed)) continue;
    // The closing line of a multi-line import is punctuation, not a declaration.
    if (/^\} from\b/.test(trimmed)) continue;
    // An Allman-style brace belongs to the line above it. Only a file that
    // opens with one (JSON) lists it.
    if (trimmed === '{' && output.length > 0) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      output.push(index);
      continue;
    }
    if (indent > profile.maxIndent) continue;
    if (isShallowDeclaration(lines, index, indent, profile)) output.push(index);
  }
  return output;
}

/**
 * Where Markdown content starts. A leading `---` opens front matter only when a
 * closing `---` (or `...`) follows and every line between reads as YAML, a
 * `key:` line first. Otherwise it is a horizontal rule and the headings after it count.
 */
function markdownContentStart(lines: readonly string[]): number {
  if (lines[0]?.trim() !== '---') return 0;
  const close = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
  if (close < 0) return 0;
  const body = lines.slice(1, close).filter((line) => line.trim().length > 0);
  const yaml =
    body.length > 0 &&
    FRONT_MATTER_KEY.test(body[0]) &&
    body.every(
      (line) => FRONT_MATTER_KEY.test(line) || /^\s+\S/.test(line) || /^-(?:\s|$)/.test(line),
    );
  return yaml ? close + 1 : 0;
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

function outlineLines(
  lines: readonly string[],
  filePath: string,
): Array<{ line: number; text: string }> {
  // A byte-order mark is not indentation: measure the first line from after it.
  const source =
    lines.length > 0 && lines[0].charCodeAt(0) === 0xfeff
      ? [lines[0].slice(1), ...lines.slice(1)]
      : lines;
  const indexes = MARKDOWN_EXTENSIONS.has(extname(filePath).toLowerCase())
    ? markdownOutlineIndexes(source)
    : codeOutlineIndexes(source, outlineProfile(filePath, source));
  return indexes.map((index) => ({ line: index + 1, text: source[index].trimEnd() }));
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
  const shown = entries.slice(0, OUTLINE_MAX_ENTRIES);
  const output = [
    `Outline of ${args.filePath}: ${lineCount} lines, ${shown.length} shown. An outline is not the file's content: Read the file (whole, or with offset/limit) before editing it.`,
    ...shown.map((entry) => `${entry.line}: ${entry.text}`),
  ];
  if (entries.length > shown.length) {
    output.push(
      `[Outline truncated at ${OUTLINE_MAX_ENTRIES} of ${entries.length} entries; the rest start at line ${entries[shown.length].line}. Read from there without outline, with offset/limit.]`,
    );
  }
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
  for (let index = offset - 1; index < end; index++) {
    output.push(`${index + 1}: ${lines[index]}`);
    if ((index - offset + 2) % LINE_YIELD_INTERVAL === 0) await yieldToEventLoop(ctx.signal);
  }
  const observation = await observeFile(ctx, filePath, 'read', {
    lineStart: offset,
    lineEnd: end,
  });
  return toolSuccess(output.join('\n'), {
    artifacts: { fileObservations: [observation] },
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
      'Read a file from the workspace. Returns lines with line numbers. The default reads the whole file (up to 2000 lines) in one call — read files whole; use offset/limit only for files longer than that, and never to read a file in small chunks. The "N: " line-number prefixes are display-only and are never part of the file content. Pass outline: true, without offset or limit, to survey a file\'s declarations (a Markdown file\'s headings) before deciding what to read; an outline is not a read, so Read the file before editing it.',
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
            'Line number to start reading from (1-indexed). Leave unset unless the file is longer than 2000 lines.',
          default: 1,
        },
        limit: {
          type: 'number',
          description:
            'Maximum number of lines to read. Leave unset to read the whole file; only set it for files longer than 2000 lines.',
          default: 2000,
        },
        outline: {
          type: 'boolean',
          description:
            "Return only the file's declarations with their line numbers (for Markdown, its headings), up to 2000 of them, to survey a file before deciding what to read in full. Cannot be combined with offset or limit. An outline does not count as reading the file: Edit and Write still need a Read.",
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
