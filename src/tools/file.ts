import { readFileSync, writeFileSync, existsSync } from 'fs';
import fg from 'fast-glob';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { renderDiffWithStats } from './diff.js';
import { pathOutsideWorkspaceResult, resolveWorkspacePath } from './path-utils.js';

const GLOB_OUTPUT_LIMIT = 1000;

async function readFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const resolved = resolveWorkspacePath(ctx.workspaceRoot, args.filePath as string);
  if (!resolved) return pathOutsideWorkspaceResult(args.filePath);
  const { filePath } = resolved;
  if (!existsSync(filePath)) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: `File not found: ${args.filePath}`,
    };
  }
  const offset = (args.offset as number) || 1;
  const limit = (args.limit as number) || 2000;
  const lines = readFileSync(filePath, 'utf-8').split('\n');
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const result = slice.map((l, i) => `${offset + i}: ${l}`).join('\n');
  return { toolCallId: '', success: true, output: result };
}

async function writeFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const resolved = resolveWorkspacePath(ctx.workspaceRoot, args.filePath as string);
  if (!resolved) return pathOutsideWorkspaceResult(args.filePath);
  const { filePath, relativePath } = resolved;
  const existed = existsSync(filePath);
  const oldContent = existed ? readFileSync(filePath, 'utf-8') : '';
  const newContent = args.content as string;
  writeFileSync(filePath, newContent, 'utf-8');
  const { diff, stats } = renderDiffWithStats(oldContent, newContent);
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
  if (!existsSync(filePath)) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: `File not found: ${args.filePath}`,
    };
  }
  const content = readFileSync(filePath, 'utf-8');
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

  // Count non-overlapping occurrences.
  const countOccurrences = (src: string, needle: string): number => {
    if (needle.length === 0) return 0;
    let count = 0;
    let idx = src.indexOf(needle);
    while (idx !== -1) {
      count++;
      idx = src.indexOf(needle, idx + needle.length);
    }
    return count;
  };
  const occurrences = countOccurrences(content, oldStr);

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
  writeFileSync(filePath, newContent, 'utf-8');
  const { diff, stats } = renderDiffWithStats(content, newContent);
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
  if (!existsSync(filePath)) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: `File not found: ${args.filePath}`,
    };
  }
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

  let content = readFileSync(filePath, 'utf-8');
  const original = content;

  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (!content.includes(e.oldString)) {
      return {
        toolCallId: '',
        success: false,
        output: '',
        error: `Edit ${i + 1}: oldString not found (no changes applied — MultiEdit is atomic)`,
      };
    }
    if (e.replaceAll) {
      content = content.split(e.oldString).join(e.newString);
    } else {
      // Reject ambiguous single edits within MultiEdit too.
      const occ = e.oldString.length === 0 ? 0 : content.split(e.oldString).length - 1;
      if (occ > 1) {
        return {
          toolCallId: '',
          success: false,
          output: '',
          error: `Edit ${i + 1}: oldString matches ${occ} times; set replaceAll: true or be more specific (no changes applied — MultiEdit is atomic)`,
        };
      }
      content = content.replace(e.oldString, e.newString);
    }
  }

  writeFileSync(filePath, content, 'utf-8');
  const { diff, stats } = renderDiffWithStats(original, content);
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

  const seen = new Set<string>();
  const output: string[] = [];
  let truncated = false;

  for (const file of files) {
    const resolved = resolveWorkspacePath(ctx.workspaceRoot, file);
    if (!resolved || seen.has(resolved.relativePath)) continue;

    seen.add(resolved.relativePath);
    if (output.length >= GLOB_OUTPUT_LIMIT) {
      truncated = true;
      break;
    }
    output.push(resolved.relativePath);
  }

  if (output.length === 0) {
    return { toolCallId: '', success: true, output: 'No files found' };
  }

  const suffix = truncated ? `\n... (truncated at ${GLOB_OUTPUT_LIMIT} files; refine pattern)` : '';
  return { toolCallId: '', success: true, output: output.join('\n') + suffix };
}

async function grepSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const includePattern = (args.include as string | undefined) ?? '**/*';
  const outputMode = (args.output_mode as 'content' | 'files_with_matches' | 'count') ?? 'content';
  const contextBefore = (args.B as number) ?? 0;
  const contextAfter = (args.A as number) ?? 0;
  const multiline = (args.multiline as boolean) ?? false;
  const headLimit = (args.head_limit as number) ?? 500;

  const files = await fg(includePattern, {
    cwd: ctx.workspaceRoot,
    dot: true,
    ignore: ctx.gitignorePatterns ?? [],
  });
  const inWorkspaceFiles: Array<{ file: string; filePath: string }> = [];
  const seenFiles = new Set<string>();

  for (const file of files) {
    const resolved = resolveWorkspacePath(ctx.workspaceRoot, file);
    if (!resolved || seenFiles.has(resolved.relativePath)) continue;
    seenFiles.add(resolved.relativePath);
    inWorkspaceFiles.push({ file: resolved.relativePath, filePath: resolved.filePath });
  }

  const flags = multiline ? 'gm' : 'g';
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: `Invalid regex: ${pattern}`,
    };
  }

  const matchesByFile = new Map<string, Array<{ line: number; text: string }>>();
  let totalMatches = 0;

  for (const { file, filePath } of inWorkspaceFiles) {
    if (totalMatches >= headLimit) break;
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    const fileMatches: Array<{ line: number; text: string }> = [];

    if (multiline) {
      // Scan the whole text for span matches; record the start line of each.
      let m: RegExpExecArray | null;
      const re = new RegExp(pattern, 'gm');
      while ((m = re.exec(content)) !== null) {
        const startLine = content.slice(0, m.index).split('\n').length;
        fileMatches.push({ line: startLine, text: m[0].replace(/\n/g, '\\n') });
        totalMatches++;
        if (totalMatches >= headLimit) break;
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    } else {
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          fileMatches.push({ line: i + 1, text: lines[i] });
          totalMatches++;
          if (totalMatches >= headLimit) break;
        }
      }
    }
    if (fileMatches.length > 0) matchesByFile.set(file, fileMatches);
  }

  if (outputMode === 'count') {
    const lines = Array.from(matchesByFile.entries()).map(([f, ms]) => `${f}:${ms.length}`);
    return {
      toolCallId: '',
      success: true,
      output: lines.join('\n') || 'No matches found',
    };
  }

  if (outputMode === 'files_with_matches') {
    const files2 = Array.from(matchesByFile.keys());
    return {
      toolCallId: '',
      success: true,
      output: files2.join('\n') || 'No matches found',
    };
  }

  // content mode
  const out: string[] = [];
  for (const [file, ms] of matchesByFile) {
    for (const match of ms) {
      // Read context lines lazily; cheap for small context values.
      const lines = (() => {
        const resolved = resolveWorkspacePath(ctx.workspaceRoot, file);
        if (!resolved) return [];
        try {
          return readFileSync(resolved.filePath, 'utf-8').split('\n');
        } catch {
          return [];
        }
      })();
      const start = Math.max(1, match.line - contextBefore);
      const end = Math.min(lines.length, match.line + contextAfter);
      for (let ln = start; ln <= end; ln++) {
        const text = lines[ln - 1] ?? '';
        const marker = ln === match.line ? ':' : '-';
        out.push(`${file}:${ln}${marker} ${text}`);
      }
    }
  }
  return {
    toolCallId: '',
    success: true,
    output: out.slice(0, headLimit).join('\n') || 'No matches found',
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
