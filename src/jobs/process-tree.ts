/**
 * Process-liveness helpers shared by the shell manager and the detached job runner.
 *
 * A POSIX process group outlives its leader. Background commands run through `sh -c`, and the
 * shell forks the real worker instead of exec'ing it whenever it cannot hand its own process
 * over, so the direct child can exit — for instance by taking the SIGTERM a worker ignores —
 * while that worker keeps running in the same group. Termination therefore has to be judged on
 * group membership; the direct child's own exit proves nothing about the tree behind it.
 */

const GROUP_POLL_INTERVAL_MS = 25;

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
export async function waitForProcessGroupExit(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessGroupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_INTERVAL_MS));
  }
  return true;
}
