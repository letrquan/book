import { existsSync, readFileSync, statSync } from 'fs';
import { exec } from 'child_process';
import { createHash } from 'crypto';
import type { FileObservation } from '../types/tools.js';
import { workspaceIdentity } from '../tools/file-provenance.js';
import { resolveWorkspaceMentionPath } from './file-mentions.js';

const AT_MENTION_CHAR_LIMIT = 20_000;

interface MentionToken {
  start: number;
  end: number;
  path: string;
  raw: string;
  trailing: string;
}

function isMentionBoundary(input: string, index: number): boolean {
  if (index === 0) return true;
  return /[\s([{<"']/.test(input[index - 1]);
}

function splitTrailingPunctuation(token: string): { path: string; trailing: string } {
  let end = token.length;
  while (end > 0 && /[.,;:!?)]/.test(token[end - 1])) end--;
  return { path: token.slice(0, end), trailing: token.slice(end) };
}

/**
 * Half-open offset ranges covered by code: fenced blocks, and inline code spans
 * in the text between them. An at-sign inside one of these is code (#261), not
 * a mention of a file.
 */
function codeRanges(input: string): Array<[number, number]> {
  const fenced = fencedCodeRanges(input);
  const inline: Array<[number, number]> = [];

  let cursor = 0;
  for (const [start, end] of fenced) {
    collectParagraphInlineCodeSpans(input.slice(cursor, start), cursor, inline);
    cursor = end;
  }
  collectParagraphInlineCodeSpans(input.slice(cursor), cursor, inline);

  return [...fenced, ...inline];
}

/**
 * A code span never crosses a blank line (CommonMark), so each paragraph of a
 * segment is scanned on its own: a lone backtick in one paragraph must not pair
 * with one in the next.
 */
function collectParagraphInlineCodeSpans(
  segment: string,
  base: number,
  ranges: Array<[number, number]>,
): void {
  const blankLine = /\n[ \t]*\r?\n/g;
  let start = 0;
  let separator: RegExpExecArray | null;
  while ((separator = blankLine.exec(segment)) !== null) {
    collectInlineCodeSpans(segment.slice(start, separator.index), base + start, ranges);
    start = separator.index + separator[0].length;
  }
  collectInlineCodeSpans(segment.slice(start), base + start, ranges);
}

/** A run of 3+ backticks or tildes opens a fence that runs to its closing line. */
function fencedCodeRanges(input: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let fence: { start: number; char: string; length: number } | null = null;
  let offset = 0;

  while (offset < input.length) {
    const newline = input.indexOf('\n', offset);
    const lineEnd = newline === -1 ? input.length : newline;
    const rangeEnd = newline === -1 ? input.length : newline + 1;
    const line = input.slice(offset, lineEnd).replace(/\r$/, '');

    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        ranges.push([fence.start, rangeEnd]);
        fence = null;
      }
    } else {
      // CommonMark: a backtick fence's info string may not contain a backtick.
      const open = /^ {0,3}(?:(`{3,})(?!.*`)|(~{3,}))/.exec(line);
      if (open) {
        const run = open[1] ?? open[2];
        fence = { start: offset, char: run[0], length: run.length };
      }
    }

    offset = rangeEnd;
  }

  if (fence) ranges.push([fence.start, input.length]);

  return ranges;
}

/** A backtick run opens a span that closes at the next run of the same length. */
function collectInlineCodeSpans(text: string, base: number, ranges: Array<[number, number]>): void {
  const runs = [...text.matchAll(/`+/g)];
  for (let i = 0; i < runs.length; i++) {
    const length = runs[i][0].length;
    for (let j = i + 1; j < runs.length; j++) {
      if (runs[j][0].length !== length) continue;
      ranges.push([base + (runs[i].index ?? 0), base + (runs[j].index ?? 0) + length]);
      i = j;
      break;
    }
  }
}

function isInsideRanges(ranges: Array<[number, number]>, index: number): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/**
 * `excluded` covers spans the caller has already spoken for — the `!` lines a
 * shell expansion replaces — so a mention inside one is never both run and
 * inlined, and is never observed either.
 */
function findMentionTokens(input: string, excluded: Array<[number, number]> = []): MentionToken[] {
  // Most prompts name no file at all, and every token below is anchored on an
  // at-sign, so the scan has nothing to find until one is present.
  if (!input.includes('@')) return [];
  const tokens: MentionToken[] = [];
  const code = codeRanges(input);
  let i = 0;

  while (i < input.length) {
    if (
      input[i] !== '@' ||
      !isMentionBoundary(input, i) ||
      isInsideRanges(code, i) ||
      isInsideRanges(excluded, i)
    ) {
      i++;
      continue;
    }

    const start = i;
    const afterAt = i + 1;
    if (afterAt >= input.length || /\s/.test(input[afterAt])) {
      i++;
      continue;
    }

    if (input[afterAt] === '"') {
      const close = input.indexOf('"', afterAt + 1);
      if (close === -1) {
        i++;
        continue;
      }
      const filePath = input.slice(afterAt + 1, close);
      if (!filePath) {
        i = close + 1;
        continue;
      }
      tokens.push({
        start,
        end: close + 1,
        path: filePath,
        raw: input.slice(start, close + 1),
        trailing: '',
      });
      i = close + 1;
      continue;
    }

    let end = afterAt;
    while (end < input.length && !/\s/.test(input[end])) end++;
    const rawPath = input.slice(afterAt, end);
    const { path, trailing } = splitTrailingPunctuation(rawPath);
    if (path) {
      tokens.push({
        start,
        end: end - trailing.length,
        path,
        raw: input.slice(start, end - trailing.length),
        trailing,
      });
    }
    i = end;
  }

  return tokens;
}

function formatMentionError(filePath: string, reason: string): string {
  return `\n[Could not include @${filePath}: ${reason}]\n`;
}

function looksBinary(content: string): boolean {
  return content.includes('\0');
}

/**
 * Returns null when the token names nothing a file's contents could be read
 * from, so it stays as written: a directory (a `@Test` annotation matches a
 * `test/` directory case-insensitively on Windows and macOS), a missing path,
 * and a path outside the workspace, which is never probed — a token like
 * `\\server\share` would otherwise make a network request for every prompt that
 * mentions one.
 */
function expandMention(filePath: string, workspace: string): string | null {
  const resolved = resolveWorkspaceMentionPath(workspace, filePath);
  if (!resolved) return null;
  if (!existsSync(resolved.filePath)) return null;

  try {
    const stat = statSync(resolved.filePath);
    if (stat.isDirectory()) return null;
    if (!stat.isFile())
      return formatMentionError(resolved.relativePath, 'path is not a regular file');

    const content = readFileSync(resolved.filePath, 'utf-8');
    if (looksBinary(content))
      return formatMentionError(resolved.relativePath, 'file appears to be binary');

    const truncated = content.length > AT_MENTION_CHAR_LIMIT;
    const body = truncated ? content.slice(0, AT_MENTION_CHAR_LIMIT) : content;
    const suffix = truncated
      ? `\n\n[File truncated at ${AT_MENTION_CHAR_LIMIT} characters; use the Read tool for more.]`
      : '';

    return `\nContents of ${resolved.relativePath}:\n\n\`\`\`\n${body}${suffix}\n\`\`\`\n`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return formatMentionError(filePath, message.slice(0, 200) || 'unable to read file');
  }
}

/**
 * Offsets of the at-sign tokens that name a path, outside fenced and inline code:
 * the same tokens `expandAtMentions` considers, without looking at the disk. The TUI
 * accents these in a user turn.
 */
export function mentionTokenRanges(input: string): Array<[number, number]> {
  return findMentionTokens(input).map((token) => [token.start, token.end]);
}

/**
 * Expand @path references to file contents in user input. Only a token outside
 * fenced and inline code that names a regular file inside the workspace is
 * expanded; a directory, a missing path and a path outside the workspace stay
 * exactly as the user wrote them (#261).
 */
export function expandAtMentions(input: string, workspace: string): string {
  const tokens = findMentionTokens(input);
  if (tokens.length === 0) return input;

  let output = '';
  let cursor = 0;
  for (const token of tokens) {
    output += input.slice(cursor, token.start);
    output += expandMention(token.path, workspace) ?? token.raw;
    output += token.trailing;
    cursor = token.end + token.trailing.length;
  }
  output += input.slice(cursor);
  return output;
}

/**
 * Provenance for the files `expandUserInput` inlined. `expandShellInput` must
 * be the same value that call was given, so a mention inside a `!` line — which
 * is run, never inlined — is observed neither (#261).
 */
export function collectAtMentionObservations(
  input: string,
  workspace: string,
  sourceRef: string,
  expandShellInput = false,
): FileObservation[] {
  const workspaceId = workspaceIdentity(workspace);
  const observations: FileObservation[] = [];
  const shellLines = expandShellInput ? findShellLines(input) : [];
  for (const token of findMentionTokens(input, shellLineRanges(shellLines))) {
    const resolved = resolveWorkspaceMentionPath(workspace, token.path);
    if (!resolved || !existsSync(resolved.filePath)) continue;
    try {
      const info = statSync(resolved.filePath);
      if (!info.isFile()) continue;
      const bytes = readFileSync(resolved.filePath);
      observations.push({
        path: resolved.relativePath,
        workspaceId,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteSize: bytes.byteLength,
        operation: 'mention',
        sourceRef,
        timestamp: Date.now(),
      });
    } catch {
      // Failed mentions are represented in expanded context, not provenance.
    }
  }
  return observations;
}

/** One `!cmd` line the user typed, with the span it occupies. */
interface ShellLine {
  start: number;
  end: number;
  command: string;
}

/** The `!cmd` lines of the typed input that a shell expansion will replace. */
function findShellLines(input: string): ShellLine[] {
  const fenced = fencedCodeRanges(input);
  return (
    [...input.matchAll(/^!(\S.*)$/gm)]
      // A `!` line inside fenced code is shown, not run (#261).
      .filter((match) => !isInsideRanges(fenced, match.index ?? 0))
      .map((match) => {
        const start = match.index ?? 0;
        return { start, end: start + match[0].length, command: match[1] };
      })
  );
}

function shellLineRanges(lines: ShellLine[]): Array<[number, number]> {
  return lines.map((line) => [line.start, line.end]);
}

export interface UserInputExpansion {
  /** Replace `!cmd` lines with their output. Off for a host that never expands them. */
  expandShell?: boolean;
  signal?: AbortSignal;
}

/**
 * Expand what the user typed, in one pass and in one order.
 *
 * `!cmd` lines run, `@path` mentions are inlined, and both are found on the
 * typed text — never on the result of the other. A file's contents must not run
 * as commands, and a command's output must not be read as the user's own
 * mentions: `@notes.md` is expanded where it was typed and its `!` lines stay
 * text, and `!cat @notes.md` prints the path rather than the file (#261).
 */
export async function expandUserInput(
  input: string,
  workspace: string,
  options: UserInputExpansion = {},
): Promise<string> {
  const shellLines = options.expandShell ? findShellLines(input) : [];
  const tokens = findMentionTokens(input, shellLineRanges(shellLines));
  if (shellLines.length === 0 && tokens.length === 0) return input;

  // One left-to-right walk of the typed text, replacing each `!` line and each
  // mention where it was written. Output is inserted, never rescanned, so the
  // spans below can never overlap and are already in order.
  const edits: Array<{ start: number; end: number; apply: () => string | Promise<string> }> = [
    ...shellLines.map((line) => ({
      start: line.start,
      end: line.end,
      apply: () => executeShellExpansion(line.command, workspace, options.signal),
    })),
    ...tokens.map((token) => ({
      start: token.start,
      end: token.end,
      apply: () => expandMention(token.path, workspace) ?? token.raw,
    })),
  ].sort((left, right) => left.start - right.start);

  let output = '';
  let cursor = 0;
  for (const edit of edits) {
    output += input.slice(cursor, edit.start);
    output += await edit.apply();
    // A token's trailing punctuation is outside `end`, so it rides along in the
    // next slice exactly as `expandAtMentions` leaves it.
    cursor = edit.end;
  }
  return output + input.slice(cursor);
}

/**
 * Expand !cmd shell commands to their output in user input.
 * Replaces lines starting with !<cmd> with the command's stdout.
 */
export async function expandShellCommands(
  input: string,
  workspace: string,
  signal?: AbortSignal,
): Promise<string> {
  const lines = findShellLines(input);
  if (lines.length === 0) return input;
  let output = '';
  let cursor = 0;
  for (const line of lines) {
    output += input.slice(cursor, line.start);
    output += await executeShellExpansion(line.command, workspace, signal);
    cursor = line.end;
  }
  return output + input.slice(cursor);
}

function executeShellExpansion(
  command: string,
  workspace: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        signal,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          const message = error.message.slice(0, 200) || 'unknown error';
          resolve(`(command '${command}' failed: ${message})`);
          return;
        }
        const value = stdout.trim();
        resolve(value || `(command '${command}' produced no output)`);
      },
    );
  });
}
