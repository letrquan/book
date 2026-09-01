import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { BackgroundShellNotify, CommandExecution } from '../types/runtime.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../types/tools.js';
import {
  createSandbox,
  matchesExcludedCommand,
  unsandboxedRefusalMessage,
  type SandboxSkipReason,
} from '../sandbox.js';
import { ShellJobManager, terminateForegroundProcess } from '../jobs/shell-manager.js';
import { resolveWorkspacePath } from './path-utils.js';
import { toolFailure, toolSuccess } from './result.js';
import { MAX_TOOL_TIMEOUT_MS, resolveToolTimeoutMs, toolTimeoutCeilingMs } from './timeouts.js';

/**
 * Five minutes, not the registry's two. A coding agent's most common long
 * command is its own gate, and this repository's `npm run check` runs past 200s
 * — under a 120s default Book could never verify its own work, and got back a
 * bare timeout with nothing to reason about.
 */
const DEFAULT_BASH_TIMEOUT_MS = 300_000;
const MAX_FOREGROUND_BUFFER = 1024 * 1024 * 10;
/** How long a killed command's pipes are given to deliver their final chunk. */
const STDIO_DRAIN_GRACE_MS = 500;
const SENSITIVE_ENV_NAME =
  /(^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASS(?:WORD)?|CREDENTIALS?|AUTH|COOKIE|SESSION|PRIVATE_?KEY|DATABASE_URL|CONNECTION_STRING)(_|$)/i;

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
  /** Present only for sandboxed commands, which never go through a shell. */
  exec?: CommandExecution;
  sandboxed: boolean;
  error?: string;
}

/**
 * Spawn options shared by the sandboxed (direct argv) and unsandboxed (platform
 * shell) paths. Keeping the branch in one helper stops a future call site from
 * spawning a sandbox wrapper with `shell: true`, which would reintroduce the
 * outer-shell parse the argv form exists to prevent.
 */
function spawnEffective(
  built: EffectiveCommand,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcess {
  const base: SpawnOptions = {
    ...options,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  return built.exec
    ? spawn(built.exec.file, built.exec.args, { ...base, shell: false })
    : spawn(built.effectiveCommand, { ...base, shell: true });
}

function buildEffectiveCommand(
  args: Record<string, unknown>,
  ctx: ToolContext,
): EffectiveCommand | undefined {
  const command = readString(args, 'command')?.trim();
  if (!command) return undefined;
  const workdir = readString(args, 'workdir') || ctx.workspaceRoot;
  const plain: EffectiveCommand = { command, workdir, effectiveCommand: command, sandboxed: false };
  const failed = (error: string): EffectiveCommand => ({ ...plain, error });

  // Every path that ends with the command running outside a bubblewrap
  // namespace funnels through here, so `allowUnsandboxedCommands: false` cannot
  // be enforced on some escapes and quietly missed on others.
  const unsandboxed = (reason: SandboxSkipReason): EffectiveCommand =>
    ctx.sandbox && !ctx.sandbox.allowUnsandboxedCommands
      ? failed(unsandboxedRefusalMessage(reason))
      : plain;

  if (!ctx.sandbox?.enabled) return unsandboxed('disabled');
  if (matchesExcludedCommand(command, ctx.sandbox.excludedCommands)) return unsandboxed('excluded');

  // The sandbox binds the workspace, not this workdir. A workdir outside it
  // would leave the command with no working directory inside the namespace,
  // and silently running it against the workspace root instead would execute
  // somewhere the caller did not ask for.
  if (!resolveWorkspacePath(ctx.workspaceRoot, workdir)) {
    return failed(
      `workdir is outside the sandboxed workspace: ${workdir}. Add it to sandbox.filesystem.allowWrite, or run without the sandbox.`,
    );
  }
  // createSandbox emits one-time diagnostics, so reuse the session's instance
  // rather than rebuilding it per command.
  const sandbox = ctx.runtime ? ctx.runtime.sandbox(ctx.sandbox) : createSandbox(ctx.sandbox);
  const exec = sandbox?.wrap(command, ctx.workspaceRoot);
  if (exec) return { command, workdir, effectiveCommand: command, exec, sandboxed: true };
  if (ctx.sandbox.failIfUnavailable) {
    return failed('Sandbox unavailable and failIfUnavailable is set');
  }
  return unsandboxed('unavailable');
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
  const timeout = resolveToolTimeoutMs({
    requested: args.timeout,
    env: ctx.env,
    fallback: DEFAULT_BASH_TIMEOUT_MS,
  });

  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawnEffective(built, {
        cwd: built.workdir,
        env: { ...process.env, ...ctx.env },
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
    let closed = false;
    let termination: Promise<void> | undefined;
    /** Resolve once the child's stdio is closed, or after a bounded wait. */
    const drainStdio = () =>
      new Promise<void>((resolveDrain) => {
        if (closed) {
          resolveDrain();
          return;
        }
        const done = () => {
          clearTimeout(drainTimer);
          proc.off('close', done);
          resolveDrain();
        };
        const drainTimer = setTimeout(done, STDIO_DRAIN_GRACE_MS);
        proc.on('close', done);
      });
    // A killed command is judged on whatever it managed to say. Both streams
    // count: a build that dies mid-run usually leaves its only clue on stderr.
    // They are labelled rather than concatenated, because the two are written
    // on independent schedules and gluing them together presents the model with
    // a timeline that never happened.
    const capturedOutput = () => {
      if (!stdout && !stderr) return '(no output was captured before the command was killed)';
      if (!stderr) return stdout;
      if (!stdout) return stderr;
      return `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // Wait for the pipes as well as the process. On POSIX the tree teardown
      // only confirms the process group is gone, so without this the last chunk
      // a batching runner flushed on the way out can still be in flight — and
      // that tail is the only progress the model ever sees.
      termination ??= terminateForegroundProcess(proc).then(() => drainStdio());
      // Built after termination settles rather than at kill time, so the result
      // carries that flush.
      void finish(() => {
        const ceiling = toolTimeoutCeilingMs(ctx.env);
        return toolFailure(
          `Command was killed after ${timeout}ms; it was still running, it did not fail.`,
          {
            status: 'timed_out',
            code: 'tool_timeout',
            remediation:
              timeout < ceiling
                ? `Re-run with a larger timeout (up to ${ceiling}ms), or with run_in_background: true and poll BashOutput.`
                : `${timeout}ms is the maximum here, so re-run with run_in_background: true and poll BashOutput instead.`,
            content: capturedOutput(),
          },
        );
      });
    }, timeout);

    const cleanup = () => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      ctx.runtime?.releaseChildProcess(proc);
    };
    const finish = async (result: ToolResult | (() => ToolResult)) => {
      if (settled) return;
      settled = true;
      try {
        await termination;
      } catch {
        // Cancellation remains the authoritative result if teardown races with exit.
      }
      cleanup();
      resolve(typeof result === 'function' ? result() : result);
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
      void finish(
        fail(`Command output exceeded ${MAX_FOREGROUND_BUFFER} characters`, capturedOutput()),
      );
    };

    proc.stdout?.on('data', (data) => append('stdout', data));
    proc.stderr?.on('data', (data) => append('stderr', data));
    proc.on('close', (code) => {
      closed = true;
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
  // `timeout` is deliberately not read here. It used to double as a legacy
  // alias for max_runtime_ms, which was harmless only while the argument was
  // hidden from the model. Now that Bash publishes it as the foreground
  // deadline, honouring it here would silently put a kill timer on a job the
  // model backgrounded precisely so it could outlive one.
  const requestedRuntime = readNumber(args, 'max_runtime_ms');
  try {
    const shell = await manager(ctx).start({
      command: built.command,
      effectiveCommand: built.effectiveCommand,
      exec: built.exec,
      workdir: built.workdir,
      env: { ...process.env, ...ctx.env },
      sandboxed: built.sandboxed,
      title: readString(args, 'title'),
      notify: readNotify(args),
      lifetime: readString(args, 'lifetime') === 'persistent' ? 'persistent' : 'session',
      timeoutMs: requestedRuntime,
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
    timeoutMs: DEFAULT_BASH_TIMEOUT_MS,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        workdir: { type: 'string', description: 'Working directory for the command' },
        timeout: {
          type: 'number',
          minimum: 1,
          maximum: MAX_TOOL_TIMEOUT_MS,
          description: `How long a foreground command may run, in milliseconds (default ${DEFAULT_BASH_TIMEOUT_MS}, maximum ${MAX_TOOL_TIMEOUT_MS}). Raise it for a known-slow command such as a full build or test suite. Background commands use max_runtime_ms instead.`,
        },
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
