import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import {
  readJsonFile,
  writeJsonAtomic,
  type PersistentShellSpec,
  type PersistentShellState,
} from './jobs/persistent-store.js';
import { signalProcessGroup, waitForProcessGroupExit } from './jobs/process-tree.js';
import { system32Executable } from './system32.js';

const specPath = process.argv[2];
if (!specPath) {
  process.exitCode = 2;
  throw new Error('Missing persistent shell specification path.');
}
const loadedSpec = readJsonFile<PersistentShellSpec>(specPath);
if (
  !loadedSpec ||
  loadedSpec.version !== 1 ||
  createHash('sha256').update(loadedSpec.token).digest('hex') !== loadedSpec.tokenHash
) {
  process.exitCode = 2;
  throw new Error('Invalid persistent shell specification.');
}
// `effectiveCommand` is the raw user command now that sandboxing rides on
// `exec`, so a spec claiming `sandboxed` without one would run completely
// unconfined while the job panel and the [sandboxed] marker said otherwise.
// Refuse to start rather than silently downgrade.
if (loadedSpec.sandboxed !== Boolean(loadedSpec.exec)) {
  process.exitCode = 2;
  throw new Error(
    'Invalid persistent shell specification: sandboxed does not match the presence of a sandboxed argv.',
  );
}
const spec: PersistentShellSpec = loadedSpec;
const TERMINATE_GRACE_MS = 1_500;

let child: ChildProcess | undefined;
let terminal = false;
let terminationInFlight = false;
// These timers are assigned after the child is wired so startup failures can still call finish().
// eslint-disable-next-line prefer-const
let heartbeat: NodeJS.Timeout | undefined;
// eslint-disable-next-line prefer-const
let controlPoll: NodeJS.Timeout | undefined;
// eslint-disable-next-line prefer-const
let deadline: NodeJS.Timeout | undefined;
const startedAt = Date.now();
let state: PersistentShellState = {
  version: 1,
  revision: 1,
  id: spec.id,
  command: spec.command,
  title: spec.title,
  workdir: spec.workdir,
  status: 'running',
  notify: spec.notify,
  sandboxed: spec.sandboxed,
  runnerPid: process.pid,
  tokenHash: spec.tokenHash,
  startedAt,
  heartbeatAt: startedAt,
  outputRotationSequence: 0,
  truncatedBytes: 0,
  timeoutMs: spec.timeoutMs,
  deadlineAt: spec.timeoutMs ? startedAt + spec.timeoutMs : undefined,
  parentSessionId: spec.parentSessionId,
  rootRunId: spec.rootRunId,
  parentRunId: spec.parentRunId,
  outputPath: spec.outputPath,
  controlPath: spec.controlPath,
  completionSequence: 0,
  completionDeliveredSequence: 0,
  completionAcknowledgedSequence: 0,
};

function persist(): void {
  state = { ...state, revision: state.revision + 1, heartbeatAt: Date.now() };
  writeJsonAtomic(spec.recordPath, state);
}

function appendBounded(data: unknown): void {
  const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  if (chunk.length === 0) return;
  appendFileSync(spec.outputPath, chunk);
  try {
    const size = statSync(spec.outputPath).size;
    if (size <= spec.maxLogBytes) return;
    const retained = readFileSync(spec.outputPath).subarray(-spec.maxLogBytes);
    const discarded = size - retained.length;
    truncateSync(spec.outputPath, 0);
    writeFileSync(spec.outputPath, retained);
    state = {
      ...state,
      outputRotationSequence: (state.outputRotationSequence ?? 0) + 1,
      truncatedBytes: (state.truncatedBytes ?? 0) + discarded,
    };
    persist();
  } catch {
    // Output retention is best effort; lifecycle state remains authoritative.
  }
}

function waitForChildClose(timeoutMs: number): Promise<boolean> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  const proc = child;
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

async function terminateTree(): Promise<boolean> {
  if (!child?.pid) return true;
  const pid = child.pid;
  if (process.platform !== 'win32') {
    // The direct child is the `sh -c` wrapper, which dies from SIGTERM even when the worker it
    // forked ignores it. Escalate on whether the group still holds processes, never on the
    // wrapper's own exit, or the surviving worker is recorded as killed while it keeps running.
    signalProcessGroup(child, pid, 'SIGTERM');
    if (await waitForProcessGroupExit(pid, TERMINATE_GRACE_MS)) return true;
    signalProcessGroup(child, pid, 'SIGKILL');
    return waitForProcessGroupExit(pid, TERMINATE_GRACE_MS);
  }
  // `taskkill /T /F` covers the tree, so the direct child's close speaks for the tree only when
  // taskkill actually ran.
  const alreadyExited = child.exitCode !== null || child.signalCode !== null;
  if (alreadyExited) return true;
  const confirmed = await new Promise<boolean>((resolve) => {
    execFile(
      system32Executable('taskkill'),
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: TERMINATE_GRACE_MS },
      (error) => resolve(!error),
    );
  });
  if (!confirmed) {
    try {
      child.kill('SIGTERM');
    } catch {
      // The process may have exited between taskkill and the fallback.
    }
  }
  if (await waitForChildClose(TERMINATE_GRACE_MS)) return confirmed;
  try {
    child.kill('SIGKILL');
  } catch {
    return false;
  }
  return (await waitForChildClose(TERMINATE_GRACE_MS)) && confirmed;
}

function finish(
  status: 'exited' | 'failed' | 'killed' | 'timed_out',
  code?: number | null,
  signal?: NodeJS.Signals | string | null,
  stopReason?: string,
): void {
  if (terminal) return;
  terminal = true;
  // Stop capturing output at terminality: once the record reads terminal, the
  // manager may dismiss the job and delete its files, so a straggling stream
  // chunk must not re-create the log after that point.
  child?.stdout?.off('data', appendBounded);
  child?.stderr?.off('data', appendBounded);
  state = {
    ...state,
    status,
    exitCode: code,
    signal,
    stopReason,
    finishedAt: Date.now(),
    completionSequence: state.completionSequence + 1,
  };
  // Remove the runner-owned control/spec files BEFORE persisting the terminal
  // record. The manager treats an observable terminal record as "stop
  // complete" and immediately expects these files to be gone, so the removals
  // must happen-before the rename that publishes the terminal state — the old
  // order left a window where a preempted runner had published "killed" while
  // the spec file still existed.
  try {
    rmSync(spec.controlPath, { force: true });
    rmSync(specPath, { force: true });
  } catch {
    // Best effort: a leaked control/spec file is cleaned up by the manager's
    // lost-job reconciliation or dismissal, whereas skipping the terminal
    // persist below would strand the job as "stopping" forever.
  }
  persist();
  if (heartbeat) clearInterval(heartbeat);
  if (controlPoll) clearInterval(controlPoll);
  if (deadline) clearTimeout(deadline);
  setTimeout(() => process.exit(0), 10).unref();
}

writeFileSync(spec.outputPath, '', { encoding: 'utf8', mode: 0o600 });
try {
  const spawnBase: SpawnOptions = {
    cwd: spec.workdir,
    env: { ...process.env, ...spec.env },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  // Sandboxed specs carry an argv; only unsandboxed ones go through a shell.
  child = spec.exec
    ? spawn(spec.exec.file, spec.exec.args, { ...spawnBase, shell: false })
    : spawn(spec.effectiveCommand, { ...spawnBase, shell: true });
  state = { ...state, childPid: child.pid };
  persist();
} catch (error) {
  appendBounded(error instanceof Error ? `${error.message}\n` : `${String(error)}\n`);
  finish('failed');
  process.exit(1);
}

child?.stdout?.on('data', appendBounded);
child?.stderr?.on('data', appendBounded);
child?.on('error', (error) => {
  appendBounded(`${error.message}\n`);
  if (state.status !== 'stopping') finish('failed');
});
child?.on('close', (code, signal) => {
  if (terminal || state.status === 'stopping') return;
  finish(code === 0 ? 'exited' : 'failed', code, signal);
});

heartbeat = setInterval(persist, 1_000);
async function requestTermination(status: 'killed' | 'timed_out', reason: string): Promise<void> {
  if (terminal || terminationInFlight) return;
  terminationInFlight = true;
  state = { ...state, status: 'stopping', stopReason: reason };
  persist();
  try {
    if (await terminateTree()) {
      finish(status, child?.exitCode, child?.signalCode, reason);
    } else {
      appendBounded('[termination requested; process is still running; retrying]\n');
      const retry = setTimeout(() => void requestTermination(status, reason), 500);
      retry.unref();
    }
  } finally {
    terminationInFlight = false;
  }
}

controlPoll = setInterval(() => {
  if (!existsSync(spec.controlPath) || terminal) return;
  const control = readJsonFile<{ token?: string; action?: string; reason?: string }>(
    spec.controlPath,
  );
  if (control?.token !== spec.token || control.action !== 'stop') return;
  void requestTermination('killed', control.reason ?? 'requested');
}, 250);
deadline = spec.timeoutMs
  ? setTimeout(() => {
      void requestTermination('timed_out', 'timeout');
    }, spec.timeoutMs)
  : undefined;

persist();
