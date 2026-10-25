/**
 * The interactive session's own live-session record, for as long as the session runs.
 *
 * Created by the host that owns the TUI's process (`cli/run.ts`), and only there: print mode, the
 * SDK, managed agents and Task subagents never register (D3). The writer is an explicit handle,
 * not module state, and outlives `/clear` and `/resume` — those change the record's `sessionId`,
 * not the process it describes.
 *
 * Writes are best-effort, serialized, and coalesced to the latest state, and a write happens only
 * when a field changes. Nothing here may fail the session: a registry Book cannot write is a
 * registry without this session in it, which `book doctor` reports.
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
  statusUpdatedAt: number;
}

function keyOf(fields: DesiredFields): string {
  return JSON.stringify([fields.sessionId, fields.status, fields.waitingFor ?? null]);
}

export class LiveSessionWriter implements LiveSessionReporter {
  readonly dir: string;
  readonly path: string;
  private readonly pid: number;
  private readonly cwd: string;
  private readonly version: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly probe: LivenessProbe;
  private readonly now: () => number;
  private readonly randomByte?: () => number;
  private readonly atomicWriter: Pick<AtomicJsonWriter, 'writeAsync'>;
  private readonly processEvents: Pick<NodeJS.Process, 'once' | 'off'>;
  /** When the session was created, which is also when its first status took effect. */
  private readonly startedAt: number;
  private desired: DesiredFields;
  private base?: RecordBase;
  private written?: LiveSessionRecord;
  private writtenKey?: string;
  private chain: Promise<void> = Promise.resolve();
  private queued = false;
  /** Set once the directory is vetted: from then on `<pid>.json` there is this session's to remove. */
  private owned = false;
  private closed = false;
  private starting?: Promise<void>;
  private closing?: Promise<void>;

  constructor(options: LiveSessionWriterOptions) {
    this.env = options.env ?? process.env;
    this.dir = liveSessionsDir(options.home ?? resolveBookHome(this.env));
    this.pid = options.pid ?? process.pid;
    this.path = liveSessionRecordPath(this.dir, this.pid);
    this.cwd = options.cwd;
    this.version = options.version;
    this.platform = options.platform ?? process.platform;
    this.probe = options.probe ?? createLivenessProbe(this.platform);
    this.now = options.now ?? Date.now;
    this.randomByte = options.randomByte;
    this.atomicWriter =
      options.atomicWriter ??
      new AtomicJsonWriter({ instanceId: randomUUID(), pid: this.pid, hostname: hostname() });
    this.processEvents = options.processEvents ?? process;
    this.startedAt = this.now();
    this.desired = {
      sessionId: options.sessionId,
      status: 'idle',
      statusUpdatedAt: this.startedAt,
    };
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
      statusUpdatedAt: this.now(),
    };
    this.schedule();
  }

  setSessionId(sessionId: string): void {
    if (sessionId === this.desired.sessionId) return;
    this.desired = { ...this.desired, sessionId };
    this.schedule();
  }

  /** Settles once every write queued so far has landed or been dropped. */
  async flushed(): Promise<void> {
    await this.starting;
    await this.chain;
  }

  /**
   * Stop writing and remove the record. A write still in flight is withdrawn before its rename, so
   * it cannot put back the file this removes.
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
      this.owned = true;
      const [pidDomain, procStart, live] = await Promise.all([
        this.probe.pidDomain(),
        this.probe.startToken(this.pid),
        listLiveSessions({ dir: this.dir, probe: this.probe, ownPid: this.pid }),
      ]);
      const { name, nameSource } = deriveLiveSessionName({
        cwd: this.cwd,
        env: this.env,
        randomByte: this.randomByte,
        liveNames: new Set(live.filter((record) => record.pid !== this.pid).map((r) => r.name)),
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
  }

  private schedule(): void {
    if (this.closed || this.queued || !this.base) return;
    this.queued = true;
    this.chain = this.chain.then(() => this.writeDesired());
  }

  /** Never rejects: a failed write leaves the chain usable for the next change. */
  private async writeDesired(): Promise<void> {
    this.queued = false;
    const base = this.base;
    if (this.closed || !base) return;
    const desired = this.desired;
    const key = keyOf(desired);
    if (key === this.writtenKey) return;
    const record: LiveSessionRecord = {
      ...base,
      sessionId: desired.sessionId,
      status: desired.status,
      ...(desired.waitingFor !== undefined ? { waitingFor: desired.waitingFor } : {}),
      statusUpdatedAt: desired.statusUpdatedAt,
      updatedAt: this.now(),
    };
    try {
      const result = await this.atomicWriter.writeAsync(this.path, record, {
        canCommit: () => !this.closed,
      });
      if (result.status === 'ok') {
        this.written = record;
        this.writtenKey = key;
      } else if (result.status !== 'cancelled') {
        log.warn('live-session record write failed', { status: result.status });
      }
    } catch (error) {
      log.warn('live-session record write failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async end(): Promise<void> {
    this.closed = true;
    await this.starting;
    await this.chain;
    this.processEvents.off('exit', this.removeOnExit);
    if (!this.owned) return;
    try {
      await unlink(this.path);
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
    if (!this.owned) return;
    try {
      unlinkSync(this.path);
    } catch {
      // Already gone.
    }
  };
}
