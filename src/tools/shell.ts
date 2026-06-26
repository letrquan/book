import { exec } from 'child_process';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

async function bash(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const command = args.command as string;
  const workdir = (args.workdir as string) || ctx.workspaceRoot;
  const timeout = (args.timeout as number) || 120_000;

  return new Promise((resolve) => {
    const proc = exec(command, {
      cwd: workdir,
      timeout,
      maxBuffer: 1024 * 1024 * 10,
      env: { ...process.env, ...ctx.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => { stdout += data; });
    proc.stderr?.on('data', (data) => { stderr += data; });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({
          toolCallId: '',
          success: true,
          output: stdout || '(no output)',
        });
      } else {
        resolve({
          toolCallId: '',
          success: false,
          output: stdout,
          error: stderr || `Exit code: ${code}`,
        });
      }
    });

    proc.on('error', (err) => {
      resolve({
        toolCallId: '',
        success: false,
        output: '',
        error: err.message,
      });
    });
  });
}

export const shellTools: ToolDefinition[] = [
  {
    name: 'Bash',
    description: 'Execute a shell command in the workspace',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        workdir: { type: 'string', description: 'Working directory for the command' },
        timeout: { type: 'number', description: 'Timeout in milliseconds', default: 120000 },
      },
      required: ['command'],
    },
    execute: bash,
  },
];
