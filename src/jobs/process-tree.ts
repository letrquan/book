/**
 * Process-liveness helpers shared by the shell manager and the detached job runner.
 *
 * A POSIX process group outlives its leader. Background commands run through `sh -c`, and the
 * shell forks the real worker instead of exec'ing it whenever it cannot hand its own process
 * over, so the direct child can exit — for instance by taking the SIGTERM a worker ignores —
 * while that worker keeps running in the same group. Termination therefore has to be judged on
 * group membership; the direct child's own exit proves nothing about the tree behind it.
 */

import { execFile, type ChildProcess } from 'node:child_process';
import { systemClock, type Clock } from '../clock.js';
import { system32Executable } from '../system32.js';

const GROUP_POLL_INTERVAL_MS = 25;
const TERMINATE_GRACE_MS = 1_500;

/** A signal target exists when it accepts signal 0, or rejects it as another user's. */
function signalTargetExists(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function isProcessAlive(pid: number | undefined): boolean {
  return pid === undefined ? false : signalTargetExists(pid);
}

/** True while any process remains in the group, whether or not the leader is one of them. */
export function isProcessGroupAlive(pgid: number | undefined): boolean {
  if (pgid === undefined || process.platform === 'win32') return false;
  return signalTargetExists(-pgid);
}

/** Signal every process in the group, falling back to the direct child when it has no group. */
export function signalProcessGroup(
  proc: { kill(signal: NodeJS.Signals): boolean } | undefined,
  pgid: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    try {
      proc?.kill(signal);
    } catch {
      // The tree may have exited between the group signal and the direct-child fallback.
    }
  }
}

/**
 * Resolve `true` once the group holds no processes, or `false` when the bound elapses first.
 *
 * `kill(-pgid, 0)` also succeeds for a member that has exited but has not been reaped yet, so a
 * group reads as alive until its reaper runs. That bound is deliberate: a zombie holds no ports,
 * file handles, or CPU, and reporting "not stopped" for the moments before it is reaped is
 * honest, where trusting the direct child's exit is not.
 */
export async function waitForProcessGroupExit(
  pgid: number,
  timeoutMs: number,
  // A kill bound is a duration: on the wall clock, a backwards step here waits
  // past the bound and a forwards one abandons a group that was about to exit.
  clock: Clock = systemClock,
): Promise<boolean> {
  const deadline = clock.monotonicNowMs() + timeoutMs;
  while (isProcessGroupAlive(pgid)) {
    if (clock.monotonicNowMs() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_INTERVAL_MS));
  }
  return true;
}

export function waitForProcessClose(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
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
export async function terminateProcessTree(
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
