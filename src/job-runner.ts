import { spawn, type ChildProcess } from 'node:child_process';
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
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readJsonFile,
  writeJsonAtomic,
  type PersistentShellSpec,
  type PersistentShellState,
} from './jobs/persistent-store.js';
import { terminateProcessTree, waitForProcessClose } from './jobs/process-tree.js';
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
// Refuse to start rather than silently downgrade. The reverse is legitimate:
// an unsandboxed command also carries an `exec` when the session shell is
// spawned as argv (Git Bash or PowerShell on Windows).
if (loadedSpec.sandboxed && !loadedSpec.exec) {
  process.exitCode = 2;
  throw new Error(
    'Invalid persistent shell specification: sandboxed is set but no sandboxed argv is present.',
  );
}
const spec: PersistentShellSpec = loadedSpec;
/**
 * How long a contended record write may block before it counts as failed. The first record and
 * the terminal record wait up to a second for Windows to release the file: the job cannot start
 * without the first, and the manager waits on the second to call a stop complete. Every other
 * write (the heartbeat, the child pid, `stopping`, a log rotation) is repeated by the next
 * heartbeat, so it gives up almost at once instead of stalling the runner's timers.
 */
const RECORD_RENAME_RETRY_BUDGET_MS = 1_000;
const BEST_EFFORT_RENAME_RETRY_BUDGET_MS = 50;
/** A terminal record that still failed to write is retried on a timer this often, this many times. */
const TERMINAL_RECORD_RETRY_MS = 250;
const TERMINAL_RECORD_ATTEMPTS = 20;

let child: ChildProcess | undefined;
let terminal = false;
let terminationInFlight = false;
// These timers are assigned after the child is wired so startup failures can still call finish().
let heartbeat: NodeJS.Timeout | undefined;
let controlPoll: NodeJS.Timeout | undefined;
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

function persist(budgetMs = RECORD_RENAME_RETRY_BUDGET_MS): void {
  state = { ...state, revision: state.revision + 1, heartbeatAt: Date.now() };
  writeJsonAtomic(spec.recordPath, state, { renameRetryBudgetMs: budgetMs });
}

/**
 * A non-terminal write: the child's pid, the heartbeat, the switch to `stopping`, a log
 * rotation. One that fails must not end the runner, or its job would keep running with nothing
 * left to stop it; the next heartbeat writes the same state again. The failure is counted on the
 * record, which that next write carries, rather than noted in the job's log: the log is the
 * command's own output, and the model reads it through BashOutput.
 */
function persistBestEffort(what: string): void {
  try {
    persist(BEST_EFFORT_RENAME_RETRY_BUDGET_MS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code ?? 'unknown error';
    state = {
      ...state,
      recordWriteFailures: (state.recordWriteFailures ?? 0) + 1,
      lastRecordWriteError: `${what} write failed (${code})`,
    };
  }
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
    persistBestEffort('log rotation');
  } catch {
    // Output retention is best effort; lifecycle state remains authoritative.
  }
}

function terminateTree(): Promise<boolean> {
  const proc = child;
  if (!proc) return Promise.resolve(true);
  return terminateProcessTree(proc, proc.pid, (timeoutMs) => waitForProcessClose(proc, timeoutMs));
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
  if (heartbeat) clearInterval(heartbeat);
  if (controlPoll) clearInterval(controlPoll);
  if (deadline) clearTimeout(deadline);
  publishTerminalRecord(1);
}

/**
 * Write the terminal record, then exit. It is the one write the manager waits on to call a stop
 * complete, so a write that fails even after the retry budget is tried again on a timer rather
 * than ending the runner with its job still recorded as running. If every attempt fails, the
 * runner says at the end of the job's log what really happened, exits nonzero, and the manager's
 * heartbeat-staleness check reports the job lost.
 */
function publishTerminalRecord(attempt: number): void {
  try {
    persist();
  } catch (error) {
    if (attempt < TERMINAL_RECORD_ATTEMPTS) {
      setTimeout(() => publishTerminalRecord(attempt + 1), TERMINAL_RECORD_RETRY_MS);
      return;
    }
    reportUnrecordedEnd(error);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 10).unref();
    return;
  }
  setTimeout(() => process.exit(), 10).unref();
}

/**
 * Every attempt at the terminal record failed, so the manager will find a stale heartbeat and
 * call the job lost. Say what really happened at the end of the job's log, the one place left
 * that someone reads. The log is safe to write: the record never turned terminal, so the
 * manager cannot have dismissed the job and deleted it.
 */
function reportUnrecordedEnd(error: unknown): void {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? 'unknown error';
  const outcome =
    state.exitCode === undefined || state.exitCode === null
      ? state.status
      : `${state.status}, exit code ${state.exitCode}`;
  try {
    appendFileSync(
      spec.outputPath,
      `[runner: the job ended (${outcome}) but its record could not be written (${code}); Book will report it as lost]\n`,
    );
  } catch {
    // There is nowhere left to say it.
  }
}

/** The supervisor built beside this file: `.js` in dist, `.ts` when run from source through tsx. */
function supervisorPath(): string {
  const self = fileURLToPath(import.meta.url);
  return join(dirname(self), `job-supervisor${extname(self)}`);
}

function failStartup(what: string, error: unknown): never {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Persistent background runner could not ${what}: ${reason}\n`);
  process.exit(1);
}

/**
 * Create the log, write the first record, then start the command under its supervisor. The
 * first record is the one write that cannot be best effort: the manager waits for it to call
 * the job started, and without it the manager gives up, forgets the job and deletes its files
 * while the command runs on with nothing left to stop it. So until it has landed, a failure
 * ends the runner before anything runs, and says why on stderr, which `start()` reports.
 */
function startRunner(): void {
  try {
    writeFileSync(spec.outputPath, '', { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    failStartup('create its job log', error);
  }
  try {
    persist();
  } catch (error) {
    failStartup('write its job record', error);
  }
  let proc: ChildProcess;
  try {
    // `process.execArgv` carries tsx's loader when this runner itself runs from source.
    proc = spawn(
      process.execPath,
      [...process.execArgv, supervisorPath(), specPath, system32Executable('taskkill')],
      {
        cwd: spec.workdir,
        env: { ...process.env, ...spec.env },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
  } catch (error) {
    appendBounded(error instanceof Error ? `${error.message}\n` : `${String(error)}\n`);
    process.exitCode = 1;
    finish('failed');
    return;
  }
  child = proc;
  // The supervisor's stdin is its lifeline to this process: never written and never closed, it
  // reaches end-of-file only when this process is gone. See job-supervisor.ts.
  proc.stdin?.on('error', () => {});
  state = { ...state, childPid: proc.pid };
  persistBestEffort('child pid');
  proc.stdout?.on('data', appendBounded);
  proc.stderr?.on('data', appendBounded);
  proc.on('error', (error) => {
    appendBounded(`${error.message}\n`);
    if (state.status !== 'stopping') finish('failed');
  });
  proc.on('close', (code, signal) => {
    if (terminal || state.status === 'stopping') return;
    finish(code === 0 ? 'exited' : 'failed', code, signal);
  });
  heartbeat = setInterval(() => persistBestEffort('heartbeat'), 1_000);
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
}

async function requestTermination(status: 'killed' | 'timed_out', reason: string): Promise<void> {
  if (terminal || terminationInFlight) return;
  terminationInFlight = true;
  state = { ...state, status: 'stopping', stopReason: reason };
  persistBestEffort('stopping state');
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

startRunner();
