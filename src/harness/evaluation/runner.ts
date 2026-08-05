import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_TREE_MAX_FILES = 10_000;
const DEFAULT_TREE_MAX_BYTES = 100 * 1024 * 1024;
const FINGERPRINT_CHUNK_BYTES = 64 * 1024;
const EVALUATION_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_ENVIRONMENT_KEYS = [
  'CI',
  'COMSPEC',
  'LANG',
  'LC_ALL',
  'NUMBER_OF_PROCESSORS',
  'PATH',
  'PATHEXT',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TZ',
  'WINDIR',
] as const;
const RESERVED_ENVIRONMENT_KEYS = new Set([
  'APPDATA',
  'BOOK_EVALUATION_RUN_ID',
  'BOOK_EVALUATION_DATE',
  'BOOK_EVALUATION_FIXTURE_REVISION',
  'BOOK_EVALUATION_RANDOM_SEED',
  'BOOK_EVALUATION_RUNTIME_REVISION',
  'BOOK_HOME',
  'HOME',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
]);

export interface EvaluationWorkspace {
  readonly runId: string;
  readonly root: string;
  readonly workspace: string;
  readonly bookHome: string;
  readonly temporaryDirectory: string;
}

export interface EvaluationProcessOptions {
  command: string;
  args?: string[];
  timeoutMs: number;
  temporaryRoot?: string;
  sourceEnv?: NodeJS.ProcessEnv;
  envAllowlist?: string[];
  env?: Record<string, string>;
  maxOutputBytes?: number;
  terminationGraceMs?: number;
  evaluationDate?: string;
  randomSeed?: string;
  runtimeRevision?: string;
  retainWorkspace?: boolean;
  signal?: AbortSignal;
  prepare?: (workspace: EvaluationWorkspace) => Promise<void>;
}

export interface EvaluationProcessResult extends EvaluationWorkspace {
  status: 'completed' | 'failed' | 'timed-out' | 'cancelled' | 'spawn-failed';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  evaluationDate: string;
  randomSeed: string;
  runtimeRevision: string;
  fixtureRevision: string;
  fixtureRevisionStatus: 'captured' | 'incomplete';
  retained: boolean;
}

export interface EvaluationControls {
  evaluationDate: string;
  randomSeed: string;
  runtimeRevision: string;
  fixtureRevision: string;
  fixtureRevisionStatus: 'captured' | 'incomplete';
}

export function evaluationControlsFromResult(result: EvaluationProcessResult): EvaluationControls {
  return {
    evaluationDate: result.evaluationDate,
    randomSeed: result.randomSeed,
    runtimeRevision: result.runtimeRevision,
    fixtureRevision: result.fixtureRevision,
    fixtureRevisionStatus: result.fixtureRevisionStatus,
  };
}

interface BoundedOutput {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

function normalizedEnvironmentKey(key: string): string {
  return process.platform === 'win32' ? key.toUpperCase() : key;
}

function findEnvironmentValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const target = normalizedEnvironmentKey(key);
  for (const [candidate, value] of Object.entries(env)) {
    if (normalizedEnvironmentKey(candidate) === target) return value;
  }
  return undefined;
}

function assertEnvironmentKeyIsNotReserved(key: string): void {
  const normalized = normalizedEnvironmentKey(key);
  if (
    [...RESERVED_ENVIRONMENT_KEYS].some(
      (reserved) => normalizedEnvironmentKey(reserved) === normalized,
    )
  ) {
    throw new Error(`Evaluation runner owns environment variable ${key}.`);
  }
}

function buildEvaluationEnvironment(
  workspace: EvaluationWorkspace,
  controls: EvaluationControls,
  sourceEnv: NodeJS.ProcessEnv,
  allowlist: string[],
  explicit: Record<string, string>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [...DEFAULT_ENVIRONMENT_KEYS, ...allowlist]) {
    assertEnvironmentKeyIsNotReserved(key);
    const value = findEnvironmentValue(sourceEnv, key);
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(explicit)) {
    assertEnvironmentKeyIsNotReserved(key);
    environment[key] = value;
  }

  environment.BOOK_HOME = workspace.bookHome;
  environment.BOOK_EVALUATION_RUN_ID = workspace.runId;
  environment.BOOK_EVALUATION_DATE = controls.evaluationDate;
  environment.BOOK_EVALUATION_RANDOM_SEED = controls.randomSeed;
  environment.BOOK_EVALUATION_RUNTIME_REVISION = controls.runtimeRevision;
  environment.BOOK_EVALUATION_FIXTURE_REVISION =
    controls.fixtureRevisionStatus === 'captured' ? controls.fixtureRevision : '<incomplete>';
  environment.HOME = workspace.root;
  environment.USERPROFILE = workspace.root;
  environment.APPDATA = join(workspace.root, 'app-data');
  environment.LOCALAPPDATA = join(workspace.root, 'local-app-data');
  environment.XDG_CONFIG_HOME = join(workspace.root, 'xdg-config');
  environment.XDG_CACHE_HOME = join(workspace.root, 'xdg-cache');
  environment.TEMP = workspace.temporaryDirectory;
  environment.TMP = workspace.temporaryDirectory;
  environment.NO_COLOR = '1';
  return environment;
}

async function fingerprintEvaluationTree(root: string): Promise<{
  revision: string;
  status: 'captured' | 'incomplete';
}> {
  const hash = createHash('sha256');
  let fileCount = 0;
  let totalBytes = 0;
  let incomplete = false;

  const fingerprintFile = async (
    path: string,
    remainingBytes: number,
  ): Promise<{ bytes: number; digest: string } | undefined> => {
    let file;
    try {
      file = await open(path, 'r');
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > remainingBytes) return undefined;

      const digest = createHash('sha256');
      const buffer = Buffer.allocUnsafe(
        Math.max(1, Math.min(FINGERPRINT_CHUNK_BYTES, metadata.size)),
      );
      let offset = 0;
      while (offset < metadata.size) {
        const length = Math.min(buffer.byteLength, metadata.size - offset);
        const { bytesRead } = await file.read(buffer, 0, length, offset);
        if (bytesRead === 0) return undefined;
        digest.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      if ((await file.stat()).size !== metadata.size) return undefined;
      return { bytes: metadata.size, digest: digest.digest('hex') };
    } catch {
      return undefined;
    } finally {
      await file?.close().catch(() => undefined);
    }
  };

  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      incomplete = true;
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === '.git') continue;
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join('/');
      if (entry.isSymbolicLink()) {
        incomplete = true;
        hash.update(`symlink:${relativePath}\n`);
        continue;
      }
      if (entry.isDirectory()) {
        hash.update(`directory:${relativePath}\n`);
        await visit(path);
        continue;
      }
      if (!entry.isFile() || fileCount >= DEFAULT_TREE_MAX_FILES) {
        incomplete = true;
        continue;
      }
      const content = await fingerprintFile(path, DEFAULT_TREE_MAX_BYTES - totalBytes);
      if (!content) {
        incomplete = true;
        continue;
      }
      fileCount += 1;
      totalBytes += content.bytes;
      hash.update(`file:${relativePath}:${content.bytes}:`);
      hash.update(content.digest);
      hash.update('\n');
    }
  };

  await visit(root);
  return { revision: hash.digest('hex'), status: incomplete ? 'incomplete' : 'captured' };
}

/** Fingerprint the exact evaluator source state, including dirty and untracked files. */
export async function resolveEvaluationRuntimeRevision(
  repositoryRoot = process.cwd(),
): Promise<string> {
  const root = resolve(repositoryRoot);
  const execute = (args: string[]): Promise<string> =>
    new Promise((resolveOutput, rejectOutput) => {
      execFile(
        'git',
        args,
        {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) rejectOutput(error);
          else resolveOutput(stdout);
        },
      );
    });

  let head: string;
  try {
    head = (await execute(['rev-parse', 'HEAD'])).trim();
  } catch {
    try {
      const packageDocument = await readFile(join(root, 'package.json'));
      const lockPath = join(root, 'package-lock.json');
      const fallback = createHash('sha256').update(packageDocument);
      try {
        fallback.update(await readFile(lockPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return `package-state:${fallback.digest('hex')}`;
    } catch {
      return 'unknown';
    }
  }

  try {
    const state = createHash('sha256');
    state.update(await execute(['diff', '--binary', 'HEAD', '--']));
    const untracked = (await execute(['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0')
      .filter(Boolean)
      .sort();
    let untrackedBytes = 0;
    for (const relativePath of untracked) {
      const path = resolve(root, relativePath);
      if (!path.startsWith(`${root}${sep}`) || !(await stat(path)).isFile()) {
        throw new Error(
          `Untracked evaluator source is not a regular repository file: ${relativePath}`,
        );
      }
      const content = await readFile(path);
      untrackedBytes += content.byteLength;
      if (untrackedBytes > DEFAULT_TREE_MAX_BYTES) {
        throw new Error('Untracked evaluator source exceeds the revision fingerprint budget.');
      }
      state.update(relativePath.split(sep).join('/'));
      state.update('\0');
      state.update(content);
      state.update('\0');
    }
    return `git:${head}:state:${state.digest('hex')}`;
  } catch {
    return 'unknown';
  }
}

function appendBounded(output: BoundedOutput, chunk: Buffer, limit: number): void {
  if (output.bytes >= limit) {
    output.truncated = true;
    return;
  }
  const remaining = limit - output.bytes;
  const accepted = chunk.subarray(0, remaining);
  output.chunks.push(accepted);
  output.bytes += accepted.byteLength;
  if (accepted.byteLength < chunk.byteLength) output.truncated = true;
}

function outputText(output: BoundedOutput): string {
  return Buffer.concat(output.chunks, output.bytes).toString('utf8');
}

function waitForProcessClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveClose) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolveClose(child.exitCode !== null || child.signalCode !== null);
    }, timeoutMs);
    const onClose = () => {
      cleanup();
      resolveClose(true);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('close', onClose);
    };
    child.once('close', onClose);
  });
}

function requestWindowsTreeTermination(
  pid: number,
  force: boolean,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolveTermination) => {
    execFile(
      'taskkill',
      ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])],
      { windowsHide: true, timeout: timeoutMs },
      (error) => resolveTermination(!error),
    );
  });
}

function requestPosixTreeTermination(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through when the process never became a group leader or already exited.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Teardown is best effort after a concurrent process exit.
  }
}

async function terminateProcessTree(child: ChildProcess, graceMs: number): Promise<void> {
  if (process.platform === 'win32') {
    if (child.pid !== undefined) {
      await requestWindowsTreeTermination(child.pid, false, graceMs);
    } else {
      try {
        child.kill('SIGTERM');
      } catch {
        return;
      }
    }
    await waitForProcessClose(child, graceMs);
    if (child.pid !== undefined) {
      await requestWindowsTreeTermination(child.pid, true, graceMs);
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // taskkill may already have removed the direct child and descendants.
    }
    await waitForProcessClose(child, graceMs);
    return;
  }

  requestPosixTreeTermination(child, 'SIGTERM');
  await waitForProcessClose(child, graceMs);
  requestPosixTreeTermination(child, 'SIGKILL');
  await waitForProcessClose(child, graceMs);
}

async function createEvaluationWorkspace(temporaryRoot = tmpdir()): Promise<EvaluationWorkspace> {
  const root = await mkdtemp(join(resolve(temporaryRoot), 'book-harness-eval-'));
  const workspace = join(root, 'workspace');
  const bookHome = join(root, 'book-home');
  const temporaryDirectory = join(root, 'tmp');
  await Promise.all([
    mkdir(workspace),
    mkdir(bookHome),
    mkdir(temporaryDirectory),
    mkdir(join(root, 'app-data')),
    mkdir(join(root, 'local-app-data')),
    mkdir(join(root, 'xdg-config')),
    mkdir(join(root, 'xdg-cache')),
  ]);
  return {
    runId: randomUUID(),
    root,
    workspace,
    bookHome,
    temporaryDirectory,
  };
}

/**
 * Run a trusted built-in evaluation command in a fresh process with isolated user-state paths.
 * This is a reproducibility boundary, not a security sandbox for project-controlled commands.
 */
export async function runEvaluationProcess(
  options: EvaluationProcessOptions,
): Promise<EvaluationProcessResult> {
  if (!options.command.trim()) throw new Error('Evaluation command must not be empty.');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('Evaluation timeout must be a positive finite number.');
  }
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 0) {
    throw new Error('Evaluation output limit must be a non-negative integer.');
  }
  const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  if (!Number.isFinite(terminationGraceMs) || terminationGraceMs <= 0) {
    throw new Error('Evaluation termination grace period must be a positive finite number.');
  }
  const evaluationDate = options.evaluationDate ?? new Date().toISOString().split('T')[0];
  if (!EVALUATION_DATE_PATTERN.test(evaluationDate)) {
    throw new Error('Evaluation date must use YYYY-MM-DD.');
  }
  const randomSeed = options.randomSeed?.trim() || randomUUID();
  const runtimeRevision =
    options.runtimeRevision?.trim() || (await resolveEvaluationRuntimeRevision());

  const workspace = await createEvaluationWorkspace(options.temporaryRoot);
  let retainCompletedWorkspace = false;
  try {
    await options.prepare?.(workspace);
    const fixture = await fingerprintEvaluationTree(workspace.workspace);
    const controls: EvaluationControls = {
      evaluationDate,
      randomSeed,
      runtimeRevision,
      fixtureRevision: fixture.revision,
      fixtureRevisionStatus: fixture.status,
    };
    const environment = buildEvaluationEnvironment(
      workspace,
      controls,
      options.sourceEnv ?? process.env,
      options.envAllowlist ?? [],
      options.env ?? {},
    );
    const stdout: BoundedOutput = { chunks: [], bytes: 0, truncated: false };
    const stderr: BoundedOutput = { chunks: [], bytes: 0, truncated: false };

    const result = await new Promise<EvaluationProcessResult>((resolveResult) => {
      let terminalStatus: EvaluationProcessResult['status'] | undefined;
      let spawnError: Error | undefined;
      const child = spawn(options.command, options.args ?? [], {
        cwd: workspace.workspace,
        env: environment,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      child.stdout.on('data', (chunk: Buffer) => appendBounded(stdout, chunk, maxOutputBytes));
      child.stderr.on('data', (chunk: Buffer) => appendBounded(stderr, chunk, maxOutputBytes));

      let settled = false;
      const abort = () => stop('cancelled');
      const finalize = (status: EvaluationProcessResult['status']) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abort);
        if (status === 'timed-out' || status === 'cancelled') {
          child.stdout.destroy();
          child.stderr.destroy();
        }
        const spawnMessage = spawnError ? `${spawnError.message}\n` : '';
        resolveResult({
          ...workspace,
          status,
          exitCode: child.exitCode,
          signal: child.signalCode,
          stdout: outputText(stdout),
          stderr: `${spawnMessage}${outputText(stderr)}`,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          ...controls,
          retained: options.retainWorkspace === true,
        });
      };
      const stop = (status: 'timed-out' | 'cancelled') => {
        if (terminalStatus) return;
        terminalStatus = status;
        void terminateProcessTree(child, terminationGraceMs).finally(() => finalize(status));
      };
      const timeout = setTimeout(() => stop('timed-out'), options.timeoutMs);
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });

      child.once('error', (error) => {
        spawnError = error;
        if (!terminalStatus) terminalStatus = 'spawn-failed';
        finalize(terminalStatus);
      });
      child.once('close', (exitCode, _signal) => {
        if (terminalStatus === 'timed-out' || terminalStatus === 'cancelled') return;
        finalize(terminalStatus ?? (exitCode === 0 ? 'completed' : 'failed'));
      });
    });
    retainCompletedWorkspace = options.retainWorkspace === true;
    return result;
  } finally {
    if (!retainCompletedWorkspace) await rm(workspace.root, { recursive: true, force: true });
  }
}
