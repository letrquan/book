/**
 * Whether a live-session record still describes a running process.
 *
 * A pid alone is not enough: pids are reused, and a record left by a session that crashed can
 * name a pid some unrelated process holds now. So a record also carries the process start token,
 * and is live only while the pid is alive *and* the token still matches. A pid is also only
 * meaningful inside its own pid namespace, which `pidDomain` names, so a container sharing the
 * home directory never judges (or sweeps) the host's records.
 *
 * Everything here is asynchronous: the reads run while the TUI is drawing.
 */

import { execFile } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import { buildChildEnv } from '../child-env.js';
import { isProcessAlive } from '../jobs/process-tree.js';

/** How long `ps` may take on macOS before the token counts as unreadable. */
const PS_TIMEOUT_MS = 2_000;

/**
 * The start time from one `/proc/<pid>/stat` line: field 22, in clock ticks since boot.
 *
 * Field 2 is the command name in parentheses, and the name is the process's own to choose — it
 * can hold spaces and `) (` — so the fields are counted from the *last* `)`. What follows it starts
 * at field 3, which makes field 22 the 20th entry.
 */
export function parseProcStatStartTime(stat: string): string | undefined {
  const close = stat.lastIndexOf(')');
  if (close < 0) return undefined;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const value = fields[22 - 3];
  return value !== undefined && /^\d+$/.test(value) ? value : undefined;
}

/** The OS facts the registry judges a record by. Injected so tests can stage pid reuse. */
export interface LivenessProbe {
  isAlive(pid: number): boolean;
  /** The process start token, or undefined when the platform has none or it cannot be read. */
  startToken(pid: number): Promise<string | undefined>;
  /** This process's pid domain; undefined where the platform has no namespaces to tell apart. */
  pidDomain(): Promise<string | undefined>;
}

async function readTrimmed(path: string): Promise<string | undefined> {
  try {
    const value = (await readFile(path, 'utf8')).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function linuxStartToken(pid: number): Promise<string | undefined> {
  const stat = await readTrimmed(`/proc/${pid}/stat`);
  return stat === undefined ? undefined : parseProcStatStartTime(stat);
}

/** `ps -o lstart=` prints the start time to the second; `LC_ALL=C` keeps its format fixed. */
function darwinStartToken(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      '/bin/ps',
      ['-o', 'lstart=', '-p', String(pid)],
      {
        env: buildChildEnv(process.env, { LC_ALL: 'C' }),
        timeout: PS_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        const token = String(stdout).trim();
        resolve(error || !token ? undefined : token);
      },
    );
  });
}

/**
 * `linux:<machine id>:pid:[<pid namespace inode>]`, the shape Claude Code uses. The machine id
 * falls back to the boot id, which every Linux kernel has; `readlink /proc/self/ns/pid` already
 * reads `pid:[<inode>]`.
 */
async function linuxPidDomain(): Promise<string | undefined> {
  const machine =
    (await readTrimmed('/etc/machine-id')) ??
    (await readTrimmed('/var/lib/dbus/machine-id')) ??
    (await readTrimmed('/proc/sys/kernel/random/boot_id'));
  let namespace: string | undefined;
  try {
    namespace = await readlink('/proc/self/ns/pid');
  } catch {
    namespace = undefined;
  }
  if (!machine || !namespace || !/^pid:\[\d+\]$/.test(namespace)) return undefined;
  return `linux:${machine}:${namespace}`;
}

/**
 * The probe for this platform. Linux reads `/proc`; macOS asks `ps`; Windows has neither, so a
 * record there is live while its pid is (D6). The pid domain is read once per probe: it is fixed
 * for the life of the process.
 */
export function createLivenessProbe(platform: NodeJS.Platform = process.platform): LivenessProbe {
  let domain: Promise<string | undefined> | undefined;
  return {
    isAlive: (pid) => isProcessAlive(pid),
    startToken: (pid) =>
      platform === 'linux'
        ? linuxStartToken(pid)
        : platform === 'darwin'
          ? darwinStartToken(pid)
          : Promise.resolve(undefined),
    pidDomain: () => {
      domain ??= platform === 'linux' ? linuxPidDomain() : Promise.resolve(undefined);
      return domain;
    },
  };
}

/**
 * Whether a record from this pid domain still describes a running process: the pid is alive, and
 * the start token matches when both sides have one. A token that cannot be read now (the process
 * may be exiting) proves nothing either way, so the pid decides.
 */
export async function isRecordProcessLive(
  record: { pid: number; procStart?: string },
  probe: LivenessProbe,
): Promise<boolean> {
  if (!probe.isAlive(record.pid)) return false;
  if (record.procStart === undefined) return true;
  const token = await probe.startToken(record.pid);
  if (token === undefined) return probe.isAlive(record.pid);
  return token === record.procStart;
}
