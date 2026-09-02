import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { systemClock, type Clock } from '../clock.js';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  BackgroundShellNotify,
  BackgroundShellRecord,
  BackgroundShellStatus,
  BackgroundShellStore,
  CommandExecution,
} from '../types/runtime.js';
import {
  ensurePersistentJobPaths,
  listPersistentStates,
  persistentJobPaths,
  readJsonFile,
  removePersistentJobFiles,
  removePersistentRunnerFiles,
  writeJsonAtomic,
  type PersistentJobPaths,
  type PersistentShellSpec,
  type PersistentShellState,
} from './persistent-store.js';
import { isProcessAlive, signalProcessGroup, waitForProcessGroupExit } from './process-tree.js';
import { system32Executable } from '../system32.js';

const MAX_BACKGROUND_BUFFER = 1024 * 1024 * 5;
const MAX_OUTPUT_RESULT = 32_000;
const TERMINATE_GRACE_MS = 1_500;
const MAX_RETAINED_TERMINAL_SHELLS = 20;
const TERMINAL_SHELL_TTL_MS = 15 * 60_000;
const PERSISTENT_HEARTBEAT_STALE_MS = 10_000;

export type ShellJobEvent =
  | { type: 'background_job_start'; job: BackgroundShellRecord }
  | { type: 'background_job_update'; job: BackgroundShellRecord }
  | { type: 'background_job_output'; jobId: string; revision: number }
  | { type: 'background_job_result'; job: BackgroundShellRecord }
  | { type: 'background_job_dismiss'; jobId: string };

export interface ShellStartOptions {
  command: string;
  effectiveCommand: string;
  /** Present only for sandboxed commands, which never go through a shell. */
  exec?: CommandExecution;
  workdir: string;
  env: NodeJS.ProcessEnv;
  sandboxed: boolean;
  title?: string;
  notify?: BackgroundShellNotify;
  timeoutMs?: number;
  lifetime?: 'session' | 'persistent';
  workspace?: string;
  envOverrides?: Record<string, string>;
  parentSessionId?: string;
  rootRunId?: string;
  parentRunId?: string;
}

export interface ShellOutputResult {
  shell: BackgroundShellRecord;
  output: string;
  remaining: number;
}

export interface ShellJobManagerOptions {
  persistentRoot?: string;
  /**
   * Budgets for observing the detached runner's state transitions. The
   * defaults suit an interactive host; tests on contended CI runners pass
   * wider windows because the transitions are eventual, not latency-bound.
   */
  runnerStartBudgetMs?: number;
  runnerStopBudgetMs?: number;
  /**
   * Injected by tests. Only the two budgets above read it: every other time in
   * this file is a stamp shared with the detached runner process, and those
   * stay on the wall clock because two processes share no monotonic origin.
   */
  clock?: Clock;
}

function cloneRecord(shell: BackgroundShellRecord): BackgroundShellRecord {
  return {
    ...shell,
    process: undefined,
    timer: undefined,
    retentionTimer: undefined,
    controlToken: undefined,
  };
}

export function isTerminalShellStatus(status: BackgroundShellStatus): boolean {
  return (
    status === 'exited' ||
    status === 'failed' ||
    status === 'killed' ||
    status === 'timed_out' ||
    status === 'lost'
  );
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
    const onError = (error: Error) => {
      cleanup();
      resolve(error);
    };
    const cleanup = () => {
      proc.off('spawn', onSpawn);
      proc.off('error', onError);
    };
    proc.once('spawn', onSpawn);
    proc.once('error', onError);
  });
}

function waitForProcessClose(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(proc.exitCode !== null || proc.signalCode !== null);
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

function waitForShellClose(shell: BackgroundShellRecord, timeoutMs: number): Promise<boolean> {
  if (shell.finishedAt !== undefined) return Promise.resolve(true);
  return shell.process ? waitForProcessClose(shell.process, timeoutMs) : Promise.resolve(true);
}

type WindowsTreeKill = (pid: number) => Promise<boolean>;

async function runTaskkill(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      system32Executable('taskkill'),
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: TERMINATE_GRACE_MS },
      (error) => resolve(!error),
    );
  });
}

export async function terminateWindowsProcessTree(
  proc: ChildProcess,
  pid: number,
  signal: NodeJS.Signals,
  treeKill: WindowsTreeKill = runTaskkill,
): Promise<boolean> {
  const alreadyExited = proc.exitCode !== null || proc.signalCode !== null;
  if (alreadyExited) return true;
  if (await treeKill(pid)) return true;
  try {
    proc.kill(signal);
  } catch {
    // The process may have exited between taskkill and the direct-child fallback.
  }
  return false;
}

/**
 * Escalate SIGTERM → SIGKILL across the whole tree and report whether it is really gone.
 *
 * On POSIX the direct child is the `sh -c` wrapper, which dies from SIGTERM even when the worker
 * it forked ignores it, so its exit says nothing about the tree — success is judged on whether
 * the process group still holds anything. On Windows `taskkill /T /F` covers the tree, so the
 * direct child's close speaks for the tree only when taskkill actually ran.
 */
async function terminateProcessTree(
  proc: ChildProcess | undefined,
  pid: number | undefined,
  hasClosed: (timeoutMs: number) => Promise<boolean>,
): Promise<boolean> {
  if (!proc || pid === undefined) return true;
  if (process.platform !== 'win32') {
    signalProcessGroup(proc, pid, 'SIGTERM');
    if (await waitForProcessGroupExit(pid, TERMINATE_GRACE_MS)) return true;
    signalProcessGroup(proc, pid, 'SIGKILL');
    return waitForProcessGroupExit(pid, TERMINATE_GRACE_MS);
  }
  const confirmed = await terminateWindowsProcessTree(proc, pid, 'SIGTERM');
  if (await hasClosed(TERMINATE_GRACE_MS)) return confirmed;
  try {
    proc.kill('SIGKILL');
  } catch {
    return false;
  }
  return (await hasClosed(TERMINATE_GRACE_MS)) && confirmed;
}

export async function terminateForegroundProcess(proc: ChildProcess): Promise<void> {
  await terminateProcessTree(proc, proc.pid, (timeoutMs) => waitForProcessClose(proc, timeoutMs));
}

export class ShellJobManager {
  private readonly subscribers = new Set<(event: ShellJobEvent) => void>();
  private workspace?: string;
  private persistentPaths?: PersistentJobPaths;
  private persistentStorageError?: Error;
  private monitor?: NodeJS.Timeout;

  constructor(
    private readonly store: BackgroundShellStore,
    private readonly options: ShellJobManagerOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
  }

  private readonly clock: Clock;

  subscribe(listener: (event: ShellJobEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  configureWorkspace(workspace: string): void {
    if (this.workspace === workspace && this.persistentPaths && !this.persistentStorageError)
      return;
    this.workspace = workspace;
    this.persistentPaths = persistentJobPaths(workspace, this.options.persistentRoot);
    try {
      ensurePersistentJobPaths(this.persistentPaths);
      this.persistentStorageError = undefined;
    } catch (error) {
      this.persistentStorageError = error instanceof Error ? error : new Error(String(error));
      return;
    }
    for (const loadedState of listPersistentStates(this.persistentPaths)) {
      const recordPath = join(this.persistentPaths.records, `${loadedState.id}.json`);
      const state = this.reconcilePersistentState(loadedState, recordPath);
      const existing = this.store.shells.get(state.id);
      if (existing) this.applyPersistentState(existing, state);
      else this.store.shells.set(state.id, this.recordFromPersistentState(state));
    }
    if (!this.monitor) {
      this.monitor = setInterval(() => this.refreshPersistentJobs(), 500);
      this.monitor.unref();
    }
  }

  list(): BackgroundShellRecord[] {
    this.refreshPersistentJobs();
    this.pruneTerminalShells();
    return Array.from(this.store.shells.values())
      .map(cloneRecord)
      .sort((left, right) => right.startedAt - left.startedAt);
  }

  get(shellId: string): BackgroundShellRecord | undefined {
    this.refreshPersistentJobs();
    this.pruneTerminalShells();
    const shell = this.store.shells.get(shellId);
    return shell ? cloneRecord(shell) : undefined;
  }

  listPendingAgentCompletions(parentSessionId: string): BackgroundShellRecord[] {
    this.refreshPersistentJobs();
    return Array.from(this.store.shells.values())
      .filter(
        (shell) =>
          shell.notify === 'agent' &&
          shell.parentSessionId === parentSessionId &&
          isTerminalShellStatus(shell.status) &&
          (shell.completionSequence ?? 0) > (shell.completionDeliveredSequence ?? 0),
      )
      .map(cloneRecord);
  }

  listPendingUiCompletions(): BackgroundShellRecord[] {
    this.refreshPersistentJobs();
    return Array.from(this.store.shells.values())
      .filter(
        (shell) =>
          shell.notify !== 'none' &&
          isTerminalShellStatus(shell.status) &&
          (shell.completionSequence ?? 0) > (shell.completionAcknowledgedSequence ?? 0),
      )
      .map(cloneRecord)
      .sort((left, right) => (left.finishedAt ?? 0) - (right.finishedAt ?? 0));
  }

  async start(options: ShellStartOptions): Promise<BackgroundShellRecord> {
    if (options.lifetime === 'persistent') return this.startPersistent(options);
    const id = `shell_${this.store.nextId++}`;
    let proc: ChildProcess;
    try {
      const base: SpawnOptions = {
        cwd: options.workdir,
        env: options.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      };
      // Sandboxed commands spawn bwrap directly; only the unsandboxed path may
      // hand a command string to the platform shell.
      proc = options.exec
        ? spawn(options.exec.file, options.exec.args, { ...base, shell: false })
        : spawn(options.effectiveCommand, { ...base, shell: true });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }

    const startup = waitForSpawn(proc);
    proc.unref();
    unrefStream(proc.stdout);
    unrefStream(proc.stderr);

    const shell: BackgroundShellRecord = {
      id,
      command: options.command,
      effectiveCommand: options.effectiveCommand,
      title: options.title?.trim() || options.command,
      workdir: options.workdir,
      pid: proc.pid,
      process: proc,
      status: 'running',
      lifetime: 'session',
      notify: options.notify ?? 'ui',
      output: '',
      readOffset: 0,
      truncatedBytes: 0,
      outputRevision: 0,
      completionSequence: 0,
      completionAcknowledgedSequence: 0,
      completionDeliveredSequence: 0,
      startedAt: Date.now(),
      sandboxed: options.sandboxed,
      timeoutMs: options.timeoutMs,
      deadlineAt: options.timeoutMs ? Date.now() + options.timeoutMs : undefined,
      parentSessionId: options.parentSessionId,
      rootRunId: options.rootRunId,
      parentRunId: options.parentRunId,
    };
    this.store.shells.set(id, shell);

    proc.stdout?.on('data', (data) => this.appendOutput(shell, data));
    proc.stderr?.on('data', (data) => this.appendOutput(shell, data));
    proc.on('error', (error) => {
      this.appendOutput(shell, `${error.message}\n`);
      this.finish(shell, 'failed');
    });
    proc.on('close', (code, signal) => {
      if (shell.status === 'stopping') {
        shell.exitCode = code;
        shell.signal = signal;
        shell.finishedAt = Date.now();
        this.clearTimer(shell);
        return;
      }
      this.finish(shell, code === 0 ? 'exited' : 'failed', code, signal);
    });

    const startupError = await startup;
    if (startupError) {
      this.deleteRecord(id);
      throw startupError;
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      shell.timer = setTimeout(() => {
        if (isTerminalShellStatus(shell.status)) return;
        void this.terminate(shell, 'timed_out').then((stopped) => {
          if (!stopped) {
            this.appendOutput(
              shell,
              '[timed out; process did not exit after termination attempts]\n',
            );
          }
        });
      }, options.timeoutMs);
    }

    this.emit({ type: 'background_job_start', job: cloneRecord(shell) });
    return cloneRecord(shell);
  }

  readOutput(shellId: string, limit = MAX_OUTPUT_RESULT): ShellOutputResult | undefined {
    this.refreshPersistentJobs();
    this.pruneTerminalShells();
    const shell = this.store.shells.get(shellId);
    if (!shell) return undefined;
    if (shell.lifetime === 'persistent' && shell.persistentOutputPath) {
      const content = existsSync(shell.persistentOutputPath)
        ? readFileSync(shell.persistentOutputPath, 'utf8')
        : '';
      if (content.length < shell.readOffset) {
        shell.truncatedBytes += shell.readOffset - content.length;
        shell.readOffset = 0;
      }
      const unread = content.slice(shell.readOffset);
      const output = unread ? unread.slice(0, Math.max(1, limit)) : '(no new output)';
      if (unread) shell.readOffset += output.length;
      return {
        shell: cloneRecord(shell),
        output,
        remaining: unread ? Math.max(0, unread.length - output.length) : 0,
      };
    }
    const unread = shell.output.slice(shell.readOffset);
    const output = unread ? unread.slice(0, Math.max(1, limit)) : '(no new output)';
    if (unread) shell.readOffset += output.length;
    return {
      shell: cloneRecord(shell),
      output,
      remaining: unread ? Math.max(0, unread.length - output.length) : 0,
    };
  }

  readTail(shellId: string, limit = 4_000): string | undefined {
    this.refreshPersistentJobs();
    const shell = this.store.shells.get(shellId);
    if (shell?.lifetime === 'persistent' && shell.persistentOutputPath) {
      try {
        return readFileSync(shell.persistentOutputPath, 'utf8').slice(-Math.max(1, limit));
      } catch {
        return '';
      }
    }
    return shell?.output.slice(-Math.max(1, limit));
  }

  async stop(shellId: string, reason: 'killed' | 'timed_out' = 'killed'): Promise<boolean> {
    const shell = this.store.shells.get(shellId);
    if (!shell) throw new Error(`Shell ${shellId} not found`);
    if (isTerminalShellStatus(shell.status)) return true;
    if (shell.lifetime === 'persistent') return this.stopPersistent(shell, reason);
    return this.terminate(shell, reason);
  }

  dismiss(shellId: string): void {
    const shell = this.store.shells.get(shellId);
    if (!shell) throw new Error(`Shell ${shellId} not found`);
    if (!isTerminalShellStatus(shell.status)) {
      throw new Error(
        `Shell ${shellId} is still ${shell.status}; stop it before dismissing the record.`,
      );
    }
    this.deleteRecord(shellId);
    this.emit({ type: 'background_job_dismiss', jobId: shellId });
  }

  acknowledgeCompletion(shellId: string, sequence?: number, consumer: 'ui' | 'agent' = 'ui'): void {
    const shell = this.store.shells.get(shellId);
    if (!shell) return;
    const target = sequence ?? shell.completionSequence ?? 0;
    if (consumer === 'agent') {
      shell.completionDeliveredSequence = Math.max(shell.completionDeliveredSequence ?? 0, target);
    } else {
      shell.completionAcknowledgedSequence = Math.max(
        shell.completionAcknowledgedSequence ?? 0,
        target,
      );
    }
    this.persistAcknowledgement(shell);
    this.emit({ type: 'background_job_update', job: cloneRecord(shell) });
  }

  dispose(): void {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = undefined;
    for (const shell of this.store.shells.values()) {
      this.clearTimer(shell);
      if (shell.retentionTimer) clearTimeout(shell.retentionTimer);
      if (
        shell.lifetime !== 'persistent' &&
        !isTerminalShellStatus(shell.status) &&
        shell.process &&
        !shell.process.killed
      ) {
        shell.process.kill();
      }
    }
    this.store.shells.clear();
    this.subscribers.clear();
  }

  private emit(event: ShellJobEvent): void {
    for (const subscriber of this.subscribers) subscriber(event);
  }

  private persistAcknowledgement(shell: BackgroundShellRecord): void {
    if (shell.lifetime !== 'persistent' || !shell.persistentRecordPath) return;
    const state = readJsonFile<PersistentShellState>(shell.persistentRecordPath);
    if (!state) return;
    writeJsonAtomic(shell.persistentRecordPath, {
      ...state,
      revision: state.revision + 1,
      completionDeliveredSequence: shell.completionDeliveredSequence ?? 0,
      completionAcknowledgedSequence: shell.completionAcknowledgedSequence ?? 0,
    });
  }

  private async startPersistent(options: ShellStartOptions): Promise<BackgroundShellRecord> {
    const workspace = options.workspace ?? this.workspace;
    if (!workspace) throw new Error('Persistent background shells require an active workspace.');
    this.configureWorkspace(workspace);
    const paths = this.persistentPaths!;
    if (this.persistentStorageError) {
      throw new Error(
        `Persistent background-job storage is unavailable: ${this.persistentStorageError.message}`,
      );
    }
    const id = `shell_${randomUUID()}`;
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const recordPath = join(paths.records, `${id}.json`);
    const controlPath = join(paths.controls, `${id}.json`);
    const outputPath = join(paths.logs, `${id}.log`);
    const specPath = join(paths.specs, `${id}.json`);
    const spec: PersistentShellSpec = {
      version: 1,
      id,
      command: options.command,
      effectiveCommand: options.effectiveCommand,
      exec: options.exec,
      title: options.title?.trim() || options.command,
      workdir: options.workdir,
      env: options.envOverrides ?? {},
      sandboxed: options.sandboxed,
      notify: options.notify ?? 'ui',
      timeoutMs: options.timeoutMs,
      parentSessionId: options.parentSessionId,
      rootRunId: options.rootRunId,
      parentRunId: options.parentRunId,
      token,
      tokenHash,
      recordPath,
      controlPath,
      outputPath,
      maxLogBytes: MAX_BACKGROUND_BUFFER,
    };
    writeJsonAtomic(specPath, spec);
    const invocation = this.runnerInvocation();
    let runnerError = '';
    const runner = spawn(process.execPath, [...invocation, specPath], {
      cwd: options.workdir,
      env: process.env,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    runner.stderr?.on('data', (data) => {
      runnerError += Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    });
    runner.on('error', (error) => {
      runnerError ||= error.message;
    });
    runner.unref();
    unrefStream(runner.stderr);
    const shell: BackgroundShellRecord = {
      id,
      command: options.command,
      effectiveCommand: options.effectiveCommand,
      title: spec.title,
      workdir: options.workdir,
      runnerPid: runner.pid,
      status: 'starting',
      lifetime: 'persistent',
      notify: spec.notify,
      output: '',
      readOffset: 0,
      truncatedBytes: 0,
      outputRevision: 0,
      completionSequence: 0,
      completionAcknowledgedSequence: 0,
      completionDeliveredSequence: 0,
      startedAt: Date.now(),
      sandboxed: options.sandboxed,
      timeoutMs: options.timeoutMs,
      deadlineAt: options.timeoutMs ? Date.now() + options.timeoutMs : undefined,
      parentSessionId: options.parentSessionId,
      rootRunId: options.rootRunId,
      parentRunId: options.parentRunId,
      persistentRecordPath: recordPath,
      persistentControlPath: controlPath,
      persistentOutputPath: outputPath,
      controlToken: token,
    };
    this.store.shells.set(id, shell);
    const startBudgetMs = this.options.runnerStartBudgetMs ?? 3_000;
    // Monotonic: this is "wait up to three seconds", not "wait until 12:04".
    const deadline = this.clock.monotonicNowMs() + startBudgetMs;
    while (this.clock.monotonicNowMs() < deadline) {
      const state = readJsonFile<PersistentShellState>(recordPath);
      if (state) {
        this.applyPersistentState(shell, state);
        if (state.status !== 'starting') break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (shell.status === 'starting') {
      this.store.shells.delete(id);
      removePersistentJobFiles(paths, id);
      const detail = runnerError.trim();
      throw new Error(
        `Persistent background runner did not start within ${startBudgetMs}ms${detail ? `: ${detail}` : '.'}`,
      );
    }
    this.emit({ type: 'background_job_start', job: cloneRecord(shell) });
    return cloneRecord(shell);
  }

  private runnerInvocation(): string[] {
    const currentDirectory = dirname(fileURLToPath(import.meta.url));
    const built = join(currentDirectory, 'job-runner.js');
    if (existsSync(built)) return [built];
    const adjacentBuilt = join(currentDirectory, '..', 'job-runner.js');
    if (existsSync(adjacentBuilt)) return [adjacentBuilt];
    const source = join(currentDirectory, '..', 'job-runner.ts');
    const tsxLoader = createRequire(import.meta.url).resolve('tsx');
    return ['--import', pathToFileURL(tsxLoader).href, source];
  }

  private async stopPersistent(
    shell: BackgroundShellRecord,
    reason: 'killed' | 'timed_out',
  ): Promise<boolean> {
    if (!shell.persistentControlPath || !shell.controlToken) return false;
    shell.status = 'stopping';
    this.emit({ type: 'background_job_update', job: cloneRecord(shell) });
    writeJsonAtomic(shell.persistentControlPath, {
      token: shell.controlToken,
      action: 'stop',
      reason,
      requestedAt: Date.now(),
    });
    const deadline = this.clock.monotonicNowMs() + (this.options.runnerStopBudgetMs ?? 5_000);
    while (this.clock.monotonicNowMs() < deadline) {
      this.refreshPersistentRecord(shell);
      if (isTerminalShellStatus(shell.status)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  private refreshPersistentJobs(): void {
    for (const shell of this.store.shells.values()) {
      if (shell.lifetime === 'persistent') this.refreshPersistentRecord(shell);
    }
  }

  private refreshPersistentRecord(shell: BackgroundShellRecord): void {
    if (!shell.persistentRecordPath) return;
    const loadedState = readJsonFile<PersistentShellState>(shell.persistentRecordPath);
    if (!loadedState) return;
    const state = this.reconcilePersistentState(loadedState, shell.persistentRecordPath);
    const previousStatus = shell.status;
    const previousSequence = shell.completionSequence ?? 0;
    this.applyPersistentState(shell, state);
    if (shell.status !== previousStatus && !isTerminalShellStatus(shell.status)) {
      this.emit({ type: 'background_job_update', job: cloneRecord(shell) });
    }
    if ((shell.completionSequence ?? 0) > previousSequence && isTerminalShellStatus(shell.status)) {
      this.emit({ type: 'background_job_result', job: cloneRecord(shell) });
    }
  }

  private reconcilePersistentState(
    state: PersistentShellState,
    recordPath: string,
  ): PersistentShellState {
    // Wall clock by necessity: `heartbeatAt` was stamped by the detached runner,
    // a different process, and two processes share no monotonic origin — a
    // monotonic reading cannot cross that boundary at all.
    //
    // What makes that survivable is the third condition rather than the clock. A
    // backwards correction reads as "unexpectedly fresh" and keeps the shell; a
    // forwards one would call a live runner stale on its own, and `isProcessAlive`
    // is what stops it, because the runner's pid does not care what time it is.
    // Keep those two disjuncts together.
    if (
      isTerminalShellStatus(state.status) ||
      Date.now() - state.heartbeatAt < PERSISTENT_HEARTBEAT_STALE_MS ||
      isProcessAlive(state.runnerPid)
    ) {
      return state;
    }
    const lost: PersistentShellState = {
      ...state,
      revision: state.revision + 1,
      status: 'lost',
      stopReason: 'persistent runner heartbeat became stale',
      finishedAt: Date.now(),
      heartbeatAt: Date.now(),
      completionSequence: state.completionSequence + 1,
    };
    writeJsonAtomic(recordPath, lost);
    if (this.persistentPaths) removePersistentRunnerFiles(this.persistentPaths, state.id);
    return lost;
  }

  private applyPersistentState(shell: BackgroundShellRecord, state: PersistentShellState): void {
    const previousRotation = shell.persistentOutputRotationSequence ?? 0;
    const nextRotation = state.outputRotationSequence ?? 0;
    if (nextRotation > previousRotation) shell.readOffset = 0;
    Object.assign(shell, {
      command: state.command,
      title: state.title,
      workdir: state.workdir,
      status: state.status,
      notify: state.notify,
      sandboxed: state.sandboxed,
      runnerPid: state.runnerPid,
      pid: state.childPid,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      timeoutMs: state.timeoutMs,
      deadlineAt: state.deadlineAt,
      exitCode: state.exitCode,
      signal: state.signal,
      parentSessionId: state.parentSessionId,
      rootRunId: state.rootRunId,
      parentRunId: state.parentRunId,
      completionSequence: state.completionSequence,
      completionDeliveredSequence: state.completionDeliveredSequence,
      completionAcknowledgedSequence: state.completionAcknowledgedSequence,
      truncatedBytes: state.truncatedBytes ?? shell.truncatedBytes,
      persistentOutputPath: state.outputPath,
      persistentControlPath: state.controlPath,
      persistentOutputRotationSequence: nextRotation,
    });
  }

  private recordFromPersistentState(state: PersistentShellState): BackgroundShellRecord {
    const paths = this.persistentPaths!;
    const shell: BackgroundShellRecord = {
      id: state.id,
      command: state.command,
      effectiveCommand: state.command,
      title: state.title,
      workdir: state.workdir,
      status: state.status,
      lifetime: 'persistent',
      notify: state.notify,
      output: '',
      readOffset: 0,
      truncatedBytes: 0,
      persistentOutputRotationSequence: state.outputRotationSequence ?? 0,
      startedAt: state.startedAt,
      persistentRecordPath: join(paths.records, `${state.id}.json`),
      persistentControlPath: state.controlPath,
      persistentOutputPath: state.outputPath,
      controlToken: readJsonFile<PersistentShellSpec>(join(paths.specs, `${state.id}.json`))?.token,
    };
    this.applyPersistentState(shell, state);
    return shell;
  }

  private appendOutput(shell: BackgroundShellRecord, data: unknown): void {
    const chunk = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    if (!chunk) return;
    shell.output += chunk;
    if (shell.output.length > MAX_BACKGROUND_BUFFER) {
      const extra = shell.output.length - MAX_BACKGROUND_BUFFER;
      shell.output = shell.output.slice(extra);
      shell.truncatedBytes += extra;
      shell.readOffset = Math.max(0, shell.readOffset - extra);
    }
    shell.outputRevision = (shell.outputRevision ?? 0) + 1;
    this.emit({
      type: 'background_job_output',
      jobId: shell.id,
      revision: shell.outputRevision,
    });
  }

  private clearTimer(shell: BackgroundShellRecord): void {
    if (!shell.timer) return;
    clearTimeout(shell.timer);
    shell.timer = undefined;
  }

  private finish(
    shell: BackgroundShellRecord,
    status: BackgroundShellStatus,
    code?: number | null,
    signal?: NodeJS.Signals | string | null,
  ): void {
    if (isTerminalShellStatus(shell.status)) return;
    shell.status = status;
    shell.exitCode = code;
    shell.signal = signal;
    shell.finishedAt = Date.now();
    shell.completionSequence = (shell.completionSequence ?? 0) + 1;
    this.clearTimer(shell);
    this.scheduleRetention(shell);
    this.emit({ type: 'background_job_result', job: cloneRecord(shell) });
  }

  private async terminate(
    shell: BackgroundShellRecord,
    status: 'killed' | 'timed_out',
  ): Promise<boolean> {
    if (isTerminalShellStatus(shell.status)) return true;
    this.clearTimer(shell);
    shell.status = 'stopping';
    this.emit({ type: 'background_job_update', job: cloneRecord(shell) });
    const stopped = await terminateProcessTree(shell.process, shell.pid, (timeoutMs) =>
      waitForShellClose(shell, timeoutMs),
    );
    if (!stopped && shell.finishedAt === undefined) return false;
    this.finish(shell, status, shell.exitCode, shell.signal);
    return true;
  }

  private deleteRecord(shellId: string): void {
    const shell = this.store.shells.get(shellId);
    if (shell?.retentionTimer) clearTimeout(shell.retentionTimer);
    if (shell?.lifetime === 'persistent' && this.persistentPaths) {
      removePersistentJobFiles(this.persistentPaths, shell.id);
    }
    this.store.shells.delete(shellId);
  }

  private pruneTerminalShells(now = Date.now()): void {
    const terminal = Array.from(this.store.shells.values())
      .filter((shell) => isTerminalShellStatus(shell.status))
      .sort((left, right) => (left.finishedAt ?? 0) - (right.finishedAt ?? 0));
    for (const shell of terminal) {
      if (shell.finishedAt !== undefined && now - shell.finishedAt >= TERMINAL_SHELL_TTL_MS) {
        this.deleteRecord(shell.id);
      }
    }
    const retained = terminal.filter((shell) => this.store.shells.has(shell.id));
    for (const shell of retained.slice(0, -MAX_RETAINED_TERMINAL_SHELLS)) {
      this.deleteRecord(shell.id);
    }
  }

  private scheduleRetention(shell: BackgroundShellRecord): void {
    if (!isTerminalShellStatus(shell.status)) return;
    if (shell.retentionTimer) clearTimeout(shell.retentionTimer);
    this.pruneTerminalShells();
    if (!this.store.shells.has(shell.id)) return;
    shell.retentionTimer = setTimeout(() => this.deleteRecord(shell.id), TERMINAL_SHELL_TTL_MS);
    shell.retentionTimer.unref();
  }
}
