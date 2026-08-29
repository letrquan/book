import { existsSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Admission control for managed-agent worktrees.
 *
 * A wide fan-out on a large repository is the one failure that takes the whole
 * run down rather than one agent: worktrees share the filesystem with the root
 * agent, so a full disk breaks its own `Edit` and `Bash` too. Nothing reclaimed
 * them automatically — `AgentManager.dismiss` has exactly one caller, a TUI
 * keypress, so print mode, the SDK, and any supervised runner reclaim nothing
 * ever, and the store's retention sweep runs once at startup with a 30-day
 * default that cannot fire inside a week-long run.
 *
 * This refuses a spawn *before* it consumes the last of the disk, with a typed
 * reason a host can escalate, which is strictly better than discovering the
 * problem when an unrelated write fails.
 *
 * Deliberately not measuring per-worktree bytes: that is an O(files) walk of a
 * checkout on every spawn, and the number it produces is stale the moment a build
 * writes. Free space is the quantity that actually matters and it is one syscall.
 */

export type WorktreeCapacityRefusal =
  | { ok: false; reason: 'worktree_limit'; message: string; active: number; limit: number }
  | { ok: false; reason: 'disk_space'; message: string; freeBytes: number; requiredBytes: number };

export type WorktreeCapacity = { ok: true; active: number; freeBytes: number } | WorktreeCapacityRefusal;

export interface WorktreeCapacityOptions {
  worktreeRoot: string;
  repoHash: string;
  /** Maximum simultaneous worktrees for this repository; 0 disables the check. */
  maxWorktrees: number;
  /** Refuse a spawn when free disk would fall below this; 0 disables the check. */
  minFreeDiskBytes: number;
}

function countWorktrees(worktreeRoot: string, repoHash: string): number {
  const dir = join(worktreeRoot, repoHash);
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  } catch {
    // An unreadable worktree root is not a reason to refuse work; the spawn will
    // fail on its own with a clearer error if the directory is genuinely broken.
    return 0;
  }
}

/**
 * Free bytes on the volume holding `path`, or undefined when it cannot be read.
 *
 * Undefined means "do not enforce": refusing every spawn because a platform did
 * not answer would be a worse failure than the one this guards against.
 */
export function freeDiskBytes(path: string): number | undefined {
  try {
    const stats = statfsSync(path);
    return stats.bavail * stats.bsize;
  } catch {
    return undefined;
  }
}

export function checkWorktreeCapacity(options: WorktreeCapacityOptions): WorktreeCapacity {
  const active = countWorktrees(options.worktreeRoot, options.repoHash);
  if (options.maxWorktrees > 0 && active >= options.maxWorktrees) {
    return {
      ok: false,
      reason: 'worktree_limit',
      active,
      limit: options.maxWorktrees,
      message: `${active} agent worktrees already exist for this repository (limit ${options.maxWorktrees}). Finish or dismiss an agent, or raise agents.maxWorktrees.`,
    };
  }

  const free = freeDiskBytes(options.worktreeRoot);
  if (options.minFreeDiskBytes > 0 && free !== undefined && free < options.minFreeDiskBytes) {
    return {
      ok: false,
      reason: 'disk_space',
      freeBytes: free,
      requiredBytes: options.minFreeDiskBytes,
      message: `Only ${formatBytes(free)} free where agent worktrees live; ${formatBytes(options.minFreeDiskBytes)} is required. A worktree shares the filesystem with the workspace, so continuing risks failing the root agent's own writes.`,
    };
  }

  return { ok: true, active, freeBytes: free ?? Number.POSITIVE_INFINITY };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
