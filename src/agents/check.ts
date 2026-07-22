import { exec } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ToolContext, ToolDefinition, ToolResult } from '../types/tools.js';
import { toolFailure, toolSuccess } from '../tools/result.js';

function configuredChecks(ctx: ToolContext): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(ctx.agentConfig?.settings.agents.checks ?? {})) {
    result[name] = Array.isArray(value) ? value.join(' && ') : value;
  }

  const packagePath = join(ctx.workspaceRoot, 'package.json');
  if (!existsSync(packagePath)) return result;
  try {
    const scripts = (
      JSON.parse(readFileSync(packagePath, 'utf8')) as { scripts?: Record<string, string> }
    ).scripts;
    for (const name of ['test', 'typecheck', 'lint', 'build', 'format:check']) {
      if (scripts?.[name] && !result[name]) result[name] = `npm run ${name}`;
    }
  } catch {
    // Malformed package metadata simply disables script auto-detection.
  }
  return result;
}

function fail(error: string): ToolResult {
  return toolFailure(error);
}

async function check(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) return fail('name must be a configured or detected check');
  const checks = configuredChecks(ctx);
  const command = checks[name];
  if (!command) {
    const available = Object.keys(checks).sort();
    return fail(`Unknown check "${name}". Available checks: ${available.join(', ') || '(none)'}`);
  }

  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd: ctx.workspaceRoot,
        env: { ...process.env, ...ctx.env },
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve(fail(stderr || stdout || error.message));
          return;
        }
        resolve(toolSuccess(stdout || stderr || '(no output)'));
      },
    );
  });
}

export const checkTools: ToolDefinition[] = [
  {
    name: 'Check',
    description:
      'Run a named project check configured under agents.checks or detected from standard package scripts.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Configured check name, such as test or typecheck' },
      },
      required: ['name'],
    },
    execute: check,
  },
];
