import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { repositoryHash } from '../agents/git-isolation.js';
import { systemClock, type Clock } from '../clock.js';
import type {
  BackgroundShellNotify,
  BackgroundShellStatus,
  CommandExecution,
} from '../types/runtime.js';
import { resolveBookHome } from '../book-home.js';

export interface PersistentShellSpec {
  version: 1;
  id: string;
  command: string;
  effectiveCommand: string;
  /**
   * Present only for sandboxed commands. Specs written before this field
   * existed simply lack it and fall back to the shell path, which is what they
   * were already doing.
   */
  exec?: CommandExecution;
  title: string;
  workdir: string;
  env: Record<string, string>;
  sandboxed: boolean;
  notify: BackgroundShellNotify;
  timeoutMs?: number;
  parentSessionId?: string;
  rootRunId?: string;
  parentRunId?: string;
  token: string;
  tokenHash: string;
  recordPath: string;
  controlPath: string;
  outputPath: string;
  maxLogBytes: number;
}

export interface PersistentShellState {
  version: 1;
  revision: number;
  id: string;
  command: string;
  title: string;
  workdir: string;
  status: BackgroundShellStatus;
  notify: BackgroundShellNotify;
  sandboxed: boolean;
  runnerPid: number;
  childPid?: number;
  tokenHash: string;
  startedAt: number;
  finishedAt?: number;
  heartbeatAt: number;
  /** Incremented whenever the bounded log is rewritten to its tail. */
  outputRotationSequence?: number;
  truncatedBytes?: number;
  timeoutMs?: number;
  deadlineAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  stopReason?: string;
  parentSessionId?: string;
  rootRunId?: string;
  parentRunId?: string;
  outputPath: string;
  controlPath: string;
  completionSequence: number;
  completionDeliveredSequence: number;
  completionAcknowledgedSequence: number;
}

export interface PersistentJobPaths {
  root: string;
  records: string;
  controls: string;
  logs: string;
  specs: string;
}

export function persistentJobPaths(
  workspace: string,
  root = join(resolveBookHome(), 'jobs'),
): PersistentJobPaths {
  const repositoryRoot = join(root, repositoryHash(workspace));
  return {
    root: repositoryRoot,
    records: join(repositoryRoot, 'records'),
    controls: join(repositoryRoot, 'controls'),
    logs: join(repositoryRoot, 'logs'),
    specs: join(repositoryRoot, 'specs'),
  };
}

export function ensurePersistentJobPaths(paths: PersistentJobPaths): void {
  for (const path of [paths.root, paths.records, paths.controls, paths.logs, paths.specs]) {
    mkdirSync(path, { recursive: true });
  }
}

/**
 * Windows fails a rename over a file that another process has open, even only for reading, with
 * EPERM, EACCES or EBUSY. Here that is routine rather than rare: the shell manager polls a job
 * record while the detached runner rewrites it, and scanners open freshly written files. A POSIX
 * rename never fails this way, so only win32 retries, and only for these codes.
 */
const RENAME_CONTENTION_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_STEP_MS = 10;

/**
 * How long a contended rename may block before it rethrows, unless the caller asks for longer.
 * The shell manager and memory extraction write from the TUI's own process, where a synchronous
 * wait freezes rendering, so the default is small. The detached runner has no UI and asks for
 * more.
 */
export const DEFAULT_RENAME_RETRY_BUDGET_MS = 100;

export interface RenameRetryOptions {
  budgetMs?: number;
  platform?: NodeJS.Platform;
  clock?: Clock;
  rename?: (from: string, to: string) => void;
  sleep?: (milliseconds: number) => void;
}

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** `renameSync`, retried while Windows reports the target as in use, for at most `budgetMs`. */
export function renameWithContentionRetry(
  from: string,
  to: string,
  options: RenameRetryOptions = {},
): void {
  const rename = options.rename ?? renameSync;
  const platform = options.platform ?? process.platform;
  const clock = options.clock ?? systemClock;
  const sleep = options.sleep ?? sleepSync;
  const deadline = clock.monotonicNowMs() + (options.budgetMs ?? DEFAULT_RENAME_RETRY_BUDGET_MS);
  for (;;) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      const remainingMs = deadline - clock.monotonicNowMs();
      if (platform !== 'win32' || !RENAME_CONTENTION_CODES.has(code) || remainingMs <= 0) {
        throw error;
      }
      sleep(Math.min(RENAME_RETRY_STEP_MS, remainingMs));
    }
  }
}

export interface WriteJsonAtomicOptions {
  /** How long a contended rename may block; see `DEFAULT_RENAME_RETRY_BUDGET_MS`. */
  renameRetryBudgetMs?: number;
}

export function writeJsonAtomic(
  path: string,
  value: unknown,
  options: WriteJsonAtomicOptions = {},
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    renameWithContentionRetry(temporary, path, { budgetMs: options.renameRetryBudgetMs });
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The rename's error is the one to report; a stray temp file is harmless.
    }
    throw error;
  }
}

export function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function listPersistentStates(paths: PersistentJobPaths): PersistentShellState[] {
  if (!existsSync(paths.records)) return [];
  return readdirSync(paths.records)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJsonFile<PersistentShellState>(join(paths.records, name)))
    .filter((state): state is PersistentShellState => state?.version === 1);
}

export function removePersistentJobFiles(paths: PersistentJobPaths, id: string): void {
  for (const path of [
    join(paths.records, `${id}.json`),
    join(paths.controls, `${id}.json`),
    join(paths.logs, `${id}.log`),
    join(paths.specs, `${id}.json`),
  ]) {
    rmSync(path, { force: true });
  }
}

export function removePersistentRunnerFiles(paths: PersistentJobPaths, id: string): void {
  for (const path of [join(paths.controls, `${id}.json`), join(paths.specs, `${id}.json`)]) {
    rmSync(path, { force: true });
  }
}
