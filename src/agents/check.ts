import { exec } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ToolContext, ToolDefinition, ToolResult } from '../types/tools.js';
import { toolFailure, toolSuccess } from '../tools/result.js';
import { resolveToolTimeoutMs } from '../tools/timeouts.js';

/**
 * One deadline, read by both `check` and the registry through the definition's
 * `timeoutMs`. If they disagree the registry's backstop fires first and answers
 * with a contentless `tool_timeout`, discarding the deliberate `check_timed_out`
 * result below -- which is the distinction a completion gate depends on.
 */
export function checkTimeoutMs(ctx: ToolContext): number {
  return resolveToolTimeoutMs({
    env: ctx.env,
    fallback: ctx.agentConfig?.settings.agents.checkTimeoutMs,
  });
}

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

/**
 * A timeout is not a failing check. `exec` kills the child with SIGTERM on
 * timeout, and reporting that through the same path as a non-zero exit tells the
 * agent its suite failed when the suite never finished — so it "fixes" a passing
 * test. Any completion gate built on Check inherits this predicate, so the two
 * outcomes have to stay distinguishable.
 */
function timedOut(command: string, timeoutMs: number, output: string): ToolResult {
  const seconds = (timeoutMs / 1000).toFixed(timeoutMs % 1000 === 0 ? 0 : 1);
  return toolFailure(
    `Check timed out after ${seconds}s and was killed; it did not fail. Command: ${command}`,
    {
      code: 'check_timed_out',
      retryable: true,
      remediation: `Raise agents.checkTimeoutMs (currently ${timeoutMs}) or narrow the check command. Do not treat this as a failing check.`,
      details: { command, timeoutMs },
      content: output,
    },
  );
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

  const timeoutMs = checkTimeoutMs(ctx);

  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd: ctx.workspaceRoot,
        env: { ...process.env, ...ctx.env },
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          // `exec` signals a timeout by killing the child; a genuine non-zero exit
          // carries a code and no signal.
          const killed = (error as { killed?: boolean }).killed === true;
          const signal = (error as { signal?: string | null }).signal;
          if (killed && signal) {
            resolve(timedOut(command, timeoutMs, stdout || stderr || ''));
            return;
          }
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
    timeoutMs: checkTimeoutMs,
    execute: check,
  },
];
