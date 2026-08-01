import { spawn, type ChildProcess } from 'node:child_process';
import type { BackgroundShellNotify } from '../types/runtime.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../types/tools.js';
import { createSandbox } from '../sandbox.js';
import { ShellJobManager, terminateForegroundProcess } from '../jobs/shell-manager.js';
import { globToRegex } from './glob-regex.js';
import { toolFailure, toolSuccess } from './result.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_FOREGROUND_BUFFER = 1024 * 1024 * 10;
const SENSITIVE_ENV_NAME =
  /(^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASS(?:WORD)?|CREDENTIALS?|AUTH|COOKIE|SESSION|PRIVATE_?KEY|DATABASE_URL|CONNECTION_STRING)(_|$)/i;

function matchesExcluded(command: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegex(pattern).test(command));
}

function ok(output: string, data?: unknown): ToolResult {
  return toolSuccess(output, { data });
}

function fail(error: string, output = ''): ToolResult {
  return toolFailure(error, { content: output });
}

function readString(
  args: Record<string, unknown>,
  snake: string,
  camel?: string,
): string | undefined {
  const snakeValue = args[snake];
  if (typeof snakeValue === 'string') return snakeValue;
  const camelValue = camel ? args[camel] : undefined;
  return typeof camelValue === 'string' ? camelValue : undefined;
}

function readNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(args: Record<string, unknown>, snake: string, camel?: string): boolean {
  const snakeValue = args[snake];
  if (typeof snakeValue === 'boolean') return snakeValue;
  const camelValue = camel ? args[camel] : undefined;
  return typeof camelValue === 'boolean' ? camelValue : false;
}

function readNotify(args: Record<string, unknown>): BackgroundShellNotify | undefined {
  const notify = readString(args, 'notify');
  return notify === 'none' || notify === 'ui' || notify === 'agent' ? notify : undefined;
}

export function persistentEnvironmentOverrides(ctx: ToolContext): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ctx.envOverrides ?? {}).filter(([name]) => !SENSITIVE_ENV_NAME.test(name)),
  );
}

function manager(ctx: ToolContext): ShellJobManager {
  if (ctx.runtime) return ctx.runtime.shellManager;
  ctx.shellManager ??= new ShellJobManager(
    (ctx.backgroundShells ??= { nextId: 1, shells: new Map() }),
  );
  return ctx.shellManager;
}

interface EffectiveCommand {
  command: string;
  workdir: string;
  effectiveCommand: string;
  sandboxed: boolean;
  error?: string;
}

function buildEffectiveCommand(
  args: Record<string, unknown>,
  ctx: ToolContext,
): EffectiveCommand | undefined {
  const command = readString(args, 'command')?.trim();
  if (!command) return undefined;
  const workdir = readString(args, 'workdir') || ctx.workspaceRoot;
  let effectiveCommand = command;
  let sandboxed = false;
  if (ctx.sandbox?.enabled && !matchesExcluded(command, ctx.sandbox.excludedCommands ?? [])) {
    const sandbox = createSandbox(ctx.sandbox);
    if (sandbox) {
      const wrapped = sandbox.wrap(command, workdir);
      if (wrapped) {
        effectiveCommand = wrapped;
        sandboxed = true;
      } else if (ctx.sandbox.failIfUnavailable) {
        return {
          command,
          workdir,
          effectiveCommand,
          sandboxed,
          error: 'Sandbox unavailable and failIfUnavailable is set',
        };
      }
    } else if (ctx.sandbox.failIfUnavailable) {
      return {
        command,
        workdir,
        effectiveCommand,
        sandboxed,
        error: 'Sandbox unavailable and failIfUnavailable is set',
      };
    }
  }
  return { command, workdir, effectiveCommand, sandboxed };
}

async function bash(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  return readBoolean(args, 'run_in_background', 'runInBackground')
    ? bashBackground(args, ctx)
    : bashForeground(args, ctx);
}

async function bashForeground(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const built = buildEffectiveCommand(args, ctx);
  if (!built) return fail('command must be a non-empty string');
  if (built.error) return fail(built.error);
  const timeout = readNumber(args, 'timeout') ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(built.effectiveCommand, {
        cwd: built.workdir,
        env: { ...process.env, ...ctx.env },
        shell: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      ctx.runtime?.trackChildProcess(proc);
    } catch (error) {
      resolve(fail(error instanceof Error ? error.message : String(error)));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let cancelled = false;
    let timedOut = false;
    let bufferExceeded = false;
    let termination: Promise<void> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      termination ??= terminateForegroundProcess(proc);
      void finish(fail(`Command timed out after ${timeout}ms`, stdout));
    }, timeout);

    const cleanup = () => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      ctx.runtime?.releaseChildProcess(proc);
    };
    const finish = async (result: ToolResult) => {
      if (settled) return;
      settled = true;
      try {
        await termination;
      } catch {
        // Cancellation remains the authoritative result if teardown races with exit.
      }
      cleanup();
      resolve(result);
    };
    const onAbort = () => {
      if (cancelled) return;
      cancelled = true;
      termination = terminateForegroundProcess(proc);
      void finish(fail('Command cancelled'));
    };
    const append = (target: 'stdout' | 'stderr', data: unknown) => {
      const chunk = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      if (target === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length <= MAX_FOREGROUND_BUFFER || bufferExceeded) return;
      bufferExceeded = true;
      termination ??= terminateForegroundProcess(proc);
      void finish(fail(`Command output exceeded ${MAX_FOREGROUND_BUFFER} characters`, stdout));
    };

    proc.stdout?.on('data', (data) => append('stdout', data));
    proc.stderr?.on('data', (data) => append('stderr', data));
    proc.on('close', (code) => {
      if (cancelled || timedOut || bufferExceeded) return;
      void finish(
        code === 0
          ? ok((built.sandboxed ? '[sandboxed] ' : '') + (stdout || '(no output)'))
          : fail(stderr || `Exit code: ${code}`, stdout),
      );
    });
    proc.on('error', (error) => {
      if (!cancelled && !timedOut && !bufferExceeded) void finish(fail(error.message));
    });
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal?.aborted) onAbort();
  });
}

async function bashBackground(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const built = buildEffectiveCommand(args, ctx);
  if (!built) return fail('command must be a non-empty string');
  if (built.error) return fail(built.error);
  const requestedRuntime = readNumber(args, 'max_runtime_ms');
  const legacyTimeout = Object.prototype.hasOwnProperty.call(args, 'timeout')
    ? readNumber(args, 'timeout')
    : undefined;
  try {
    const shell = await manager(ctx).start({
      command: built.command,
      effectiveCommand: built.effectiveCommand,
      workdir: built.workdir,
      env: { ...process.env, ...ctx.env },
      sandboxed: built.sandboxed,
      title: readString(args, 'title'),
      notify: readNotify(args),
      lifetime: readString(args, 'lifetime') === 'persistent' ? 'persistent' : 'session',
      timeoutMs: requestedRuntime ?? legacyTimeout,
      workspace: ctx.workspaceRoot,
      envOverrides: persistentEnvironmentOverrides(ctx),
      parentSessionId: ctx.parentSessionId,
      rootRunId: ctx.runContext?.rootRunId,
      parentRunId: ctx.runContext?.runId,
    });
    return ok(
      [
        `Started background shell ${shell.id}${shell.pid ? ` (pid ${shell.pid})` : ''}.`,
        `Use BashOutput with shell_id="${shell.id}" to read output.`,
        `Use KillShell with shell_id="${shell.id}" to stop it.`,
        built.sandboxed ? '[sandboxed]' : undefined,
      ]
        .filter(Boolean)
        .join('\n'),
      shell,
    );
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

async function bashOutput(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const shellId = readString(args, 'shell_id', 'shellId')?.trim();
  if (!shellId) return fail('shell_id must be a non-empty string');
  const result = manager(ctx).readOutput(shellId);
  if (!result) return fail(`Shell ${shellId} not found`);
  const parts = [`Shell ${result.shell.id}: ${result.shell.status}`];
  if (result.shell.pid !== undefined) parts.push(`pid=${result.shell.pid}`);
  if (result.shell.exitCode !== undefined && result.shell.exitCode !== null) {
    parts.push(`exit=${result.shell.exitCode}`);
  }
  if (result.shell.signal) parts.push(`signal=${result.shell.signal}`);
  const lines = [parts.join(' ')];
  if (result.shell.truncatedBytes > 0) {
    lines.push(`[${result.shell.truncatedBytes} older characters truncated from buffer]`);
  }
  lines.push(
    result.remaining > 0
      ? `${result.output}\n[${result.remaining} more characters available; call BashOutput again]`
      : result.output,
  );
  return ok(lines.join('\n'), result);
}

async function killShell(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const shellId = readString(args, 'shell_id', 'shellId')?.trim();
  if (!shellId) return fail('shell_id must be a non-empty string');
  const shell = manager(ctx).get(shellId);
  if (!shell) return fail(`Shell ${shellId} not found`);
  if (['exited', 'failed', 'killed', 'timed_out', 'lost'].includes(shell.status)) {
    return ok(`Shell ${shell.id} is already ${shell.status}; no running process was stopped.`);
  }
  const stopped = await manager(ctx).stop(shellId);
  if (!stopped) return fail(`Sent termination to shell ${shellId}, but it is still stopping.`);
  return ok(`Killed shell ${shell.id}${shell.pid ? ` (pid ${shell.pid})` : ''}.`);
}

async function dismissShell(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const shellId = readString(args, 'shell_id', 'shellId')?.trim();
  if (!shellId) return fail('shell_id must be a non-empty string');
  try {
    manager(ctx).dismiss(shellId);
    return ok(`Dismissed shell ${shellId}.`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export const shellTools: ToolDefinition[] = [
  {
    name: 'Bash',
    argumentAliases: { runInBackground: 'run_in_background' },
    description: 'Execute a shell command in the workspace',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        workdir: { type: 'string', description: 'Working directory for the command' },
        run_in_background: {
          type: 'boolean',
          description: 'Start the command in the background and return a shell_id immediately',
          default: false,
        },
        notify: {
          type: 'string',
          enum: ['none', 'ui', 'agent'],
          description: 'Background completion policy. Defaults to ui.',
        },
        lifetime: {
          type: 'string',
          enum: ['session', 'persistent'],
          description:
            'Background lifetime. Persistent jobs survive Book exit and require explicit permission.',
        },
        max_runtime_ms: {
          type: 'number',
          minimum: 1,
          description: 'Optional maximum runtime for a background command.',
        },
        title: { type: 'string', description: 'Short label shown in the background job panel.' },
      },
      required: ['command'],
    },
    execute: bash,
  },
  {
    name: 'BashOutput',
    argumentAliases: { shellId: 'shell_id' },
    description:
      'Read new output and status from a background shell started by Bash(run_in_background)',
    parameters: {
      type: 'object',
      properties: {
        shell_id: { type: 'string', description: 'Background shell ID returned by Bash' },
      },
      required: ['shell_id'],
    },
    execute: bashOutput,
  },
  {
    name: 'KillShell',
    argumentAliases: { shellId: 'shell_id' },
    description: 'Terminate a background shell started by Bash(run_in_background)',
    parameters: {
      type: 'object',
      properties: {
        shell_id: { type: 'string', description: 'Background shell ID returned by Bash' },
      },
      required: ['shell_id'],
    },
    execute: killShell,
  },
  {
    name: 'DismissShell',
    description: 'Remove a completed background shell record and release its retained output',
    parameters: {
      type: 'object',
      properties: {
        shell_id: { type: 'string', description: 'Completed background shell ID to dismiss' },
      },
      required: ['shell_id'],
    },
    execute: dismissShell,
  },
];
