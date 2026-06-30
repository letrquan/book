import { exec } from 'child_process';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { createSandbox } from '../sandbox.js';
import { globToRegex } from './glob-regex.js';

/**
 * Check whether a command matches any of the `excludedCommands` glob patterns.
 * Excluded commands run outside the sandbox (e.g. `docker *` needs host access).
 */
function matchesExcluded(command: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (globToRegex(p).test(command)) return true;
  }
  return false;
}

async function bash(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const command = args.command as string;
  const workdir = (args.workdir as string) || ctx.workspaceRoot;
  const timeout = (args.timeout as number) || 120_000;
  const dangerouslyDisableSandbox = (args.dangerouslyDisableSandbox as boolean) ?? false;

  // Build the effective command, wrapping it through the sandbox if enabled.
  let effectiveCommand = command;
  let sandboxed = false;
  if (ctx.sandbox?.enabled && !dangerouslyDisableSandbox) {
    if (!matchesExcluded(command, ctx.sandbox.excludedCommands ?? [])) {
      const sandbox = createSandbox(ctx.sandbox);
      if (sandbox) {
        const wrapped = sandbox.wrap(command, workdir);
        if (wrapped) {
          effectiveCommand = wrapped;
          sandboxed = true;
        } else if (ctx.sandbox.failIfUnavailable) {
          return {
            toolCallId: '',
            success: false,
            output: '',
            error: 'Sandbox unavailable and failIfUnavailable is set',
          };
        }
      } else if (ctx.sandbox.failIfUnavailable) {
        return {
          toolCallId: '',
          success: false,
          output: '',
          error: 'Sandbox unavailable and failIfUnavailable is set',
        };
      }
    }
  }

  return new Promise((resolve) => {
    const proc = exec(effectiveCommand, {
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
          output: (sandboxed ? '[sandboxed] ' : '') + (stdout || '(no output)'),
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
        dangerouslyDisableSandbox: {
          type: 'boolean',
          description: 'Run outside the sandbox (requires allowUnsandboxedCommands). Use only when the sandbox breaks the command.',
          default: false,
        },
      },
      required: ['command'],
    },
    execute: bash,
  },
];
