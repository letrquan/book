import { exec, spawn, type ChildProcess } from 'child_process';
import type {
  BackgroundShellRecord,
  BackgroundShellStatus,
  BackgroundShellStore,
} from '../types/runtime.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../types/tools.js';
import { createSandbox } from '../sandbox.js';
import { globToRegex } from './glob-regex.js';
import { toolFailure, toolSuccess } from './result.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_FOREGROUND_BUFFER = 1024 * 1024 * 10;
const MAX_BACKGROUND_BUFFER = 1024 * 1024 * 5;
const MAX_OUTPUT_RESULT = 32_000;
const TERMINATE_GRACE_MS = 1_500;
const MAX_RETAINED_TERMINAL_SHELLS = 20;
const TERMINAL_SHELL_TTL_MS = 15 * 60_000;

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

function ok(output: string): ToolResult {
  return toolSuccess(output);
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
  if (camel) {
    const camelValue = args[camel];
    if (typeof camelValue === 'string') return camelValue;
  }
  return undefined;
}

function readNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(args: Record<string, unknown>, snake: string, camel?: string): boolean {
  const snakeValue = args[snake];
  if (typeof snakeValue === 'boolean') return snakeValue;
  if (camel) {
    const camelValue = args[camel];
    if (typeof camelValue === 'boolean') return camelValue;
  }
  return false;
}

function shellStore(ctx: ToolContext) {
  ctx.backgroundShells ??= ctx.runtime?.backgroundShells ?? { nextId: 1, shells: new Map() };
  pruneTerminalShells(ctx.backgroundShells);
  return ctx.backgroundShells;
}

function deleteShellRecord(store: BackgroundShellStore, shellId: string): void {
  const shell = store.shells.get(shellId);
  if (shell?.retentionTimer) clearTimeout(shell.retentionTimer);
  store.shells.delete(shellId);
}

function pruneTerminalShells(store: BackgroundShellStore, now = Date.now()): void {
  const terminal = Array.from(store.shells.values())
    .filter((shell) => isTerminalStatus(shell.status))
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  for (const shell of terminal) {
    if (shell.finishedAt !== undefined && now - shell.finishedAt >= TERMINAL_SHELL_TTL_MS) {
      deleteShellRecord(store, shell.id);
    }
  }
  const retained = terminal.filter((shell) => store.shells.has(shell.id));
  for (const shell of retained.slice(0, -MAX_RETAINED_TERMINAL_SHELLS)) {
    deleteShellRecord(store, shell.id);
  }
}

function scheduleShellRetention(store: BackgroundShellStore, shell: BackgroundShellRecord): void {
  if (!isTerminalStatus(shell.status)) return;
  if (shell.retentionTimer) clearTimeout(shell.retentionTimer);
  pruneTerminalShells(store);
  if (!store.shells.has(shell.id)) return;
  shell.retentionTimer = setTimeout(
    () => deleteShellRecord(store, shell.id),
    TERMINAL_SHELL_TTL_MS,
  );
  shell.retentionTimer.unref();
}

function nextShellId(ctx: ToolContext): string {
  const store = shellStore(ctx);
  return `shell_${store.nextId++}`;
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
  if (ctx.sandbox?.enabled) {
    if (!matchesExcluded(command, ctx.sandbox.excludedCommands ?? [])) {
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
  }

  return { command, workdir, effectiveCommand, sandboxed };
}

function appendOutput(shell: BackgroundShellRecord, data: unknown): void {
  const chunk = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  if (!chunk) return;

  shell.output += chunk;
  if (shell.output.length <= MAX_BACKGROUND_BUFFER) return;

  const extra = shell.output.length - MAX_BACKGROUND_BUFFER;
  shell.output = shell.output.slice(extra);
  shell.truncatedBytes += extra;
  shell.readOffset = Math.max(0, shell.readOffset - extra);
}

function clearShellTimer(shell: BackgroundShellRecord): void {
  if (!shell.timer) return;
  clearTimeout(shell.timer);
  shell.timer = undefined;
}

function isTerminalStatus(status: BackgroundShellStatus): boolean {
  return (
    status === 'exited' || status === 'failed' || status === 'killed' || status === 'timed_out'
  );
}

function finishShell(
  shell: BackgroundShellRecord,
  status: BackgroundShellStatus,
  code?: number | null,
  signal?: NodeJS.Signals | string | null,
): void {
  if (isTerminalStatus(shell.status)) return;
  shell.status = status;
  shell.exitCode = code;
  shell.signal = signal;
  shell.finishedAt = Date.now();
  clearShellTimer(shell);
}

function statusLine(shell: BackgroundShellRecord): string {
  const parts = [`Shell ${shell.id}: ${shell.status}`];
  if (shell.pid !== undefined) parts.push(`pid=${shell.pid}`);
  if (shell.exitCode !== undefined && shell.exitCode !== null) parts.push(`exit=${shell.exitCode}`);
  if (shell.signal) parts.push(`signal=${shell.signal}`);
  return parts.join(' ');
}

function readShellOutput(shell: BackgroundShellRecord): string {
  const unread = shell.output.slice(shell.readOffset);
  if (!unread) return '(no new output)';

  const returned = unread.slice(0, MAX_OUTPUT_RESULT);
  shell.readOffset += returned.length;
  const remaining = unread.length - returned.length;
  if (remaining <= 0) return returned;
  return `${returned}\n[${remaining} more characters available; call BashOutput again]`;
}

function unrefStream(stream: NodeJS.ReadableStream | null | undefined): void {
  (stream as { unref?: () => void } | null | undefined)?.unref?.();
}

function waitForSpawn(proc: ChildProcess): Promise<Error | undefined> {
  return new Promise((resolve) => {
    const onSpawn = () => {
      cleanup();
      resolve(undefined);
    };
    const onError = (err: Error) => {
      cleanup();
      resolve(err);
    };
    const cleanup = () => {
      proc.off('spawn', onSpawn);
      proc.off('error', onError);
    };

    proc.once('spawn', onSpawn);
    proc.once('error', onError);
  });
}

function waitForClose(shell: BackgroundShellRecord, timeoutMs: number): Promise<boolean> {
  if (shell.finishedAt !== undefined) return Promise.resolve(true);

  const proc = shell.process;
  if (!proc) return Promise.resolve(true);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(shell.finishedAt !== undefined);
    }, timeoutMs);
    const onClose = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      proc.off('close', onClose);
    };

    proc.once('close', onClose);
  });
}

async function requestProcessTreeTermination(
  proc: ChildProcess | undefined,
  pid: number | undefined,
  signal: NodeJS.Signals,
): Promise<void> {
  if (!proc || pid === undefined) return;

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      exec(`taskkill /PID ${pid} /T /F`, () => resolve());
    });
    if (!proc.killed) proc.kill();
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    proc.kill(signal);
  }
}

async function terminateShell(
  shell: BackgroundShellRecord,
  terminalStatus: 'killed' | 'timed_out',
): Promise<boolean> {
  if (isTerminalStatus(shell.status)) return true;

  clearShellTimer(shell);
  shell.status = 'stopping';

  await requestProcessTreeTermination(shell.process, shell.pid, 'SIGTERM');
  let closed = await waitForClose(shell, TERMINATE_GRACE_MS);

  if (!closed && process.platform !== 'win32') {
    await requestProcessTreeTermination(shell.process, shell.pid, 'SIGKILL');
    closed = await waitForClose(shell, TERMINATE_GRACE_MS);
  }

  if (!closed && shell.finishedAt === undefined) {
    return false;
  }

  finishShell(shell, terminalStatus, shell.exitCode, shell.signal);
  return true;
}

async function bash(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const background = readBoolean(args, 'run_in_background', 'runInBackground');
  if (background) return bashBackground(args, ctx);
  return bashForeground(args, ctx);
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
      proc = exec(built.effectiveCommand, {
        cwd: built.workdir,
        timeout,
        maxBuffer: MAX_FOREGROUND_BUFFER,
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
    let termination: Promise<void> | undefined;

    const cleanup = () => {
      ctx.signal?.removeEventListener('abort', onAbort);
      ctx.runtime?.releaseChildProcess(proc);
    };
    const finish = async (result: ToolResult) => {
      if (settled) return;
      settled = true;
      try {
        await termination;
      } catch {
        // The tool still returns cancellation if the process exited during teardown.
      }
      cleanup();
      resolve(result);
    };
    const onAbort = () => {
      if (cancelled) return;
      cancelled = true;
      termination = requestProcessTreeTermination(proc, proc.pid, 'SIGTERM');
      void finish(fail('Command cancelled'));
    };

    proc.stdout?.on('data', (data) => {
      stdout += data;
    });
    proc.stderr?.on('data', (data) => {
      stderr += data;
    });

    proc.on('close', (code) => {
      if (cancelled) {
        void finish(fail('Command cancelled'));
        return;
      }
      if (code === 0) {
        void finish(ok((built.sandboxed ? '[sandboxed] ' : '') + (stdout || '(no output)')));
      } else {
        void finish(fail(stderr || `Exit code: ${code}`, stdout));
      }
    });

    proc.on('error', (err) => {
      void finish(fail(cancelled ? 'Command cancelled' : err.message));
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

  const id = nextShellId(ctx);
  let proc: ChildProcess;
  try {
    proc = spawn(built.effectiveCommand, {
      cwd: built.workdir,
      env: { ...process.env, ...ctx.env },
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  const startup = waitForSpawn(proc);

  proc.unref();
  unrefStream(proc.stdout);
  unrefStream(proc.stderr);

  const shell: BackgroundShellRecord = {
    id,
    command: built.command,
    effectiveCommand: built.effectiveCommand,
    workdir: built.workdir,
    pid: proc.pid,
    process: proc,
    status: 'running',
    output: '',
    readOffset: 0,
    truncatedBytes: 0,
    startedAt: Date.now(),
    sandboxed: built.sandboxed,
  };
  shellStore(ctx).shells.set(id, shell);

  proc.stdout?.on('data', (data) => appendOutput(shell, data));
  proc.stderr?.on('data', (data) => appendOutput(shell, data));
  proc.on('error', (err) => {
    appendOutput(shell, `${err.message}\n`);
    finishShell(shell, 'failed');
    scheduleShellRetention(shellStore(ctx), shell);
  });
  proc.on('close', (code, signal) => {
    if (shell.status === 'stopping') {
      shell.exitCode = code;
      shell.signal = signal;
      shell.finishedAt = Date.now();
      clearShellTimer(shell);
      return;
    }
    finishShell(shell, code === 0 ? 'exited' : 'failed', code, signal);
    scheduleShellRetention(shellStore(ctx), shell);
  });

  const startupError = await startup;
  if (startupError) {
    deleteShellRecord(shellStore(ctx), id);
    return fail(startupError.message);
  }

  if (Object.prototype.hasOwnProperty.call(args, 'timeout')) {
    const timeout = readNumber(args, 'timeout');
    if (timeout && timeout > 0) {
      shell.timer = setTimeout(() => {
        if (isTerminalStatus(shell.status)) return;
        void terminateShell(shell, 'timed_out').then((stopped) => {
          if (!stopped) {
            appendOutput(shell, '[timed out; process did not exit after termination attempts]\n');
          } else {
            scheduleShellRetention(shellStore(ctx), shell);
          }
        });
      }, timeout);
    }
  }

  return ok(
    [
      `Started background shell ${id}${proc.pid ? ` (pid ${proc.pid})` : ''}.`,
      `Use BashOutput with shell_id="${id}" to read output.`,
      `Use KillShell with shell_id="${id}" to stop it.`,
      built.sandboxed ? '[sandboxed]' : undefined,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

async function bashOutput(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const shellId = readString(args, 'shell_id', 'shellId')?.trim();
  if (!shellId) return fail('shell_id must be a non-empty string');

  const shell = shellStore(ctx).shells.get(shellId);
  if (!shell) return fail(`Shell ${shellId} not found`);

  const lines = [statusLine(shell)];
  if (shell.truncatedBytes > 0) {
    lines.push(`[${shell.truncatedBytes} older characters truncated from buffer]`);
  }
  lines.push(readShellOutput(shell));
  return ok(lines.join('\n'));
}

async function killShell(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const shellId = readString(args, 'shell_id', 'shellId')?.trim();
  if (!shellId) return fail('shell_id must be a non-empty string');

  const shell = shellStore(ctx).shells.get(shellId);
  if (!shell) return fail(`Shell ${shellId} not found`);

  if (isTerminalStatus(shell.status)) {
    return ok(`Shell ${shell.id} is already ${shell.status}; no running process was stopped.`);
  }

  const stopped = await terminateShell(shell, 'killed');
  if (!stopped) {
    return fail(`Sent termination to shell ${shell.id}, but it is still stopping.`);
  }
  scheduleShellRetention(shellStore(ctx), shell);
  return ok(`Killed shell ${shell.id}${shell.pid ? ` (pid ${shell.pid})` : ''}.`);
}

async function dismissShell(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const shellId = readString(args, 'shell_id', 'shellId')?.trim();
  if (!shellId) return fail('shell_id must be a non-empty string');
  const store = shellStore(ctx);
  const shell = store.shells.get(shellId);
  if (!shell) return fail(`Shell ${shellId} not found`);
  if (!isTerminalStatus(shell.status)) {
    return fail(`Shell ${shellId} is still ${shell.status}; stop it before dismissing the record.`);
  }
  deleteShellRecord(store, shellId);
  return ok(`Dismissed shell ${shellId}.`);
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
        run_in_background: {
          type: 'boolean',
          description: 'Start the command in the background and return a shell_id immediately',
          default: false,
        },
      },
      required: ['command'],
    },
    execute: bash,
  },
  {
    name: 'BashOutput',
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
