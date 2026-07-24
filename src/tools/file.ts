import { open, readFile as readTextFile, writeFile as writeTextFile } from 'fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { extname } from 'node:path';
import fg from 'fast-glob';
import type { ToolDefinition, ToolContext, ToolResult } from '../types/tools.js';
import { throwIfAborted, yieldToEventLoop } from '../async.js';
import { renderDiffWithStatsAsync } from './diff.js';
import { pathOutsideWorkspaceResult, resolveWorkspacePath } from './path-utils.js';
import { observeFile, requireFreshObservation } from './file-provenance.js';
import { toolFailure, toolSuccess } from './result.js';

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

async function readFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const resolved = resolveWorkspacePath(ctx.workspaceRoot, args.filePath as string);
  if (!resolved) return pathOutsideWorkspaceResult(args.filePath);
  const { filePath } = resolved;
  const offset = (args.offset as number) || 1;
  const limit = (args.limit as number) || 2000;

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
  const { filePath, relativePath } = resolved;
  const stale = await requireFreshObservation(ctx, filePath, relativePath);
  if (stale) return toolFailure(stale, { code: 'stale_file_observation' });
  let existed = true;
  let oldContent = '';
  try {
    oldContent = await readTextFile(filePath, 'utf-8');
  } catch (error) {
    if (isMissingFile(error)) {
      existed = false;
    } else {
      return toolFailure(
        `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const newContent = args.content as string;
  const { diff, stats } = await renderDiffWithStatsAsync(oldContent, newContent, 3, ctx.signal);
  throwIfAborted(ctx.signal);
  try {
    await writeTextFile(filePath, newContent, 'utf-8');
  } catch (error) {
    return toolFailure(
      `Failed to write file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const observation = await observeFile(ctx, filePath, existed ? 'write' : 'create');
  return toolSuccess(diff || 'File written successfully', {
    artifacts: {
      fileMutation: {
        kind: existed ? 'update' : 'create',
        filePath: relativePath,
        addedLines: stats.addedLines,
        removedLines: stats.removedLines,
      },
      fileObservations: [observation],
    },
  });
}

async function editFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const resolved = resolveWorkspacePath(ctx.workspaceRoot, args.filePath as string);
  if (!resolved) return pathOutsideWorkspaceResult(args.filePath);
  const { filePath, relativePath } = resolved;
  const stale = await requireFreshObservation(ctx, filePath, relativePath);
  if (stale) return toolFailure(stale, { code: 'stale_file_observation' });

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

  const oldStr = args.oldString as string;
  const newStr = args.newString as string;
  const replaceAll = (args.replaceAll as boolean) ?? false;

  if (!content.includes(oldStr)) {
    return toolFailure('oldString not found in file', { code: 'text_not_found' });
  }

  const occurrences = await countOccurrences(content, oldStr, ctx.signal);
  if (occurrences > 1 && !replaceAll) {
    return toolFailure(
      `oldString matches ${occurrences} times; set replaceAll: true to replace all, or make oldString more specific`,
      { code: 'ambiguous_text_match' },
    );
  }

  const newContent = replaceAll
    ? content.split(oldStr).join(newStr)
    : content.replace(oldStr, newStr);
  const { diff, stats } = await renderDiffWithStatsAsync(content, newContent, 3, ctx.signal);
  throwIfAborted(ctx.signal);
  try {
    await writeTextFile(filePath, newContent, 'utf-8');
  } catch (error) {
    return toolFailure(
      `Failed to write file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const observation = await observeFile(ctx, filePath, 'edit');
  return toolSuccess(diff || 'File edited successfully (no textual change)', {
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
}

async function multiEdit(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const resolved = resolveWorkspacePath(ctx.workspaceRoot, args.filePath as string);
  if (!resolved) return pathOutsideWorkspaceResult(args.filePath);
  const { filePath, relativePath } = resolved;
  const stale = await requireFreshObservation(ctx, filePath, relativePath);
  if (stale) return toolFailure(stale, { code: 'stale_file_observation' });
  const edits =
    (args.edits as Array<{
      oldString: string;
      newString: string;
      replaceAll?: boolean;
    }>) ?? [];
  if (edits.length === 0) {
    return toolFailure('No edits provided');
  }

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
  const original = content;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (!content.includes(edit.oldString)) {
      return toolFailure(
        `Edit ${i + 1}: oldString not found (no changes applied — MultiEdit is atomic)`,
        { code: 'text_not_found' },
      );
    }
    if (edit.replaceAll) {
      content = content.split(edit.oldString).join(edit.newString);
    } else {
      const occurrences = await countOccurrences(content, edit.oldString, ctx.signal);
      if (occurrences > 1) {
        return toolFailure(
          `Edit ${i + 1}: oldString matches ${occurrences} times; set replaceAll: true or be more specific (no changes applied — MultiEdit is atomic)`,
          { code: 'ambiguous_text_match' },
        );
      }
      content = content.replace(edit.oldString, edit.newString);
    }
    await yieldToEventLoop(ctx.signal);
  }

  const { diff, stats } = await renderDiffWithStatsAsync(original, content, 3, ctx.signal);
  throwIfAborted(ctx.signal);
  try {
    await writeTextFile(filePath, content, 'utf-8');
  } catch (error) {
    return toolFailure(
      `Failed to write file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const observation = await observeFile(ctx, filePath, 'edit');
  return toolSuccess(diff || 'File edited successfully (no textual change)', {
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
  const contextBefore = (args.B as number) ?? 0;
  const contextAfter = (args.A as number) ?? 0;
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

  const files = await fg(includePattern, {
    cwd: ctx.workspaceRoot,
    dot: true,
    ignore: [...GREP_DEFAULT_IGNORES, ...(ctx.gitignorePatterns ?? [])],
  });
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
  const contextBefore = Math.max(0, Math.floor((args.B as number) ?? 0));
  const contextAfter = Math.max(0, Math.floor((args.A as number) ?? 0));
  const multiline = (args.multiline as boolean) ?? false;
  const requestedHeadLimit = (args.head_limit as number) ?? GREP_MATCH_LIMIT;
  const headLimit = Math.min(
    GREP_MATCH_LIMIT,
    Math.max(1, Number.isFinite(requestedHeadLimit) ? Math.floor(requestedHeadLimit) : 1),
  );

  const rgArgs = ['--json', '--hidden', '--regexp', pattern, '--glob', includePattern];
  for (const ignored of GREP_DEFAULT_IGNORES) rgArgs.push('--glob', `!${ignored}`);
  if (contextBefore > 0) rgArgs.push('--before-context', String(contextBefore));
  if (contextAfter > 0) rgArgs.push('--after-context', String(contextAfter));
  if (multiline) rgArgs.push('--multiline', '--multiline-dotall');
  rgArgs.push('.');

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
    description:
      'Read a file from the workspace. Returns lines with line numbers. Supports offset/limit for large files.',
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
          description: 'Line number to start reading from (1-indexed)',
          default: 1,
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to read',
          default: 2000,
        },
      },
      required: ['filePath'],
    },
    execute: readFile,
  },
  {
    name: 'Write',
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
    description:
      'Replace exact text in an existing file. By default replaces the first occurrence; set replaceAll: true to replace every occurrence. Fails if oldString matches multiple times and replaceAll is not set. Returns a unified diff.',
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
    description:
      'Apply an ordered list of edits to one file atomically. If any edit fails, no changes are applied. Each edit supports replaceAll. Returns a unified diff of the net change.',
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
    description:
      'Search file contents for a regex pattern. output_mode: content (default), files_with_matches, or count. Supports context lines (-A/-B), multiline, and head_limit. Respects .gitignore.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
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
