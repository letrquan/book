import { readFileSync, statSync } from 'fs';
import { exec } from 'child_process';
import { createHash } from 'crypto';
import { isAbsolute, relative, resolve } from 'path';
import { buildChildEnv } from '../child-env.js';
import { renderUntrustedText } from '../hook-approvals.js';
import { findRepositoryRoot, tryRealPath } from '../repo-containment.js';
import type { FileObservation } from '../types/tools.js';
import { observationPathFor, workspaceIdentity } from '../tools/file-provenance.js';
import { isOutside, resolveMentionReadablePath } from '../tools/path-utils.js';
import { committedFileStates, type CommittedState } from './committed-files.js';
import { reachesUncPath } from '../unc-path.js';
import { normalizeMentionPath, resolveWorkspaceMentionPath } from './file-mentions.js';

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

/** Where mentions may reach, beyond the workspace, and whose text they are in. */
export interface MentionScope {
  /**
   * The honored `additionalDirectories`, as resolved real roots (`resolveAdditionalRoots`): the
   * same roots Read serves besides the workspace.
   */
  additionalRoots?: readonly string[];
  /**
   * The text is the resolved body of a project command (`.book/commands/*.md`), which the
   * repository wrote: a mention in it inlines only a file git has committed, unchanged (#564).
   */
  projectCommand?: boolean;
}

/**
 * Why a mention of a file that is there was left as written.
 *
 * - `outside`: its real path is outside the workspace and every `additionalDirectories` entry,
 *   where Read would not open it either.
 * - `unc`: on Windows, it is, or reaches through a link, a network (UNC) path.
 * - `no-repository`, `untracked`, `changed`, `git-failed`: in a project command's body, it is not a
 *   file git has committed, unchanged, or git could not say (#564).
 */
export type MentionRefusalReason =
  'outside' | 'unc' | 'no-repository' | 'untracked' | 'changed' | 'git-failed';

export interface RefusedMention {
  /** The path as the mention spelled it. */
  path: string;
  reason: MentionRefusalReason;
}

const REFUSAL_TEXT: Record<MentionRefusalReason, string> = {
  outside: 'it is outside the workspace and additionalDirectories',
  unc: 'it is, or links to, a network (UNC) path',
  'no-repository':
    'a project command inlines only files committed to git, and there is no repository',
  untracked: 'a project command inlines only files committed to git, and git does not track it',
  changed: 'a project command inlines only committed files without local changes, and it has some',
  'git-failed': 'a project command inlines only committed files, and git could not check it',
};

/**
 * The one-line notice for a mention left as written. The path can come from a repository's
 * command file, so it is shown without control characters.
 */
export function formatRefusedMentionNotice(refused: RefusedMention): string {
  return `⚠  Left @${renderUntrustedText(refused.path, 400)} as written: ${REFUSAL_TEXT[refused.reason]}.`;
}

/**
 * The absolute path a mention names, and the workspace-relative name it is shown and observed by.
 * `null` for a path that, as written, is in neither the workspace nor an `additionalDirectories`
 * entry: it is never probed, so a token like `\\server\share` makes no network request, and a
 * relative path stays anchored to the workspace, as it does for Read.
 */
function mentionTarget(
  workspace: string,
  mentionPath: string,
  additionalRoots: readonly string[],
): { filePath: string; relativePath: string } | null {
  const inWorkspace = resolveWorkspaceMentionPath(workspace, mentionPath);
  if (inWorkspace) return inWorkspace;
  const normalized = mentionPath.replace(/\\/g, '/');
  if (!isAbsolute(normalized)) return null;
  const filePath = resolve(normalized);
  if (!additionalRoots.some((root) => !isOutside(root, filePath))) return null;
  return { filePath, relativePath: normalizeMentionPath(relative(resolve(workspace), filePath)) };
}

/** What becomes of one mention. `null`: it stays as written, without a notice. */
type MentionDecision =
  | { kind: 'file'; realPath: string; relativePath: string; regular: boolean }
  | { kind: 'refused'; reason: MentionRefusalReason }
  | null;

/**
 * The file a mention names, by the boundary Read uses (#567): its real path must be inside the
 * workspace or an `additionalDirectories` entry (`resolveMentionReadablePath`), so a committed
 * `docs/conventions.txt -> ../../.ssh/id_rsa` (#559), or a package's link to a file elsewhere in
 * the monorepo, inlines only when Read would open it. The real path is resolved first
 * (`tryRealPath`), and it is what is checked and later read: a path whose real path cannot be had
 * is left alone rather than judged by its spelling. A path Read would refuse is refused with a
 * notice; a missing path and a directory (a `@Test` annotation matches a `test/` directory
 * case-insensitively on Windows and macOS) stay as written, silently.
 */
function decideMention(
  workspace: string,
  mentionPath: string,
  additionalRoots: readonly string[],
): MentionDecision {
  const target = mentionTarget(workspace, mentionPath, additionalRoots);
  if (!target) return null;
  if (reachesUncPath(target.filePath)) return { kind: 'refused', reason: 'unc' };
  const realPath = tryRealPath(target.filePath);
  if (realPath === undefined) return null;
  let regular: boolean;
  try {
    const stat = statSync(realPath);
    if (stat.isDirectory()) return null;
    regular = stat.isFile();
  } catch {
    return null;
  }
  const readable = resolveMentionReadablePath(
    { workspaceRoot: workspace, additionalRoots },
    realPath,
  );
  if (!('path' in readable)) {
    return { kind: 'refused', reason: readable.reason === 'unc' ? 'unc' : 'outside' };
  }
  return { kind: 'file', realPath, relativePath: target.relativePath, regular };
}

/**
 * The project-command rule (#564) over the files a body's mentions reached: each must be a file of
 * the workspace's repository (`findRepositoryRoot`, so a dotfiles `~/.git` is none) that git has
 * committed, unchanged. Judged on the real path, which is the file the read serves, so a committed,
 * unmodified link to an untracked `.env` is refused like `@.env` itself. Fails closed: with no
 * repository, or when git cannot answer, every one is refused.
 */
async function applyProjectCommandRule(
  workspace: string,
  decisions: MentionDecision[],
  signal?: AbortSignal,
): Promise<MentionDecision[]> {
  const files = decisions.filter(
    (decision): decision is Extract<MentionDecision, { kind: 'file' }> => decision?.kind === 'file',
  );
  if (files.length === 0) return decisions;
  const refuse = (reason: MentionRefusalReason) =>
    decisions.map((decision) =>
      decision?.kind === 'file' ? { kind: 'refused' as const, reason } : decision,
    );
  const repoRoot = findRepositoryRoot(workspace);
  if (repoRoot === undefined) return refuse('no-repository');

  const inRepository = (realPath: string) =>
    isOutside(repoRoot, realPath) ? undefined : relative(repoRoot, realPath).replace(/\\/g, '/');
  // Only regular files go to git: `hash-object` would block on a FIFO. Anything else is refused.
  const paths = new Set<string>();
  for (const file of files) {
    const path = file.regular ? inRepository(file.realPath) : undefined;
    if (path !== undefined) paths.add(path);
  }
  let states: Map<string, CommittedState | 'git-failed'>;
  try {
    states = await committedFileStates(repoRoot, [...paths], signal);
  } catch {
    // One unreadable or vanished file fails the whole batch, so each is asked about on its own,
    // and only the ones git cannot answer for are refused as such.
    states = new Map();
    for (const path of paths) {
      try {
        states.set(path, (await committedFileStates(repoRoot, [path], signal)).get(path)!);
      } catch {
        states.set(path, 'git-failed');
      }
    }
  }
  return decisions.map((decision) => {
    if (decision?.kind !== 'file') return decision;
    const path = inRepository(decision.realPath);
    const state = path === undefined ? 'untracked' : (states.get(path) ?? 'untracked');
    return state === 'unchanged' ? decision : { kind: 'refused', reason: state };
  });
}

/** Where an observation is filed, and what it is credited to. */
interface ObservationScope {
  workspace: string;
  workspaceId: string;
  sourceRef: string;
}

/** The text a mention is replaced with, and its observation; `null` text leaves it as written. */
function inlineMention(
  token: MentionToken,
  decision: MentionDecision,
  scope: ObservationScope,
): { text: string | null; observation?: FileObservation } {
  if (decision?.kind !== 'file') return { text: null };
  if (!decision.regular) {
    return { text: formatMentionError(decision.relativePath, 'path is not a regular file') };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(decision.realPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: formatMentionError(token.path, message.slice(0, 200) || 'unable to read file') };
  }
  const observation: FileObservation = {
    // Filed the way Read and Edit file and look a file up (`observationPathFor`): canonical, so a
    // mention through a link, or of a file in an `additionalDirectories` entry, counts as seen.
    path: observationPathFor(scope.workspace, decision.realPath),
    workspaceId: scope.workspaceId,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: bytes.byteLength,
    operation: 'mention',
    sourceRef: scope.sourceRef,
    timestamp: Date.now(),
  };
  const content = bytes.toString('utf-8');
  if (looksBinary(content)) {
    return {
      text: formatMentionError(decision.relativePath, 'file appears to be binary'),
      observation,
    };
  }
  const truncated = content.length > AT_MENTION_CHAR_LIMIT;
  const body = truncated ? content.slice(0, AT_MENTION_CHAR_LIMIT) : content;
  const suffix = truncated
    ? `\n\n[File truncated at ${AT_MENTION_CHAR_LIMIT} characters; use the Read tool for more.]`
    : '';
  return {
    text: `\nContents of ${decision.relativePath}:\n\n\`\`\`\n${body}${suffix}\n\`\`\`\n`,
    observation,
  };
}

/**
 * Offsets of the at-sign tokens that name a path, outside fenced and inline code:
 * the same tokens `expandUserInput` considers, without looking at the disk. The TUI
 * accents these in a user turn.
 */
export function mentionTokenRanges(input: string): Array<[number, number]> {
  return findMentionTokens(input).map((token) => [token.start, token.end]);
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

export interface UserInputExpansion extends MentionScope {
  /** Replace `!cmd` lines with their output. Off for a host that never expands them. */
  expandShell?: boolean;
  signal?: AbortSignal;
  /** Recorded on each mention's observation: the user message the text belongs to. */
  sourceRef?: string;
}

/** The expanded text, the files it inlined, and the mentions it left as written with a reason. */
export interface ExpandedUserInput {
  text: string;
  /** Provenance for each inlined file, so a later Edit counts it as observed. */
  observations: FileObservation[];
  /** One per refused mention, in order; `formatRefusedMentionNotice` words each. */
  refused: RefusedMention[];
}

/**
 * Expand what the user typed, or a command body, in one pass and in one order.
 *
 * `!cmd` lines run, `@path` mentions are inlined, and both are found on the
 * typed text — never on the result of the other. A file's contents must not run
 * as commands, and a command's output must not be read as the user's own
 * mentions: `@notes.md` is expanded where it was typed and its `!` lines stay
 * text, and `!cat @notes.md` prints the path rather than the file (#261).
 *
 * A mention inlines only a regular file Read would open (`decideMention`), and in
 * a project command's body only one git has committed, unchanged
 * (`applyProjectCommandRule`). The files inlined are observed from the same
 * decisions, so a mention left as written is never observed either.
 */
export async function expandUserInputDetailed(
  input: string,
  workspace: string,
  options: UserInputExpansion = {},
): Promise<ExpandedUserInput> {
  // A project command's body never runs `!` lines: they are not the shell its approval covers
  // (`extractShellInjections`), and print mode never ran them. That also keeps every file the
  // rule below checked exactly as it was when it is read.
  const shellLines = options.expandShell && !options.projectCommand ? findShellLines(input) : [];
  const tokens = findMentionTokens(input, shellLineRanges(shellLines));
  if (shellLines.length === 0 && tokens.length === 0) {
    return { text: input, observations: [], refused: [] };
  }

  const additionalRoots = options.additionalRoots ?? [];
  const decide = (token: MentionToken) => decideMention(workspace, token.path, additionalRoots);
  // Typed text is decided mention by mention, in order, so a mention after a `!` line sees what
  // the line did (`!echo x > new.md` then `@new.md`); a project command's body has no `!` lines
  // to wait for, and its rule asks git about every file at once.
  const decided = options.projectCommand
    ? await applyProjectCommandRule(workspace, tokens.map(decide), options.signal)
    : undefined;

  const scope = {
    workspace,
    workspaceId: workspaceIdentity(workspace),
    sourceRef: options.sourceRef ?? '',
  };
  const observations: FileObservation[] = [];
  const refused: RefusedMention[] = [];
  // One left-to-right walk of the typed text, replacing each `!` line and each
  // mention where it was written. Output is inserted, never rescanned, so the
  // spans below can never overlap and are already in order.
  const edits: Array<{ start: number; end: number; apply: () => string | Promise<string> }> = [
    ...shellLines.map((line) => ({
      start: line.start,
      end: line.end,
      apply: () => executeShellExpansion(line.command, workspace, options.signal),
    })),
    ...tokens.map((token, index) => ({
      start: token.start,
      end: token.end,
      apply: () => {
        const decision = decided ? decided[index] : decide(token);
        if (decision?.kind === 'refused')
          refused.push({ path: token.path, reason: decision.reason });
        const inlined = inlineMention(token, decision, scope);
        if (inlined.observation) observations.push(inlined.observation);
        return inlined.text ?? token.raw;
      },
    })),
  ].sort((left, right) => left.start - right.start);

  let output = '';
  let cursor = 0;
  for (const edit of edits) {
    output += input.slice(cursor, edit.start);
    output += await edit.apply();
    // A token's trailing punctuation is outside `end`, so it rides along in the
    // next slice, after the mention it followed.
    cursor = edit.end;
  }
  return { text: output + input.slice(cursor), observations, refused };
}

/** {@link expandUserInputDetailed}, for a caller that needs only the text. */
export async function expandUserInput(
  input: string,
  workspace: string,
  options: UserInputExpansion = {},
): Promise<string> {
  return (await expandUserInputDetailed(input, workspace, options)).text;
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
        // The `!command` the user typed is theirs, so it must not inherit the NODE_ENV Book
        // defaulted for its own renderer.
        env: buildChildEnv(),
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
