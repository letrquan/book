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
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { repositoryHash } from '../agents/git-isolation.js';
import type { BackgroundShellNotify, BackgroundShellStatus } from '../types/runtime.js';

export interface PersistentShellSpec {
  version: 1;
  id: string;
  command: string;
  effectiveCommand: string;
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
  root = join(homedir(), '.book', 'jobs'),
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

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
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
