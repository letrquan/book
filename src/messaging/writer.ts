/**
 * The interactive session's own live-session record, for as long as the session runs.
 *
 * Created by the host that owns the TUI's process (`cli/run.ts`), and only there: print mode, the
 * SDK, managed agents and Task subagents never register (D3). The writer is an explicit handle,
 * not module state, and outlives `/clear` and `/resume` — those change the record's `sessionId`,
 * not the process it describes.
 *
 * Writes are serialized and coalesced to the latest state, and a change of state is written only
 * when a field changes. Two timers keep the record honest when nothing changes: a heartbeat
 * rewrites it every ten minutes or so (putting it back if something removed it, and keeping its
 * `updatedAt` fresh for readers in other pid domains), and a failed write is retried with backoff.
 * Nothing here may fail the session: a registry Book cannot write is a registry without this
 * session in it, which `book doctor` reports.
 */

import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { AtomicJsonWriter } from '../agents/atomic-json.js';
import { resolveBookHome } from '../book-home.js';
import { createDebugLogger } from '../debug-log.js';
import type {
  LiveSessionRecord,
  LiveSessionStatus,
  LiveSessionWaitingFor,
} from '../types/messaging.js';
import { createLivenessProbe, type LivenessProbe } from './liveness.js';
import { deriveLiveSessionName } from './names.js';
import {
  ensureLiveSessionsDir,
  LIVE_SESSION_PROTOCOL,
  listLiveSessions,
  liveSessionRecordPath,
  liveSessionsDir,
} from './registry.js';

const log = createDebugLogger('messaging:registry');

/** The heartbeat's period; each beat lands within ±10% of it, so sessions do not beat in step. */
const HEARTBEAT_MS = 10 * 60 * 1000;
const HEARTBEAT_JITTER = 0.2;
/** The first retry of a failed write, doubled on each failure after it up to the cap. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;

export interface LiveSessionState {
  status: LiveSessionStatus;
  waitingFor?: LiveSessionWaitingFor;
}

/**
 * The record's status from what the session is doing. A prompt outranks a running turn — the turn
 * is stopped on it — and a tool approval or plan approval is a `permission prompt`, while a
 * question the model asked or an MCP server's form is `input needed`.
 */
export function liveSessionStateOf(input: {
  running: boolean;
  permissionPending: boolean;
  inputPending: boolean;
}): LiveSessionState {
  if (input.permissionPending) return { status: 'waiting', waitingFor: 'permission prompt' };
  if (input.inputPending) return { status: 'waiting', waitingFor: 'input needed' };
  return { status: input.running ? 'busy' : 'idle' };
}

/** What the session tells its record. The host keeps the rest of the writer (start and close). */
export interface LiveSessionReporter {
  setState(state: LiveSessionState): void;
  setSessionId(sessionId: string): void;
}

export interface LiveSessionWriterOptions {
  cwd: string;
  sessionId: string;
  version: string;
  /** BOOK_HOME; resolved from `env` when absent. */
  home?: string;
  env?: NodeJS.ProcessEnv;
  pid?: number;
  platform?: NodeJS.Platform;
  probe?: LivenessProbe;
  now?: () => number;
  randomByte?: () => number;
  /** A number in [0, 1) for the heartbeat's jitter. */
  random?: () => number;
  atomicWriter?: Pick<AtomicJsonWriter, 'writeAsync'>;
  /** Where the exit backstop is registered; a test passes an emitter of its own. */
  processEvents?: Pick<NodeJS.Process, 'once' | 'off'>;
}

type RecordBase = Omit<
  LiveSessionRecord,
  'sessionId' | 'status' | 'waitingFor' | 'statusUpdatedAt' | 'updatedAt'
>;

interface DesiredFields extends LiveSessionState {
  sessionId: string;
  /** When the session's status last changed, whether or not that change was ever written. */
  statusChangedAt: number;
}

function keyOf(fields: DesiredFields): string {
  return JSON.stringify([fields.sessionId, fields.status, fields.waitingFor ?? null]);
}

export class LiveSessionWriter implements LiveSessionReporter {
  readonly dir: string;
  private readonly pid: number;
  private readonly cwd: string;
  private readonly version: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly probe: LivenessProbe;
  private readonly now: () => number;
  private readonly randomByte?: () => number;
  private readonly random: () => number;
  private readonly instanceId = randomUUID();
  private readonly atomicWriter: Pick<AtomicJsonWriter, 'writeAsync'>;
  private readonly processEvents: Pick<NodeJS.Process, 'once' | 'off'>;
  /** When the session was created, which is also when its first status took effect. */
  private readonly startedAt: number;
  /** Cancels a start still listing the registry when the session closes. */
  private readonly startAbort = new AbortController();
  private recordPath?: string;
  private desired: DesiredFields;
  private base?: RecordBase;
  private written?: LiveSessionRecord;
  private writtenKey?: string;
  private chain: Promise<void> = Promise.resolve();
  private queued = false;
  /** The next write goes ahead even when nothing changed: a heartbeat, or a retry. */
  private forced = false;
  private failures = 0;
  private heartbeat?: NodeJS.Timeout;
  private retry?: NodeJS.Timeout;
  /** Set once the record's path is known: from then on that file is this session's to remove. */
  private owned = false;
  private closed = false;
  private starting?: Promise<void>;
  private closing?: Promise<void>;

  constructor(options: LiveSessionWriterOptions) {
    this.env = options.env ?? process.env;
    this.dir = liveSessionsDir(options.home ?? resolveBookHome(this.env));
    this.pid = options.pid ?? process.pid;
    this.cwd = options.cwd;
    this.version = options.version;
    this.platform = options.platform ?? process.platform;
    this.probe = options.probe ?? createLivenessProbe(this.platform, this.env);
    this.now = options.now ?? Date.now;
    this.randomByte = options.randomByte;
    this.random = options.random ?? Math.random;
    this.atomicWriter =
      options.atomicWriter ??
      new AtomicJsonWriter({
        instanceId: this.instanceId,
        pid: this.pid,
        hostname: hostname(),
        // A lock a live process holds is a write or a sweep under way. One this writer's pid holds
        // under another instance was left by an earlier process the pid belonged to.
        isLockOwnerAlive: (owner) =>
          owner.instanceId === this.instanceId ||
          (owner.pid !== this.pid && this.probe.isAlive(owner.pid)),
      });
    this.processEvents = options.processEvents ?? process;
    this.startedAt = this.now();
    this.desired = {
      sessionId: options.sessionId,
      status: 'idle',
      statusChangedAt: this.startedAt,
    };
  }

  /** The record's file, once the writer knows its pid domain (the domain is in the name). */
  get path(): string | undefined {
    return this.recordPath;
  }

  /** The record as last written, if one has been. */
  current(): LiveSessionRecord | undefined {
    return this.written;
  }

  /**
   * Vet the directory, pick a name no live session holds, and write the first record. Resolves
   * once that write has landed or failed; never rejects.
   */
  start(): Promise<void> {
    this.starting ??= this.begin();
    return this.starting;
  }

  setState(state: LiveSessionState): void {
    if (state.status === this.desired.status && state.waitingFor === this.desired.waitingFor) {
      return;
    }
    this.desired = {
      ...this.desired,
      status: state.status,
      waitingFor: state.waitingFor,
      statusChangedAt: this.now(),
    };
    this.schedule();
  }

  setSessionId(sessionId: string): void {
    if (sessionId === this.desired.sessionId) return;
    this.desired = { ...this.desired, sessionId };
    this.schedule();
  }

  /** Settles once the start and every write queued so far have landed or been dropped. */
  async flushed(): Promise<void> {
    await this.starting;
    await this.chain;
  }

  /**
   * Stop writing and remove the record. A start still under way is abandoned rather than awaited,
   * and a write still in flight is withdrawn before its rename, so neither can put back the file
   * this removes.
   */
  close(): Promise<void> {
    this.closing ??= this.end();
    return this.closing;
  }

  private async begin(): Promise<void> {
    if (this.closed) return;
    // Registered before anything is written: a session that exits mid-start still cleans up.
    this.processEvents.once('exit', this.removeOnExit);
    try {
      await ensureLiveSessionsDir(this.dir, this.platform);
      if (this.closed) return;
      const [pidDomain, procStart] = await Promise.all([
        this.probe.pidDomain(),
        this.probe.startToken(this.pid),
      ]);
      if (this.closed) return;
      this.recordPath = liveSessionRecordPath(this.dir, this.pid, pidDomain);
      this.owned = true;
      const live = await listLiveSessions({
        dir: this.dir,
        probe: this.probe,
        ownPid: this.pid,
        now: this.now,
        signal: this.startAbort.signal,
      });
      if (this.closed) return;
      const { name, nameSource } = deriveLiveSessionName({
        cwd: this.cwd,
        env: this.env,
        randomByte: this.randomByte,
        liveNames: new Set(
          live
            .filter((record) => record.pid !== this.pid || record.pidDomain !== pidDomain)
            .map((record) => record.name),
        ),
      });
      this.base = {
        pid: this.pid,
        cwd: this.cwd,
        startedAt: this.startedAt,
        ...(procStart !== undefined ? { procStart } : {}),
        ...(pidDomain !== undefined ? { pidDomain } : {}),
        version: this.version,
        protocol: LIVE_SESSION_PROTOCOL,
        features: [],
        kind: 'interactive',
        name,
        nameSource,
      };
    } catch (error) {
      log.warn('live-session registration failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!this.owned) this.processEvents.off('exit', this.removeOnExit);
      return;
    }
    this.schedule();
    await this.chain;
    this.armHeartbeat();
  }

  private schedule(force = false): void {
    if (force) this.forced = true;
    if (this.closed || this.queued || !this.base) return;
    this.queued = true;
    this.chain = this.chain.then(() => this.writeDesired());
  }

  /** Never rejects: a failed write leaves the chain usable, and schedules its own retry. */
  private async writeDesired(): Promise<void> {
    this.queued = false;
    const force = this.forced;
    this.forced = false;
    const base = this.base;
    const path = this.recordPath;
    if (this.closed || !base || !path) return;
    const desired = this.desired;
    const key = keyOf(desired);
    if (key === this.writtenKey && !force) return;
    const written = this.written;
    // A flip that was coalesced away is not a change: the status a reader saw is still the one
    // it has been since it was written.
    const statusUpdatedAt =
      written && written.status === desired.status && written.waitingFor === desired.waitingFor
        ? written.statusUpdatedAt
        : desired.statusChangedAt;
    const record: LiveSessionRecord = {
      ...base,
      sessionId: desired.sessionId,
      status: desired.status,
      ...(desired.waitingFor !== undefined ? { waitingFor: desired.waitingFor } : {}),
      statusUpdatedAt,
      updatedAt: this.now(),
    };
    let landed = false;
    try {
      const result = await this.atomicWriter.writeAsync(path, record, {
        canCommit: () => !this.closed,
      });
      if (result.status === 'cancelled') return;
      landed = result.status === 'ok';
      if (!landed) log.warn('live-session record write failed', { status: result.status });
    } catch (error) {
      log.warn('live-session record write failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (landed) {
      this.written = record;
      this.writtenKey = key;
      this.failures = 0;
      return;
    }
    this.failures++;
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.closed || this.retry) return;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (this.failures - 1), RETRY_MAX_MS);
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.schedule(true);
    }, delay);
    this.retry.unref?.();
  }

  private armHeartbeat(): void {
    if (this.closed) return;
    const spread = 1 - HEARTBEAT_JITTER / 2 + HEARTBEAT_JITTER * this.random();
    this.heartbeat = setTimeout(() => {
      this.heartbeat = undefined;
      this.schedule(true);
      this.armHeartbeat();
    }, HEARTBEAT_MS * spread);
    this.heartbeat.unref?.();
  }

  private async end(): Promise<void> {
    this.closed = true;
    this.startAbort.abort();
    if (this.heartbeat) clearTimeout(this.heartbeat);
    if (this.retry) clearTimeout(this.retry);
    this.heartbeat = this.retry = undefined;
    await this.chain;
    this.processEvents.off('exit', this.removeOnExit);
    if (!this.owned || !this.recordPath) return;
    try {
      await unlink(this.recordPath);
    } catch {
      // Already gone: a sweep, or the exit backstop, got there first.
    }
  }

  /**
   * The `exit` backstop, for every way out of the process that skips {@link close}: `exit()` from
   * `cli/exit.ts`, an uncaught error, a natural exit. Synchronous, as an `exit` listener must be.
   */
  private readonly removeOnExit = (): void => {
    this.closed = true;
    if (this.heartbeat) clearTimeout(this.heartbeat);
    if (this.retry) clearTimeout(this.retry);
    if (!this.owned || !this.recordPath) return;
    try {
      unlinkSync(this.recordPath);
    } catch {
      // Already gone.
    }
  };
}
