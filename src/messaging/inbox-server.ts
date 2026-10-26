/**
 * The interactive session's inbox: a Unix socket other Book sessions on this machine connect to,
 * one connection per frame.
 *
 * Created only by the host that owns the TUI's process (`cli/run.ts`), only while
 * `messaging.enabled` is on, and never on Windows (D3, D4, D6). It is an explicit handle like the
 * live-session writer beside it, and outlives `/clear` and `/resume`.
 *
 * Start:
 * 1. Resolve and vet the socket directory (`socket-dir.ts`).
 * 2. Bind `<dir>/<pid>.sock`, `0600`. When something is already there, a 250 ms connect probe
 *    decides: a dead socket is unlinked and rebound; a live one (a session in another pid
 *    namespace with this pid) makes this session bind a moved-aside `<pid>-<8 hex>.sock`.
 * 3. Publish the key — `{peerToken, procStart, pidDomain}`, `0600`, written atomically — in the
 *    live-sessions directory, named after the socket path.
 * 4. Reap moved-aside sockets nothing listens on any more.
 *
 * Each connection's first line must be an `auth` frame with the token, within 5 s; anything else
 * closes the connection without a word. After it come `user` and `control` frames. An accepted
 * `user` frame waits on the queue for the session (PR 3 delivers it); a dropped one is reported
 * and receipted back to its sender (`ingress-guard.ts`).
 *
 * The token lives in this object and in the key file, nowhere else: it is never logged, put in an
 * error, written to the registry record or exported to a child process.
 */

import { randomBytes as cryptoRandomBytes, randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { chmod, lstat, readdir, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { AtomicJsonWriter } from '../agents/atomic-json.js';
import { resolveBookHome } from '../book-home.js';
import { createDebugLogger } from '../debug-log.js';
import type {
  AcceptedPeerMessage,
  InboxStartResult,
  PeerDropReason,
  PeerMessageReceipt,
} from '../types/messaging.js';
import {
  DROPPED_RECEIPT_REASON,
  DropReceiptCoalescer,
  DropReportLimiter,
  IngressGuard,
  INGRESS_LIMITS,
  type DropReport,
} from './ingress-guard.js';
import { sendToInbox } from './inbox-client.js';
import { createLivenessProbe, type LivenessProbe } from './liveness.js';
import { ensureLiveSessionsDir, liveSessionKeyName, liveSessionsDir } from './registry.js';
import { resolveSocketDir, vettedReplyDirs } from './socket-dir.js';
import {
  decodeUdsAddress,
  encodeUdsAddress,
  LineReader,
  parseAuthLine,
  parseInboxLine,
  peerTokenMatches,
  type ControlFrame,
  type PeerMessageStatusFrame,
  type UserFrame,
} from './wire.js';

/** How long a connection may take to send its auth line. */
export const FIRST_LINE_TIMEOUT_MS = 5_000;
/** How long a connection may sit silent, authenticated or not. */
export const IDLE_TIMEOUT_MS = 30_000;
/** How long one connection may stay open at all: a sender opens one per frame. */
export const MAX_CONNECTION_MS = 60_000;
/** Connections held open at once; one more is closed on arrival. */
export const MAX_CONNECTIONS = 16;
/** How long the probe of an existing socket waits for it to answer. */
export const BIND_PROBE_TIMEOUT_MS = 250;
/** Receipts sent back to this inbox, kept for the session (PR 3 reads them). */
const MAX_KEPT_RECEIPTS = INGRESS_LIMITS.maxQueuedPeerMessages;
/** A socket name this inbox binds or reaps: `<pid>.sock` or the moved-aside `<pid>-<8 hex>.sock`. */
const SOCKET_NAME = /^(\d+)(?:-[0-9a-f]{8})?\.sock$/;
const MOVED_ASIDE_NAME = /^(\d+)-[0-9a-f]{8}\.sock$/;
/** The sender key for a frame with no reply address: such senders share one bucket. */
const ANONYMOUS_SENDER = '(no reply address)';

type InboxLogger = { debug: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };

export interface InboxServerOptions {
  /**
   * The session id a `user` or `control` frame must name when it names one. Read for every
   * frame: `/clear` and `/resume` change it.
   */
  sessionId: () => string | undefined;
  /** BOOK_HOME; resolved from `env` when absent. The key file goes in its live-sessions dir. */
  home?: string;
  env?: NodeJS.ProcessEnv;
  pid?: number;
  uid?: number;
  tmpdir?: string;
  platform?: NodeJS.Platform;
  probe?: LivenessProbe;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  /** Where the exit backstop is registered; a test passes an emitter of its own. */
  processEvents?: Pick<NodeJS.Process, 'once' | 'off'>;
  /** The debug log; a test passes one that records every call. */
  log?: InboxLogger;
  /** Called with each accepted message, after it is queued. */
  onMessage?: (message: AcceptedPeerMessage) => void;
  /** Called with each receipt another session sent about a message this one sent. */
  onReceipt?: (receipt: PeerMessageReceipt) => void;
  /** Called with each drop the human should hear about (rate limited, `suppressed` counted). */
  onDropReport?: (report: DropReport) => void;
  /** Test seams for the limits. */
  limits?: Partial<ConnectionLimits> & { receiptTrailMs?: number };
}

interface ConnectionLimits {
  firstLineTimeoutMs: number;
  idleTimeoutMs: number;
  maxConnectionMs: number;
  maxConnections: number;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a socket at `path` answers within the timeout: `live`, `dead` (refused) or `absent`. */
export function probeSocket(
  path: string,
  timeoutMs = BIND_PROBE_TIMEOUT_MS,
): Promise<'live' | 'dead' | 'absent' | 'unknown'> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (state: 'live' | 'dead' | 'absent' | 'unknown') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(state);
    };
    const socket = createConnection({ path });
    const timer = setTimeout(() => finish('unknown'), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => finish('live'));
    socket.once('error', (error) => {
      const code = errorCode(error);
      finish(code === 'ECONNREFUSED' ? 'dead' : code === 'ENOENT' ? 'absent' : 'unknown');
    });
  });
}

export class InboxServer {
  private readonly env: NodeJS.ProcessEnv;
  private readonly keysDir: string;
  private readonly pid: number;
  private readonly uid?: number;
  private readonly tmpdir?: string;
  private readonly platform: NodeJS.Platform;
  private readonly probe: LivenessProbe;
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly processEvents: Pick<NodeJS.Process, 'once' | 'off'>;
  private readonly log: InboxLogger;
  private readonly limits: ConnectionLimits;
  private readonly guard: IngressGuard;
  private readonly dropReports: DropReportLimiter;
  private readonly dropReceipts: DropReceiptCoalescer;
  private readonly sockets = new Set<Socket>();
  private readonly outgoing = new Set<Promise<void>>();
  private readonly queue: AcceptedPeerMessage[] = [];
  private readonly receipts: PeerMessageReceipt[] = [];
  private server?: Server;
  private token?: string;
  private dir?: string;
  private boundPath?: string;
  private keyFile?: string;
  private closed = false;
  private starting?: Promise<InboxStartResult>;
  private closing?: Promise<void>;

  constructor(private readonly options: InboxServerOptions) {
    this.env = options.env ?? process.env;
    this.keysDir = liveSessionsDir(options.home ?? resolveBookHome(this.env));
    this.pid = options.pid ?? process.pid;
    this.uid = options.uid;
    this.tmpdir = options.tmpdir;
    this.platform = options.platform ?? process.platform;
    this.probe = options.probe ?? createLivenessProbe(this.platform, this.env);
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? cryptoRandomBytes;
    this.processEvents = options.processEvents ?? process;
    this.log = options.log ?? createDebugLogger('messaging:inbox');
    this.limits = {
      firstLineTimeoutMs: options.limits?.firstLineTimeoutMs ?? FIRST_LINE_TIMEOUT_MS,
      idleTimeoutMs: options.limits?.idleTimeoutMs ?? IDLE_TIMEOUT_MS,
      maxConnectionMs: options.limits?.maxConnectionMs ?? MAX_CONNECTION_MS,
      maxConnections: options.limits?.maxConnections ?? MAX_CONNECTIONS,
    };
    this.guard = new IngressGuard(this.now);
    this.dropReports = new DropReportLimiter(this.now);
    this.dropReceipts = new DropReceiptCoalescer(this.now, options.limits?.receiptTrailMs);
  }

  /** The bound socket, canonical, once the inbox is listening. */
  get socketPath(): string | undefined {
    return this.boundPath;
  }

  /** The published key file, once written. */
  get keyPath(): string | undefined {
    return this.keyFile;
  }

  /** The accepted messages waiting for the session, oldest first. */
  queued(): readonly AcceptedPeerMessage[] {
    return [...this.queue];
  }

  /** Take the oldest accepted message off the queue. */
  take(): AcceptedPeerMessage | undefined {
    return this.queue.shift();
  }

  /** The receipts other sessions sent back, oldest first. */
  receivedReceipts(): readonly PeerMessageReceipt[] {
    return [...this.receipts];
  }

  /** Bind the socket and publish the key. Never rejects; a failure is the result's message. */
  start(): Promise<InboxStartResult> {
    this.starting ??= this.begin();
    return this.starting;
  }

  /** Stop listening, close every connection, and remove the socket and the key. */
  close(): Promise<void> {
    this.closing ??= this.end();
    return this.closing;
  }

  private async begin(): Promise<InboxStartResult> {
    if (this.closed)
      return { status: 'failed', message: 'the session closed before the inbox started' };
    if (this.platform === 'win32') {
      return {
        status: 'failed',
        message: 'cross-session messaging is not supported on Windows yet',
      };
    }
    // Registered before anything is created: a session that exits mid-start still cleans up.
    this.processEvents.once('exit', this.removeOnExit);
    try {
      const resolution = await resolveSocketDir({
        create: true,
        env: this.env,
        pid: this.pid,
        platform: this.platform,
        ...(this.uid !== undefined ? { uid: this.uid } : {}),
        ...(this.tmpdir !== undefined ? { tmpdir: this.tmpdir } : {}),
      });
      if (!resolution.ok) {
        return this.fail(
          `no usable socket directory (${resolution.skipped.map((skip) => skip.message).join('; ')})`,
        );
      }
      for (const skip of resolution.skipped) {
        this.log.warn('socket directory passed over', { dir: skip.dir, reason: skip.reason });
      }
      // A path too long for a socket is ordinary (a deep BOOK_HOME); a refusal needs a fix.
      const refusedDirs = resolution.skipped
        .filter((skip) => skip.reason !== 'too-long')
        .map((skip) => skip.message);
      if (this.closed) return this.fail('the session closed before the inbox started');
      this.dir = resolution.dir;
      const { path, movedAside } = await this.bind(resolution.dir);
      if (this.closed) return this.fail('the session closed before the inbox started');
      await this.publishKey(path);
      if (this.closed) return this.fail('the session closed before the inbox started');
      this.track(this.reapMovedAside(resolution.dir));
      this.log.debug('inbox listening', { socket: path, movedAside });
      return { status: 'listening', socketPath: path, movedAside, refusedDirs };
    } catch (error) {
      return this.fail(errorMessage(error));
    }
  }

  /** Undo whatever the start created, and say why. */
  private async fail(message: string): Promise<InboxStartResult> {
    this.log.warn('inbox did not start', { message });
    await this.teardown();
    return { status: 'failed', message };
  }

  private async bind(dir: string): Promise<{ path: string; movedAside: boolean }> {
    const primary = join(dir, `${this.pid}.sock`);
    const state = await this.existingSocketState(primary);
    if (state === 'dead') await unlink(primary).catch(() => undefined);
    if (state === 'absent' || state === 'dead') {
      try {
        await this.listen(primary);
        return { path: primary, movedAside: false };
      } catch (error) {
        // Another process bound it between the probe and the bind.
        if (errorCode(error) !== 'EADDRINUSE') throw error;
      }
    }
    const aside = join(dir, `${this.pid}-${this.randomBytes(4).toString('hex')}.sock`);
    await this.listen(aside);
    return { path: aside, movedAside: true };
  }

  /**
   * What holds `path` now. A socket that answers is a live session (another pid namespace's pid
   * is this one), and one that does not answer in time may be — both are left alone. A refused one
   * is dead. Anything else under the name, in a directory only this user can write, is in the way.
   */
  private async existingSocketState(path: string): Promise<'absent' | 'dead' | 'live'> {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return 'absent';
      throw error;
    }
    if (!info.isSocket()) return 'dead';
    const probed = await probeSocket(path);
    if (probed === 'absent') return 'absent';
    return probed === 'dead' ? 'dead' : 'live';
  }

  private async listen(path: string): Promise<void> {
    const server = createServer({ allowHalfOpen: false }, (socket) => this.accept(socket));
    server.maxConnections = this.limits.maxConnections;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (error) => this.log.warn('inbox socket error', { code: errorCode(error) }));
    this.server = server;
    this.boundPath = path;
    // The directory is the boundary (0700); the mode is the second wall, set before any key exists.
    await chmod(path, 0o600);
  }

  private async publishKey(socketPath: string): Promise<void> {
    await ensureLiveSessionsDir(this.keysDir, this.platform);
    const [pidDomain, procStart] = await Promise.all([
      this.probe.pidDomain(),
      this.probe.startToken(this.pid),
    ]);
    const token = this.randomBytes(16).toString('hex');
    const path = join(this.keysDir, liveSessionKeyName(this.pid, pidDomain, socketPath));
    const writer = new AtomicJsonWriter({
      instanceId: randomUUID(),
      pid: this.pid,
      hostname: hostname(),
    });
    this.keyFile = path;
    const result = await writer.writeAsync(
      path,
      {
        peerToken: token,
        ...(procStart !== undefined ? { procStart } : {}),
        ...(pidDomain !== undefined ? { pidDomain } : {}),
      },
      { canCommit: () => !this.closed },
    );
    if (result.status !== 'ok') {
      this.keyFile = undefined;
      throw new Error(`the inbox key could not be written (${result.status})`);
    }
    this.token = token;
  }

  /** Remove moved-aside sockets whose pid is gone here and that nothing answers on. */
  private async reapMovedAside(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (this.closed) return;
      const match = MOVED_ASIDE_NAME.exec(name);
      if (!match) continue;
      const path = join(dir, name);
      if (path === this.boundPath) continue;
      const pid = Number(match[1]);
      if (pid !== this.pid && this.probe.isAlive(pid)) continue;
      // Only a socket is probed: a link under a socket's name is not followed anywhere.
      const isSocket = await lstat(path).then(
        (info) => info.isSocket(),
        () => false,
      );
      if (isSocket && (await probeSocket(path)) === 'dead') {
        await unlink(path).catch(() => undefined);
      }
    }
  }

  private accept(socket: Socket): void {
    if (this.closed || !this.token) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    const reader = new LineReader();
    let authenticated = false;
    const firstLine = setTimeout(() => {
      this.log.debug('inbox connection closed: no auth line in time');
      socket.destroy();
    }, this.limits.firstLineTimeoutMs);
    firstLine.unref?.();
    const lifetime = setTimeout(() => socket.destroy(), this.limits.maxConnectionMs);
    lifetime.unref?.();
    socket.setTimeout(this.limits.idleTimeoutMs, () => socket.destroy());
    socket.on('error', () => undefined);
    socket.once('close', () => {
      clearTimeout(firstLine);
      clearTimeout(lifetime);
      this.sockets.delete(socket);
    });
    socket.on('data', (chunk: string) => {
      const { lines, overflow } = reader.push(chunk);
      for (const line of lines) {
        if (socket.destroyed) return;
        if (!authenticated) {
          clearTimeout(firstLine);
          const auth = parseAuthLine(line);
          if (!auth.ok || !peerTokenMatches(auth.frame.token, this.token!)) {
            // Logged here only: the peer is told nothing about why.
            this.log.debug('inbox connection refused', { reason: auth.ok ? 'token' : auth.reason });
            socket.destroy();
            return;
          }
          authenticated = true;
          continue;
        }
        this.handleLine(line);
      }
      if (overflow) {
        this.log.debug('inbox connection closed: line over the cap');
        socket.destroy();
      }
    });
  }

  private handleLine(line: string): void {
    const parsed = parseInboxLine(line);
    if (!parsed.ok) {
      this.log.debug('inbox frame ignored', { reason: parsed.reason });
      return;
    }
    const frame = parsed.frame;
    const sessionId = this.options.sessionId();
    if (frame.session_id !== undefined && frame.session_id !== sessionId) {
      this.log.warn('inbox frame dropped: session_id mismatch', { type: frame.type });
      return;
    }
    if (frame.type === 'user') this.handleUser(frame);
    else this.handleControl(frame);
  }

  private handleUser(frame: UserFrame): void {
    const verdict = this.guard.admit({
      senderKey: frame.from ?? ANONYMOUS_SENDER,
      body: frame.message.content,
      queued: this.queue.length,
    });
    if (!verdict.admitted) {
      this.drop(frame, verdict.reason);
      return;
    }
    const message: AcceptedPeerMessage = {
      content: frame.message.content,
      ...(frame.from !== undefined ? { from: frame.from } : {}),
      ...(frame.msg_id !== undefined ? { msgId: frame.msg_id } : {}),
      ...(frame.priority !== undefined ? { priority: frame.priority } : {}),
      receivedAt: this.now(),
    };
    this.queue.push(message);
    this.options.onMessage?.(message);
  }

  private drop(frame: UserFrame, reason: PeerDropReason): void {
    const report = this.dropReports.report(frame.from ?? ANONYMOUS_SENDER, reason);
    if (report) {
      this.log.warn('peer message dropped', {
        from: report.from,
        reason,
        suppressed: report.suppressed,
      });
      this.options.onDropReport?.(report);
    }
    const from = frame.from;
    if (from === undefined) return;
    this.dropReceipts.note(from, frame.msg_id, (droppedMsgIds) => {
      this.track(
        this.sendReceipt(from, {
          type: 'control',
          action: 'peer_message_status',
          status: 'dropped',
          reason: DROPPED_RECEIPT_REASON,
          ...(frame.msg_id !== undefined ? { orig_msg_id: frame.msg_id } : {}),
          drop_reason: reason,
          dropped_msg_ids: droppedMsgIds,
        }),
      );
    });
  }

  private handleControl(frame: ControlFrame): void {
    if (frame.action !== 'peer_message_status') {
      // notify_when_idle and peer_idle_notice are parsed, and acted on in a later PR.
      this.log.debug('inbox control frame not handled yet', { action: frame.action });
      return;
    }
    const receipt = receiptOf(frame, this.now());
    this.receipts.push(receipt);
    if (this.receipts.length > MAX_KEPT_RECEIPTS) this.receipts.shift();
    this.options.onReceipt?.(receipt);
  }

  /**
   * Send a receipt to the address a frame named, once that address passes
   * {@link vetReplyAddress}. Never to this inbox itself, and never in reply to a control frame.
   */
  private async sendReceipt(from: string, frame: PeerMessageStatusFrame): Promise<void> {
    const own = this.boundPath;
    const target = await this.vetReplyAddress(from);
    if (!target || !own || target === own) {
      this.log.debug('receipt not sent: reply address refused');
      return;
    }
    const result = await sendToInbox({
      socketPath: target,
      keysDir: this.keysDir,
      probe: this.probe,
      frame: { ...frame, from: encodeUdsAddress(own), msg_id: randomUUID() },
    });
    this.log.debug('receipt sent', { status: result.status });
  }

  /**
   * The socket a reply address names, when it is one this session may connect to: a `uds:`
   * address of a normalized absolute path, named like a Book socket, directly inside this inbox's
   * directory or another socket directory of this user's that passes the same checks, and a socket
   * now (not a symlink to one). A peer cannot make this session connect anywhere else.
   */
  async vetReplyAddress(address: string): Promise<string | undefined> {
    const path = decodeUdsAddress(address);
    if (!path || !isAbsolute(path) || normalize(path) !== path) return undefined;
    if (!SOCKET_NAME.test(basename(path))) return undefined;
    const dirs = new Set(this.dir ? [this.dir] : []);
    if (!dirs.has(dirname(path))) {
      for (const dir of await vettedReplyDirs({
        env: this.env,
        pid: this.pid,
        ...(this.uid !== undefined ? { uid: this.uid } : {}),
        ...(this.tmpdir !== undefined ? { tmpdir: this.tmpdir } : {}),
      })) {
        dirs.add(dir);
      }
    }
    if (!dirs.has(dirname(path))) return undefined;
    try {
      return (await lstat(path)).isSocket() ? path : undefined;
    } catch {
      return undefined;
    }
  }

  private track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => {
      this.log.debug('inbox background work failed', { error: errorMessage(error) });
    });
    this.outgoing.add(tracked);
    void tracked.finally(() => this.outgoing.delete(tracked));
  }

  private async end(): Promise<void> {
    this.closed = true;
    await this.starting;
    await this.teardown();
    await Promise.allSettled([...this.outgoing]);
  }

  private async teardown(): Promise<void> {
    this.closed = true;
    this.dropReceipts.dispose();
    this.processEvents.off('exit', this.removeOnExit);
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    const socketPath = this.boundPath;
    const keyPath = this.keyFile;
    this.keyFile = undefined;
    this.token = undefined;
    if (socketPath) await unlink(socketPath).catch(() => undefined);
    if (keyPath) await unlink(keyPath).catch(() => undefined);
  }

  /**
   * The `exit` backstop, for every way out of the process that skips {@link close}: `exit()` from
   * `cli/exit.ts`, an uncaught error, a natural exit. Synchronous, as an `exit` listener must be;
   * Node does not remove a socket file on its own when the process just exits.
   */
  private readonly removeOnExit = (): void => {
    this.closed = true;
    for (const path of [this.boundPath, this.keyFile]) {
      if (!path) continue;
      try {
        unlinkSync(path);
      } catch {
        // Already gone.
      }
    }
  };
}

/** How long the launch waits on the inbox before drawing, to show a failed start as a notice. */
export const INBOX_NOTICE_WAIT_MS = 1_000;

/**
 * The startup notices for an inbox start: one for a start that failed, one for a socket directory
 * that was refused on the way. A start still running after the wait is left to finish; whatever
 * it comes to then is in the debug log, and `book doctor` explains the directory.
 */
export async function inboxStartupNotices(
  start: Promise<InboxStartResult> | undefined,
  waitMs = INBOX_NOTICE_WAIT_MS,
): Promise<string[]> {
  if (!start) return [];
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    start,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), waitMs);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
  if (!result) return [];
  if (result.status === 'failed') {
    return [
      `⚠  Cross-session messaging is on, but this session's inbox did not start: ${result.message}. ` +
        'Run `book doctor` for details.',
    ];
  }
  return result.refusedDirs.map(
    (message) =>
      `⚠  Cross-session messaging passed over a socket directory: ${message}. ` +
      `Using ${dirname(result.socketPath)} instead.`,
  );
}

function receiptOf(frame: PeerMessageStatusFrame, receivedAt: number): PeerMessageReceipt {
  return {
    status:
      frame.status === 'expired' && frame.status_detail === 'refused' ? 'refused' : frame.status,
    ...(frame.orig_msg_id !== undefined ? { origMsgId: frame.orig_msg_id } : {}),
    ...(frame.drop_reason !== undefined ? { dropReason: frame.drop_reason } : {}),
    ...(frame.dropped_msg_ids !== undefined ? { droppedMsgIds: frame.dropped_msg_ids } : {}),
    ...(frame.reason !== undefined ? { reason: frame.reason } : {}),
    ...(frame.from !== undefined ? { from: frame.from } : {}),
    receivedAt,
  };
}
