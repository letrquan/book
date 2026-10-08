import { exec, execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ToolContext, ToolDefinition, ToolResult } from '../types/tools.js';
import { buildChildEnv } from '../child-env.js';
import { decideSandboxExecution, withGitConfigReadOnlyNotice } from '../sandbox.js';
import { toolFailure, toolSuccess } from '../tools/result.js';
import { resolveToolTimeoutMs } from '../tools/timeouts.js';

/** Used only when `agents.checkTimeoutMs` is absent, which the schema defaults. */
const DEFAULT_CHECK_TIMEOUT_MS = 120_000;

/**
 * One deadline, read by both `check` and the registry through the definition's
 * `timeoutMs`. If they disagree the registry's backstop fires first and answers
 * with a contentless `tool_timeout`, discarding the deliberate `check_timed_out`
 * result below -- which is the distinction a completion gate depends on.
 */
export function checkTimeoutMs(ctx: ToolContext): number {
  return resolveToolTimeoutMs({
    // `agents.checkTimeoutMs` is a deliberate statement about this suite, so it
    // outranks the blanket BOOK_TOOL_TIMEOUT_MS: someone who set it to 40
    // minutes for a slow suite should not have it cut to 2 by an unrelated
    // environment variable exported for other tool tuning.
    configured: ctx.agentConfig?.settings.agents.checkTimeoutMs,
    env: ctx.env,
    fallback: DEFAULT_CHECK_TIMEOUT_MS,
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

  // A check is a project-supplied command run in the project workspace, so it
  // takes the same sandbox decision `Bash` does — decided before anything is
  // spawned, so a refusal means the command never ran at all (#373).
  const decision = decideSandboxExecution(ctx, command, ctx.workspaceRoot);
  if (decision.error) return fail(decision.error);

  const options = {
    cwd: ctx.workspaceRoot,
    env: buildChildEnv(process.env, ctx.env),
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  };

  return new Promise((resolve) => {
    const settle = (
      error: (Error & { killed?: boolean; signal?: string | null }) | null,
      stdout: string,
      stderr: string,
    ): void => {
      if (error) {
        // `exec` signals a timeout by killing the child; a genuine non-zero exit
        // carries a code and no signal.
        if (error.killed === true && error.signal) {
          resolve(timedOut(command, timeoutMs, stdout || stderr || ''));
          return;
        }
        // A project check is run inside the same namespace a `Bash` command is,
        // so a `git` command among them hits the same read-only git dir
        // (issue 373) and says so in words that name no cause. Appended here,
        // once.
        resolve(
          fail(
            withGitConfigReadOnlyNotice(
              stderr || stdout || error.message,
              stderr || stdout,
              decision.sandboxed,
              command,
              decision.gitDirReadOnly,
            ),
          ),
        );
        return;
      }
      // Marked the way a sandboxed `Bash` command is marked, so a transcript
      // says which of the two things ran.
      resolve(
        toolSuccess(
          (decision.sandboxed ? '[sandboxed] ' : '') + (stdout || stderr || '(no output)'),
        ),
      );
    };
    // The sandboxed path is argv, never a command string: joining it and
    // spawning with `shell: true` would let the outer shell parse it, which is
    // the escape the wrapper form exists to prevent.
    const wrapped = decision.exec;
    if (decision.sandboxed && wrapped) {
      execFile(wrapped.file, wrapped.args, options, settle);
      return;
    }
    exec(command, options, settle);
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
