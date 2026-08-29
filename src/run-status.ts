import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolveBookHome } from './book-home.js';

/**
 * A small, always-current file saying what a run is doing right now.
 *
 * `book status` answers "what was this asked to do and what has it spent" from the
 * session JSONL, which is durable and never rewritten. What the JSONL cannot
 * answer is *liveness*: at hour 90 the only on-disk signal that a run is healthy
 * is the transcript's mtime, and that advances at exactly the same rate for a
 * productive run, a refusal spin, and a run wedged on a permission prompt. The
 * default `--output-format text` writes nothing at all until the run terminates,
 * and the alternative is a firehose. Between silence and every reasoning delta
 * there was nothing an operator could leave on.
 *
 * So: one bounded record, rewritten at each turn boundary, carrying the handful of
 * facts a supervisor needs to decide "is this stuck" — plus a crash record written
 * from the exit path, because when a long run dies today nothing durable says why.
 *
 * Deliberately synchronous. The file is ~1 KB against turns that take seconds, and
 * the crash path runs inside `process.on('exit')`, where nothing async can run at
 * all. Written to a temp file and renamed, so a reader never sees a torn record.
 */

export const RUN_STATUS_VERSION = 1;

export interface RunStatusRecord {
  readonly version: typeof RUN_STATUS_VERSION;
  readonly sessionId: string;
  readonly runId: string;
  /** The process holding this run, so a reader can test liveness itself. */
  readonly pid: number;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly turn: number;
  readonly elapsedMs: number;
  /** Canonical name of the most recent tool call, if any. */
  readonly lastTool?: string;
  /** The todo currently marked in progress, if any. */
  readonly currentTodo?: string;
  readonly openTodos: number;
  readonly costUsd: number | null;
  readonly budgetUsd?: number;
  /** Free bytes on the volume holding the workspace, when the platform reports it. */
  readonly freeDiskBytes?: number;
  /** Set once the run has stopped, so a reader can tell finished from wedged. */
  readonly terminal?: {
    readonly status: string;
    readonly reason: string;
    readonly message?: string;
  };
  /**
   * Set when the process died without a terminal outcome. This is the difference
   * between "the objective finished" and "the socket died", which a supervisor
   * otherwise cannot tell apart.
   */
  readonly crash?: { readonly message: string; readonly at: number };
}

export function runStatusDir(home = resolveBookHome()): string {
  return join(home, 'runs');
}

export function runStatusPath(sessionId: string, home = resolveBookHome()): string {
  // Session ids are uuids, but a caller could pass anything; keep it a filename.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  return join(runStatusDir(home), `${safe}.json`);
}

/** Free bytes on the volume holding `path`, or undefined where unavailable. */
export function freeDiskBytes(path: string): number | undefined {
  try {
    const stats = statfsSync(path);
    const free = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(free) && free >= 0 ? free : undefined;
  } catch {
    // statfs is not available on every platform or filesystem, and a status write
    // must never be the thing that ends a run.
    return undefined;
  }
}

/** Write atomically: a reader either sees the previous record or this one. */
export function writeRunStatus(record: RunStatusRecord, home = resolveBookHome()): void {
  const target = runStatusPath(record.sessionId, home);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(runStatusDir(home), { recursive: true });
    const fd = openSync(temp, 'w');
    try {
      writeSync(fd, JSON.stringify(record, null, 2));
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
  } catch {
    // Observability must never take the run down with it.
    try {
      rmSync(temp, { force: true });
    } catch {
      /* ignore */
    }
  }
}

export function readRunStatus(
  sessionId: string,
  home = resolveBookHome(),
): RunStatusRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(runStatusPath(sessionId, home), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return undefined;
    const record = parsed as RunStatusRecord;
    return record.version === RUN_STATUS_VERSION ? record : undefined;
  } catch {
    return undefined;
  }
}

export function clearRunStatus(sessionId: string, home = resolveBookHome()): void {
  try {
    rmSync(runStatusPath(sessionId, home), { force: true });
  } catch {
    /* ignore */
  }
}

export interface RunStatusSeed {
  readonly sessionId: string;
  readonly runId: string;
  readonly workspace: string;
  readonly budgetUsd?: number;
  readonly startedAt: number;
  readonly home?: string;
}

export interface RunStatusUpdate {
  readonly turn: number;
  readonly lastTool?: string;
  readonly currentTodo?: string;
  readonly openTodos: number;
  readonly costUsd: number | null;
  readonly terminal?: RunStatusRecord['terminal'];
}

/**
 * Keeps one run's status file current.
 *
 * Created by a host rather than by the loop: a subagent and a managed agent both
 * call `runAgentLoop` directly, and each writing its own liveness file would make
 * "is the run alive" ambiguous. The host that owns the session owns the file.
 */
export class RunStatusWriter {
  private readonly seed: RunStatusSeed;
  private last: RunStatusRecord;
  private crashHandlerInstalled = false;

  constructor(seed: RunStatusSeed) {
    this.seed = seed;
    this.last = {
      version: RUN_STATUS_VERSION,
      sessionId: seed.sessionId,
      runId: seed.runId,
      pid: process.pid,
      startedAt: seed.startedAt,
      updatedAt: seed.startedAt,
      turn: 0,
      elapsedMs: 0,
      openTodos: 0,
      costUsd: null,
      budgetUsd: seed.budgetUsd,
      freeDiskBytes: freeDiskBytes(seed.workspace),
    };
    writeRunStatus(this.last, seed.home);
  }

  update(update: RunStatusUpdate, now = Date.now()): void {
    this.last = {
      ...this.last,
      updatedAt: now,
      elapsedMs: now - this.seed.startedAt,
      turn: update.turn,
      lastTool: update.lastTool ?? this.last.lastTool,
      currentTodo: update.currentTodo,
      openTodos: update.openTodos,
      costUsd: update.costUsd,
      freeDiskBytes: freeDiskBytes(this.seed.workspace),
      terminal: update.terminal ?? this.last.terminal,
    };
    writeRunStatus(this.last, this.seed.home);
  }

  /**
   * Record that the process is dying without a terminal outcome.
   *
   * Synchronous by necessity: this runs from `process.on('exit')`, where the event
   * loop is already closed and no promise will ever settle.
   */
  recordCrash(message: string, now = Date.now()): void {
    if (this.last.terminal) return; // finished properly; not a crash
    if (this.last.crash) return;
    this.last = { ...this.last, updatedAt: now, crash: { message, at: now } };
    writeRunStatus(this.last, this.seed.home);
  }

  /**
   * Install last-resort handlers so an unhandled fault leaves a record.
   *
   * There is no `uncaughtException` or `unhandledRejection` handler anywhere in the
   * codebase, and `index.ts` ends in a bare `program.parse()` whose returned promise
   * nothing awaits — so a rejection escaping the action handler becomes an unhandled
   * rejection and the operator gets a stack trace on a stderr they may have
   * redirected days ago. Returns a disposer.
   */
  installCrashHandlers(): () => void {
    if (this.crashHandlerInstalled) return () => {};
    this.crashHandlerInstalled = true;
    const onException = (error: unknown): void => {
      this.recordCrash(error instanceof Error ? error.message : String(error));
    };
    const onExit = (): void => {
      this.recordCrash('The process exited before the run reached a terminal outcome.');
    };
    process.on('uncaughtException', onException);
    process.on('unhandledRejection', onException);
    process.on('exit', onExit);
    return () => {
      process.off('uncaughtException', onException);
      process.off('unhandledRejection', onException);
      process.off('exit', onExit);
      this.crashHandlerInstalled = false;
    };
  }

  snapshot(): RunStatusRecord {
    return this.last;
  }
}
