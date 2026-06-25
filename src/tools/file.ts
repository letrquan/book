import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import fg from 'fast-glob';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

async function readFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const filePath = join(ctx.workspaceRoot, args.filePath as string);
  if (!existsSync(filePath)) {
    return { toolCallId: '', success: false, output: '', error: `File not found: ${args.filePath}` };
  }
  const offset = (args.offset as number) || 1;
  const limit = (args.limit as number) || 2000;
  const lines = readFileSync(filePath, 'utf-8').split('\n');
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const result = slice.map((l, i) => `${offset + i}: ${l}`).join('\n');
  return { toolCallId: '', success: true, output: result };
}

async function writeFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const filePath = join(ctx.workspaceRoot, args.filePath as string);
  writeFileSync(filePath, args.content as string, 'utf-8');
  return { toolCallId: '', success: true, output: 'File written successfully' };
}

async function editFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const filePath = join(ctx.workspaceRoot, args.filePath as string);
  if (!existsSync(filePath)) {
    return { toolCallId: '', success: false, output: '', error: `File not found: ${args.filePath}` };
  }
  const content = readFileSync(filePath, 'utf-8');
  const oldStr = args.oldString as string;
  const newStr = args.newString as string;
  if (!content.includes(oldStr)) {
    return { toolCallId: '', success: false, output: '', error: 'oldString not found in file' };
  }
  const newContent = content.replace(oldStr, newStr);
  writeFileSync(filePath, newContent, 'utf-8');
  return { toolCallId: '', success: true, output: 'File edited successfully' };
}

async function globSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const files = await fg(pattern, { cwd: ctx.workspaceRoot, dot: true });
  return { toolCallId: '', success: true, output: files.join('\n') };
}

async function grepSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const includePattern = args.include as string | undefined;
  const globPattern = includePattern || '**/*';
  const files = await fg(globPattern, { cwd: ctx.workspaceRoot, dot: true });
  const results: string[] = [];
  for (const file of files.slice(0, 100)) {
    try {
      const content = readFileSync(join(ctx.workspaceRoot, file), 'utf-8');
      const regex = new RegExp(pattern, 'g');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push(`${file}:${i + 1}: ${lines[i].trim()}`);
        }
        regex.lastIndex = 0;
      }
    } catch {}
  }
  const output = results.slice(0, 500).join('\n') || 'No matches found';
  return { toolCallId: '', success: true, output };
}

export const fileTools: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a file from the workspace. Returns lines with line numbers.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to the file relative to workspace root' },
        offset: { type: 'number', description: 'Line number to start reading from (1-indexed)', default: 1 },
        limit: { type: 'number', description: 'Maximum number of lines to read', default: 2000 },
      },
      required: ['filePath'],
    },
    execute: readFile,
  },
  {
    name: 'write_file',
    description: 'Write content to a file, overwriting if it exists',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to the file relative to workspace root' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['filePath', 'content'],
    },
    execute: writeFile,
  },
  {
    name: 'edit_file',
    description: 'Replace exact text in an existing file',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to the file relative to workspace root' },
        oldString: { type: 'string', description: 'Exact text to replace' },
        newString: { type: 'string', description: 'Text to replace it with' },
      },
      required: ['filePath', 'oldString', 'newString'],
    },
    execute: editFile,
  },
  {
    name: 'glob',
    description: 'Find files matching a glob pattern',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. src/**/*.ts)' },
      },
      required: ['pattern'],
    },
    execute: globSearch,
  },
  {
    name: 'grep',
    description: 'Search file contents for a regex pattern',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        include: { type: 'string', description: 'File glob pattern to filter (e.g. *.ts)' },
      },
      required: ['pattern'],
    },
    execute: grepSearch,
  },
];
