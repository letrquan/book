import { execFile } from 'child_process';
import type { ToolDefinition, ToolContext, ToolResult } from '../types/tools.js';
import { toolFailure, toolSuccess } from './result.js';

type ExecFile = typeof execFile;

export async function runGit(
  args: string[],
  ctx: ToolContext,
  execute: ExecFile = execFile,
): Promise<{ success: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    const options = {
      cwd: ctx.workspaceRoot,
      encoding: 'utf-8' as const,
      timeout: 30_000,
      signal: ctx.signal,
      env: { ...process.env, ...ctx.env },
    };

    execute('git', args, options, (error, stdout, stderr) => {
      if (!error) {
        resolve({ success: true, output: stdout || '(no output)' });
        return;
      }

      if (ctx.signal?.aborted) {
        resolve({ success: false, output: '', error: 'CANCELLED: Git command was cancelled' });
        return;
      }

      resolve({
        success: false,
        output: '',
        error: stderr || error.message || 'Git command failed',
      });
    });
  });
}

function gitResult(result: Awaited<ReturnType<typeof runGit>>): ToolResult {
  return result.success
    ? toolSuccess(result.output)
    : toolFailure(result.error ?? 'Git command failed', { content: result.output });
}

async function gitStatus(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const result = await runGit(['status', '--short'], ctx);
  return gitResult(result);
}

async function gitDiff(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const result = await runGit(['diff'], ctx);
  return gitResult(result);
}

async function gitLog(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const result = await runGit(['log', '--oneline', '-20'], ctx);
  return gitResult(result);
}

async function gitCommit(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const message = args.message as string;
  const result = await runGit(['commit', '-m', message], ctx);
  return gitResult(result);
}

async function gitBranch(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const result = await runGit(['branch', '-a'], ctx);
  return gitResult(result);
}

export const gitTools: ToolDefinition[] = [
  {
    name: 'GitStatus',
    idempotent: true,
    policy: { concurrency: 'parallel' },
    description: 'Show the working tree status (git status --short)',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: gitStatus,
  },
  {
    name: 'GitDiff',
    idempotent: true,
    policy: { concurrency: 'parallel' },
    description: 'Show changes between commits, commit and working tree, etc.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: gitDiff,
  },
  {
    name: 'GitLog',
    idempotent: true,
    policy: { concurrency: 'parallel' },
    description: 'Show recent commit logs (last 20, oneline)',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: gitLog,
  },
  {
    name: 'GitCommit',
    description: 'Create a new commit with a message',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Commit message' } },
      required: ['message'],
    },
    execute: gitCommit,
  },
  {
    name: 'GitBranch',
    idempotent: true,
    policy: { concurrency: 'parallel' },
    description: 'List branches',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: gitBranch,
  },
];
