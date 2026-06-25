import { execSync } from 'child_process';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

function runGit(args: string[], ctx: ToolContext): { success: boolean; output: string; error?: string } {
  try {
    const output = execSync(`git ${args.join(' ')}`, {
      cwd: ctx.workspaceRoot,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    return { success: true, output: output || '(no output)' };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { success: false, output: '', error: err.stderr || err.message || 'Git command failed' };
  }
}

async function gitStatus(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const r = runGit(['status', '--short'], ctx);
  return { toolCallId: '', ...r };
}

async function gitDiff(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const r = runGit(['diff'], ctx);
  return { toolCallId: '', ...r };
}

async function gitLog(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const r = runGit(['log', '--oneline', '-20'], ctx);
  return { toolCallId: '', ...r };
}

async function gitCommit(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const message = args.message as string;
  const r = runGit(['commit', '-m', message], ctx);
  return { toolCallId: '', ...r };
}

async function gitBranch(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const r = runGit(['branch', '-a'], ctx);
  return { toolCallId: '', ...r };
}

export const gitTools: ToolDefinition[] = [
  {
    name: 'git_status',
    description: 'Show the working tree status (git status --short)',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: gitStatus,
  },
  {
    name: 'git_diff',
    description: 'Show changes between commits, commit and working tree, etc.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: gitDiff,
  },
  {
    name: 'git_log',
    description: 'Show recent commit logs (last 20, oneline)',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: gitLog,
  },
  {
    name: 'git_commit',
    description: 'Create a new commit with a message',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Commit message' } },
      required: ['message'],
    },
    execute: gitCommit,
  },
  {
    name: 'git_branch',
    description: 'List branches',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: gitBranch,
  },
];
