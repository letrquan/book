import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type {
  BackgroundShellNotify,
  BackgroundShellRecord,
  CommandExecution,
  ResolvedShell,
} from '../types/runtime.js';
import { resolveShell, shellExecution } from '../shell-selection.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../types/tools.js';
import {
  createSandbox,
  matchesExcludedCommand,
  unsandboxedRefusalMessage,
  type SandboxSkipReason,
} from '../sandbox.js';
import { buildChildEnv } from '../child-env.js';
import { isTerminalShellStatus, ShellJobManager } from '../jobs/shell-manager.js';
import { terminateForegroundProcess } from '../jobs/process-tree.js';
import { resolveWorkspacePath } from './path-utils.js';
import { toolFailure, toolSuccess } from './result.js';
import {
  MAX_SAFE_TIMEOUT_MS,
  MAX_TOOL_TIMEOUT_MS,
  resolveToolTimeoutMs,
  toolTimeoutCeilingMs,
} from './timeouts.js';

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
/** Per-stream cap when reporting output that already blew the buffer limit. */
const OVERFLOW_STREAM_TAIL = 64 * 1024;

function tail(stream: string): string {
  return stream.length <= OVERFLOW_STREAM_TAIL ? stream : stream.slice(-OVERFLOW_STREAM_TAIL);
}

/**
 * A killed command is judged on whatever it managed to say, and both streams
 * count: a build that dies mid-run usually leaves its only clue on stderr. They
 * are labelled rather than concatenated, because the two are written on
 * independent schedules and gluing them together presents a timeline that never
 * happened.
 */
function labelStreams(stdout: string, stderr: string): string {
  if (!stdout && !stderr) return '(no output was captured before the command was killed)';
  if (!stderr) return stdout;
  if (!stdout) return stderr;
  return `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;
}
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
  /**
   * Present for sandboxed commands and for a session shell spawned as argv
   * (Git Bash or PowerShell on Windows); absent means Node's `shell: true`,
   * which is how cmd.exe and the POSIX default are driven.
   */
  exec?: CommandExecution;
  sandboxed: boolean;
  error?: string;
}

/**
 * The shell for this session. `loadConfig` resolves it once and the loop
 * copies it onto the context; a hand-built context resolves on demand.
 */
function sessionShell(ctx: ToolContext): ResolvedShell {
  return (
    ctx.shell ??
    ctx.agentConfig?.shell ??
    resolveShell({ env: ctx.env, requested: ctx.agentConfig?.settings.shell })
  );
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
  // An unsandboxed command still spawns as argv when the session shell is a
  // real program (Git Bash, PowerShell); only cmd.exe and `/bin/sh` fall back
  // to `shell: true`.
  const shellExec = shellExecution(sessionShell(ctx), command);
  if (shellExec) plain.exec = shellExec;
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
  // Refused rather than clamped. The schema's static maximum is validated, but
  // an operator's lower BOOK_TOOL_TIMEOUT_MS is not in the schema, so a value
  // inside the published range can still be over the limit in force here.
  // Quietly shrinking it is the failure this change set out to remove: the
  // model would believe it had raised a deadline it had not.
  const requestedTimeout = readNumber(args, 'timeout');
  const ceiling = toolTimeoutCeilingMs(ctx.env);
  if (requestedTimeout !== undefined && requestedTimeout > ceiling) {
    return fail(
      `timeout ${requestedTimeout}ms exceeds the ${ceiling}ms limit in force here (BOOK_TOOL_TIMEOUT_MS). ` +
        `Re-run with a timeout at or below ${ceiling}ms, or with run_in_background: true and poll BashOutput.`,
    );
  }
  const timeout = resolveToolTimeoutMs({
    requested: requestedTimeout,
    env: ctx.env,
    fallback: DEFAULT_BASH_TIMEOUT_MS,
  });

  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawnEffective(built, {
        cwd: built.workdir,
        // A NODE_ENV Book defaulted for its own renderer is not the command's, and `npm install`
        // reading one drops devDependencies. `ctx.env` is an explicit request, so it wins.
        env: buildChildEnv(process.env, ctx.env),
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
    let backgrounded = false;
    let bufferExceeded = false;
    let closed = false;
    let termination: Promise<void> | undefined;
    /** When the command was spawned, which is what an adopted shell records as its start. */
    const startedAt = Date.now();
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
    const capturedOutput = () => labelStreams(stdout, stderr);

    /**
     * Begin ending the process's whole tree.
     *
     * Marked on the runtime first, and synchronously: a `dispose()` in the same tick has to be
     * able to tell this tree apart from one it would have to kill itself, and killing the wrapper
     * before `taskkill /T` has walked it orphans the tree instead of ending it (#314).
     */
    const beginTeardown = (): Promise<void> => {
      ctx.runtime?.trackTreeTermination(proc);
      return terminateForegroundProcess(proc);
    };

    /**
     * Hand the still-running command to the session's shell manager instead of killing it.
     *
     * A foreground command that reaches its deadline used to die there, and the model got
     * `timed_out` with no result and usually a re-run of the whole gate (#302). Moving it to the
     * background costs the model nothing it was not already paying, and everything after it is
     * one `BashOutput` away.
     *
     * Returns `undefined` when the move is impossible — no manager for this context, a disposed
     * one, or a process that has already exited — and the caller then kills the command and
     * reports the timeout exactly as before.
     */
    const adoptAsBackground = (): BackgroundShellRecord | undefined => {
      if (ctx.runtime?.isDisposed) return undefined;
      let record: BackgroundShellRecord | undefined;
      try {
        record = manager(ctx).adopt({
          process: proc,
          command: built.command,
          effectiveCommand: built.effectiveCommand,
          workdir: built.workdir,
          sandboxed: built.sandboxed,
          startedAt,
          initialOutput: labelStreams(stdout, stderr),
          parentSessionId: ctx.parentSessionId,
          rootRunId: ctx.runContext?.rootRunId,
          parentRunId: ctx.runContext?.runId,
        });
      } catch {
        // A manager that cannot take it leaves the process to the caller, which is the old
        // behaviour. It is not a failure of the command.
        return undefined;
      }
      if (!record) return undefined;
      // The manager is reading now. This call's own readers go, in the same tick, so no output
      // can be delivered to one of them and lost between the two.
      proc.stdout?.off('data', onStdout);
      proc.stderr?.off('data', onStderr);
      return record;
    };

    const timer = setTimeout(() => {
      const adopted = adoptAsBackground();
      if (adopted) {
        backgrounded = true;
        // Success, not failure: nothing failed, the command simply outlived the deadline the
        // caller gave it. The result says where it went and how to pick it up.
        void finish(
          ok(
            [
              // The output so far, as the buffer-cap path reports it, so the model has the
              // progress the command made before the move and not only a shell id.
              labelStreams(tail(stdout), tail(stderr)),
              `Command still running after ${timeout}ms; moved to background shell ${adopted.id}${
                adopted.pid ? ` (pid ${adopted.pid})` : ''
              }, not killed. Its output so far is above. Next: BashOutput with shell_id="${adopted.id}" and wait_ms to wait for it to finish, or KillShell with shell_id="${adopted.id}" to stop it.`,
            ].join('\n'),
            { backgrounded: true, shell: adopted },
          ),
        );
        return;
      }
      timedOut = true;
      // Wait for the pipes as well as the process. On POSIX the tree teardown
      // only confirms the process group is gone, so without this the last chunk
      // a batching runner flushed on the way out can still be in flight — and
      // that tail is the only progress the model ever sees.
      termination ??= beginTeardown().then(() => drainStdio());
      // Built after termination settles rather than at kill time, so the result
      // carries that flush.
      void finish(() => {
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
      // An adopted process belongs to the shell manager now, not to this call. Releasing it
      // stops the runtime from killing it on dispose: dispose ends session shells through the
      // manager, which walks the whole tree.
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
      termination = beginTeardown();
      void finish(fail('Command cancelled'));
    };
    const onStdout = (data: unknown) => append('stdout', data);
    const onStderr = (data: unknown) => append('stderr', data);
    const append = (target: 'stdout' | 'stderr', data: unknown) => {
      const chunk = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      if (target === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length <= MAX_FOREGROUND_BUFFER || bufferExceeded) return;
      bufferExceeded = true;
      termination ??= beginTeardown();
      // Bounded tails, not the whole buffer. This path fires at the 10MB cap,
      // and composing both streams in full would allocate a second copy of it
      // exactly when the process is already at its output ceiling — and then
      // write that copy to the artifact file.
      void finish(
        fail(
          `Command output exceeded ${MAX_FOREGROUND_BUFFER} characters`,
          labelStreams(tail(stdout), tail(stderr)),
        ),
      );
    };

    proc.stdout?.on('data', onStdout);
    proc.stderr?.on('data', onStderr);
    proc.on('close', (code) => {
      closed = true;
      if (cancelled || timedOut || backgrounded || bufferExceeded) return;
      void finish(
        code === 0
          ? ok((built.sandboxed ? '[sandboxed] ' : '') + (stdout || '(no output)'))
          : fail(stderr || `Exit code: ${code}`, stdout),
      );
    });
    proc.on('error', (error) => {
      if (!cancelled && !timedOut && !backgrounded && !bufferExceeded)
        void finish(fail(error.message));
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
  // Clamped as well as validated: `setTimeout` rewrites anything past the
  // 32-bit ceiling to 1ms, so an unguarded 30-day runtime would kill a
  // long-horizon job moments after it started and report its deadline as fired.
  const requested = readNumber(args, 'max_runtime_ms');
  const requestedRuntime =
    requested === undefined ? undefined : Math.min(requested, MAX_SAFE_TIMEOUT_MS);
  try {
    const shell = await manager(ctx).start({
      command: built.command,
      effectiveCommand: built.effectiveCommand,
      exec: built.exec,
      workdir: built.workdir,
      env: buildChildEnv(process.env, ctx.env),
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

/** How often a waiting `BashOutput` checks a persistent job's state and output file. */
const WAIT_POLL_INTERVAL_MS = 250;

/**
 * Resolve once `shellId` is terminal, or `waitMs` elapses, or the call is aborted.
 *
 * A session shell reports its transitions as events, so it is subscribed rather than polled. A
 * persistent job lives in another process, so its record file is the only thing to read and it
 * is polled — 250ms is well under the 500ms a status change takes to be worth noticing, and a
 * wait that ends a few hundred milliseconds late costs nothing next to the turn it saved.
 */
function waitForShell(
  shells: ShellJobManager,
  shellId: string,
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    let poll: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => done(), waitMs);
    const unsubscribe = shells.subscribe((event) => {
      if (event.type === 'background_job_result' && event.job.id === shellId) done();
    });
    function done() {
      clearTimeout(timer);
      clearInterval(poll);
      unsubscribe();
      signal?.removeEventListener('abort', done);
      resolve();
    }
    const terminalNow = () => {
      const shell = shells.get(shellId);
      return shell === undefined || isTerminalShellStatus(shell.status);
    };
    if (terminalNow()) {
      done();
      return;
    }
    if (signal) {
      if (signal.aborted) {
        done();
        return;
      }
      // An aborted wait ends early and kills nothing: the shell is still there, and a second
      // call can wait on it again.
      signal.addEventListener('abort', done, { once: true });
    }
    if (shells.get(shellId)?.lifetime === 'persistent') {
      poll = setInterval(() => {
        if (terminalNow()) done();
      }, WAIT_POLL_INTERVAL_MS);
    }
  });
}

async function bashOutput(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const shellId = readString(args, 'shell_id', 'shellId')?.trim();
  if (!shellId) return fail('shell_id must be a non-empty string');
  const shells = manager(ctx);
  if (!shells.get(shellId)) return fail(`Shell ${shellId} not found`);
  const requestedWait = readNumber(args, 'wait_ms') ?? readNumber(args, 'waitMs');
  // Refused rather than clamped, exactly as Bash refuses an over-limit `timeout`: the model would
  // otherwise believe it had a ten-minute wait and get a shorter one.
  const ceiling = toolTimeoutCeilingMs(ctx.env);
  if (requestedWait !== undefined && requestedWait > ceiling) {
    return fail(
      `wait_ms ${requestedWait}ms exceeds the ${ceiling}ms limit in force here (BOOK_TOOL_TIMEOUT_MS). ` +
        `Re-run with a wait_ms at or below ${ceiling}ms.`,
    );
  }
  if (requestedWait !== undefined && requestedWait > 0) {
    await waitForShell(shells, shellId, requestedWait, ctx.signal);
  }
  const result = shells.readOutput(shellId);
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
  // A shell that is still running and has said nothing new is the case where polling costs the
  // most and helps the least, so the result names the cheaper call rather than leaving the model
  // to infer it from a status line.
  if (!isTerminalShellStatus(result.shell.status) && result.output === '(no new output)') {
    lines.push(
      `Still running with no new output. Call BashOutput with wait_ms (up to ${ceiling}ms) to wait for it to finish instead of polling again.`,
    );
  }
  return ok(lines.join('\n'), result);
}

async function killShell(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const shellId = readString(args, 'shell_id', 'shellId')?.trim();
  if (!shellId) return fail('shell_id must be a non-empty string');
  const shell = manager(ctx).get(shellId);
  if (!shell) return fail(`Shell ${shellId} not found`);
  if (isTerminalShellStatus(shell.status)) {
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
    description:
      'Execute a command in the workspace, in the session shell named by the Harness section of the system prompt (Git Bash, PowerShell, /bin/sh, or cmd.exe). A foreground command that reaches its timeout is not killed: it moves to a background shell and the result names the shell_id to read it with BashOutput.',
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
          description: `How long a foreground command may run, in milliseconds (default ${DEFAULT_BASH_TIMEOUT_MS}, maximum ${MAX_TOOL_TIMEOUT_MS}). Raise it for a known-slow command such as a full build or test suite. A command still running when this elapses is moved to a background shell rather than killed, and the result names its shell_id; use run_in_background: true to get one up front instead. Background commands use max_runtime_ms instead.`,
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
          maximum: MAX_SAFE_TIMEOUT_MS,
          description: `Optional maximum runtime for a background command, in milliseconds (maximum ${MAX_SAFE_TIMEOUT_MS}, about 24 days). Omit it to let the job run until it exits or is killed.`,
        },
        title: { type: 'string', description: 'Short label shown in the background job panel.' },
      },
      required: ['command'],
    },
    execute: bash,
  },
  {
    name: 'BashOutput',
    argumentAliases: { shellId: 'shell_id', waitMs: 'wait_ms' },
    description:
      'Read new output and status from a background shell started by Bash(run_in_background), or by a foreground command that reached its timeout. Pass wait_ms to wait for the shell to finish instead of polling it once per turn.',
    // The wait is this tool's own deadline, so the registry's backstop has to sit behind it. A
    // constant declaration is what the registry adds SELF_TIMEOUT_GRACE_MS to; the model's
    // `wait_ms` is separately capped at `toolTimeoutCeilingMs`, which is at most this value, so
    // the backstop cannot fire first even under an operator's lower BOOK_TOOL_TIMEOUT_MS.
    timeoutMs: MAX_TOOL_TIMEOUT_MS,
    parameters: {
      type: 'object',
      properties: {
        shell_id: { type: 'string', description: 'Background shell ID returned by Bash' },
        wait_ms: {
          type: 'number',
          minimum: 1,
          maximum: MAX_TOOL_TIMEOUT_MS,
          description: `Optional wait, in milliseconds, for the shell to reach a terminal status before this returns (maximum ${MAX_TOOL_TIMEOUT_MS}). It returns as soon as the shell finishes, and it does not return early on new output, so a chatty test runner costs the same wait as a silent one. Omit it to read the current output and status at once.`,
        },
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
