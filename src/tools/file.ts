import { readFile as readTextFile, writeFile as writeTextFile } from 'fs/promises';
import fg from 'fast-glob';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { throwIfAborted, yieldToEventLoop } from '../async.js';
import { renderDiffWithStatsAsync } from './diff.js';
import { pathOutsideWorkspaceResult, resolveWorkspacePath } from './path-utils.js';

const GLOB_OUTPUT_LIMIT = 1000;
const PATH_YIELD_INTERVAL = 128;
const LINE_YIELD_INTERVAL = 2_048;

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
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: isMissingFile(error)
        ? `File not found: ${args.filePath}`
        : `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  throwIfAborted(ctx.signal);
  const lines = content.split('\n');
  const end = Math.min(lines.length, offset - 1 + limit);
  const output: string[] = [];
  for (let index = offset - 1; index < end; index++) {
    output.push(`${index + 1}: ${lines[index]}`);
    if ((index - offset + 2) % LINE_YIELD_INTERVAL === 0) await yieldToEventLoop(ctx.signal);
  }
  return { toolCallId: '', success: true, output: output.join('\n') };
}

async function writeFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const resolved = resolveWorkspacePath(ctx.workspaceRoot, args.filePath as string);
  if (!resolved) return pathOutsideWorkspaceResult(args.filePath);
  const { filePath, relativePath } = resolved;
  let existed = true;
  let oldContent = '';
  try {
    oldContent = await readTextFile(filePath, 'utf-8');
  } catch (error) {
    if (isMissingFile(error)) {
      existed = false;
    } else {
      return {
        toolCallId: '',
        success: false,
        output: '',
        error: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const newContent = args.content as string;
  const { diff, stats } = await renderDiffWithStatsAsync(oldContent, newContent, 3, ctx.signal);
  throwIfAborted(ctx.signal);
  try {
    await writeTextFile(filePath, newContent, 'utf-8');
  } catch (error) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: `Failed to write file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    toolCallId: '',
    success: true,
    output: diff || 'File written successfully',
    fileMutation: {
      kind: existed ? 'update' : 'create',
      filePath: relativePath,
      addedLines: stats.addedLines,
      removedLines: stats.removedLines,
    },
    isCreate: !existed,
  };
}

async function editFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const resolved = resolveWorkspacePath(ctx.workspaceRoot, args.filePath as string);
  if (!resolved) return pathOutsideWorkspaceResult(args.filePath);
  const { filePath, relativePath } = resolved;

  let content: string;
  try {
    content = await readTextFile(filePath, 'utf-8');
  } catch (error) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: isMissingFile(error)
        ? `File not found: ${args.filePath}`
        : `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const oldStr = args.oldString as string;
  const newStr = args.newString as string;
  const replaceAll = (args.replaceAll as boolean) ?? false;

  if (!content.includes(oldStr)) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: 'oldString not found in file',
    };
  }

  const occurrences = await countOccurrences(content, oldStr, ctx.signal);
  if (occurrences > 1 && !replaceAll) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: `oldString matches ${occurrences} times; set replaceAll: true to replace all, or make oldString more specific`,
    };
  }

  const newContent = replaceAll
    ? content.split(oldStr).join(newStr)
    : content.replace(oldStr, newStr);
  const { diff, stats } = await renderDiffWithStatsAsync(content, newContent, 3, ctx.signal);
  throwIfAborted(ctx.signal);
  try {
    await writeTextFile(filePath, newContent, 'utf-8');
  } catch (error) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: `Failed to write file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    toolCallId: '',
    success: true,
    output: diff || 'File edited successfully (no textual change)',
    fileMutation: {
      kind: 'update',
      filePath: relativePath,
      addedLines: stats.addedLines,
      removedLines: stats.removedLines,
    },
  };
}

async function multiEdit(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const resolved = resolveWorkspacePath(ctx.workspaceRoot, args.filePath as string);
  if (!resolved) return pathOutsideWorkspaceResult(args.filePath);
  const { filePath, relativePath } = resolved;
  const edits =
    (args.edits as Array<{
      oldString: string;
      newString: string;
      replaceAll?: boolean;
    }>) ?? [];
  if (edits.length === 0) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: 'No edits provided',
    };
  }

  let content: string;
  try {
    content = await readTextFile(filePath, 'utf-8');
  } catch (error) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: isMissingFile(error)
        ? `File not found: ${args.filePath}`
        : `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const original = content;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (!content.includes(edit.oldString)) {
      return {
        toolCallId: '',
        success: false,
        output: '',
        error: `Edit ${i + 1}: oldString not found (no changes applied — MultiEdit is atomic)`,
      };
    }
    if (edit.replaceAll) {
      content = content.split(edit.oldString).join(edit.newString);
    } else {
      const occurrences = await countOccurrences(content, edit.oldString, ctx.signal);
      if (occurrences > 1) {
        return {
          toolCallId: '',
          success: false,
          output: '',
          error: `Edit ${i + 1}: oldString matches ${occurrences} times; set replaceAll: true or be more specific (no changes applied — MultiEdit is atomic)`,
        };
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
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: `Failed to write file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    toolCallId: '',
    success: true,
    output: diff || 'File edited successfully (no textual change)',
    fileMutation: {
      kind: 'update',
      filePath: relativePath,
      addedLines: stats.addedLines,
      removedLines: stats.removedLines,
    },
  };
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
    return { toolCallId: '', success: true, output: 'No files found' };
  }

  const suffix = truncated ? `\n... (truncated at ${GLOB_OUTPUT_LIMIT} files; refine pattern)` : '';
  return { toolCallId: '', success: true, output: output.join('\n') + suffix };
}

interface GrepMatch {
  line: number;
  text: string;
}

interface GrepFileMatches {
  matches: GrepMatch[];
  lines?: string[];
}

async function grepSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const includePattern = (args.include as string | undefined) ?? '**/*';
  const outputMode = (args.output_mode as 'content' | 'files_with_matches' | 'count') ?? 'content';
  const contextBefore = (args.B as number) ?? 0;
  const contextAfter = (args.A as number) ?? 0;
  const multiline = (args.multiline as boolean) ?? false;
  const headLimit = (args.head_limit as number) ?? 500;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, multiline ? 'gms' : 'g');
  } catch {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: `Invalid regex: ${pattern}`,
    };
  }

  const files = await fg(includePattern, {
    cwd: ctx.workspaceRoot,
    dot: true,
    ignore: ctx.gitignorePatterns ?? [],
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
        matches.push({ line, text: match[0].replace(/\n/g, '\\n') });
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
          matches.push({ line: lineIndex + 1, text: lines[lineIndex] });
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

  if (outputMode === 'count') {
    const lines = Array.from(matchesByFile.entries()).map(
      ([file, result]) => `${file}:${result.matches.length}`,
    );
    return {
      toolCallId: '',
      success: true,
      output: lines.join('\n') || 'No matches found',
    };
  }

  if (outputMode === 'files_with_matches') {
    const matchedFiles = Array.from(matchesByFile.keys());
    return {
      toolCallId: '',
      success: true,
      output: matchedFiles.join('\n') || 'No matches found',
    };
  }

  const output: string[] = [];
  for (const [file, result] of matchesByFile) {
    const lines = result.lines ?? [];
    for (const match of result.matches) {
      const start = Math.max(1, match.line - contextBefore);
      const end = Math.min(lines.length, match.line + contextAfter);
      for (let line = start; line <= end; line++) {
        const text = lines[line - 1] ?? '';
        const marker = line === match.line ? ':' : '-';
        output.push(`${file}:${line}${marker} ${text}`);
        if (output.length >= headLimit) break;
      }
      if (output.length >= headLimit) break;
    }
    if (output.length >= headLimit) break;
    await yieldToEventLoop(ctx.signal);
  }
  return {
    toolCallId: '',
    success: true,
    output: output.join('\n') || 'No matches found',
  };
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
          description: 'Max matches to return (default 500)',
          default: 500,
        },
      },
      required: ['pattern'],
    },
    execute: grepSearch,
  },
];
