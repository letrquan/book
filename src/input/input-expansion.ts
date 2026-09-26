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

function isInsideCode(ranges: Array<[number, number]>, index: number): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function findMentionTokens(input: string): MentionToken[] {
  const tokens: MentionToken[] = [];
  const code = codeRanges(input);
  let i = 0;

  while (i < input.length) {
    if (input[i] !== '@' || !isMentionBoundary(input, i) || isInsideCode(code, i)) {
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

export function collectAtMentionObservations(
  input: string,
  workspace: string,
  sourceRef: string,
): FileObservation[] {
  const workspaceId = workspaceIdentity(workspace);
  const observations: FileObservation[] = [];
  for (const token of findMentionTokens(input)) {
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

/**
 * Expand !cmd shell commands to their output in user input.
 * Replaces lines starting with !<cmd> with the command's stdout.
 */
export async function expandShellCommands(
  input: string,
  workspace: string,
  signal?: AbortSignal,
): Promise<string> {
  const fenced = fencedCodeRanges(input);
  const matches = [...input.matchAll(/^!(\S.*)$/gm)].filter(
    // A `!` line inside fenced code is shown, not run (#261).
    (match) => !isInsideCode(fenced, match.index ?? 0),
  );
  if (matches.length === 0) return input;
  let output = '';
  let cursor = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    const command = match[1];
    output += input.slice(cursor, index);
    output += await executeShellExpansion(command, workspace, signal);
    cursor = index + match[0].length;
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
