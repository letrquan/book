/**
 * The interactive session's messaging runtime (#620): its inbox, its sender pacing, what it has
 * sent and is still waiting to hear about, and the turn its queued messages make.
 *
 * Created only by the TUI's host (`cli/run.ts`), only while `messaging.enabled` is on, and closed
 * there; it outlives `/clear` and `/resume`, as the live-session writer beside it does. Print mode,
 * the SDK and managed agents never have one (D3), so they never have the `SessionList` and
 * `SessionSend` tools either: the tools exist only on a session given this object.
 *
 * Its state lives here and is passed explicitly: no module state.
 */

import { randomUUID } from 'node:crypto';
import { resolveBookHome } from '../book-home.js';
import { createDebugLogger } from '../debug-log.js';
import type {
  AcceptedPeerMessage,
  InboxStartResult,
  LiveSessionRecord,
  PeerAddressResolution,
  PeerMessageReceipt,
  PeerSendOutcome,
  PeerSendRequest,
  PeerSessionListing,
  PeerSessionRow,
  SessionMessagingHandle,
} from '../types/messaging.js';
import { peerLabel, peerSessionRow, resolvePeerAddress } from './addressing.js';
import {
  buildPeerMessageTurn,
  deliverySize,
  MAX_DELIVERY_BYTES,
  MAX_DELIVERY_MESSAGES,
  type PeerMessageTurn,
  type ReceiptForSend,
} from './delivery.js';
import { appendHop, permissionClassOf, renderEnvelope } from './envelope.js';
import { sendToInbox } from './inbox-client.js';
import {
  CROSS_CLASS_REFUSAL_REASON,
  InboxServer,
  senderClassOf,
  type InboxServerOptions,
} from './inbox-server.js';
import { countOwnHops, INGRESS_LIMITS, touchLru } from './ingress-guard.js';
import { createLivenessProbe, type LivenessProbe } from './liveness.js';
import { SendPacer } from './pacer.js';
import { listLiveSessions, liveSessionsDir } from './registry.js';
import { decodeUdsAddress, encodeUdsAddress } from './wire.js';

/** How long receipts gather before they are told as one notice (Claude Code's 500 ms). */
export const RECEIPT_BATCH_MS = 500;
/** Sends remembered while their receipts may still come. */
const MAX_OUTSTANDING_SENDS = 256;
/** Receipt statuses after which no other receipt about the message is expected. */
const FINAL_STATUSES = new Set([
  'delivered',
  'released',
  'dropped',
  'refused',
  'denied',
  'expired',
]);

/** The writer the runtime reads its own identity from and advertises its inbox through. */
export interface SessionMessagingWriter {
  readonly sessionId: string;
  current(): Pick<LiveSessionRecord, 'name' | 'pid'> | undefined;
  setMessagingSocket(socketPath: string): void;
}

export type SessionMessagingEvent =
  { type: 'message' } | { type: 'receipts'; receipts: ReceiptForSend[] };

export interface SessionMessagingOptions {
  writer: SessionMessagingWriter;
  /** The session's permission mode at launch; the TUI keeps it current with `setPermissionMode`. */
  permissionMode: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  pid?: number;
  platform?: NodeJS.Platform;
  probe?: LivenessProbe;
  now?: () => number;
  /** Test seam: the receipt batch window. */
  receiptBatchMs?: number;
  /** Test seams passed to the inbox (its socket directory, uid, exit backstop, limits). */
  inbox?: Partial<
    Pick<InboxServerOptions, 'uid' | 'tmpdir' | 'processEvents' | 'limits' | 'randomBytes' | 'log'>
  >;
}

interface OutstandingSend {
  socketPath: string;
  label: string;
}

/** The turn a delivery makes, and what taking it off the queue settles. */
export interface PeerDeliveryBatch {
  /** The turn to start, or undefined when every queued message is refused. */
  turn?: PeerMessageTurn;
  /** How many queued messages the batch covers, delivered and refused alike. */
  readonly count: number;
  readonly delivered: readonly AcceptedPeerMessage[];
}

export class SessionMessaging implements SessionMessagingHandle {
  readonly inbox: InboxServer;
  private readonly writer: SessionMessagingWriter;
  private readonly keysDir: string;
  private readonly pid: number;
  private readonly probe: LivenessProbe;
  private readonly receiptBatchMs: number;
  private readonly pacer: SendPacer;
  private readonly log = createDebugLogger('messaging:session');
  private readonly listeners = new Set<(event: SessionMessagingEvent) => void>();
  private readonly outstanding = new Map<string, OutstandingSend>();
  /**
   * The relay chain the current turn continues: the chain of the peer message(s) that started it,
   * or none for a turn anything else started. Set and cleared as turns start, never carried into
   * another turn, so a conversation the user drives starts every relay afresh.
   */
  private turnChain?: readonly string[];
  private pendingReceipts: ReceiptForSend[] = [];
  private receiptTimer?: ReturnType<typeof setTimeout>;
  private mode: string;
  private starting?: Promise<InboxStartResult>;
  private startFailed = false;
  private listening = false;
  private closed = false;

  constructor(options: SessionMessagingOptions) {
    const env = options.env ?? process.env;
    const home = options.home ?? resolveBookHome(env);
    this.writer = options.writer;
    this.keysDir = liveSessionsDir(home);
    this.pid = options.pid ?? process.pid;
    this.probe = options.probe ?? createLivenessProbe(options.platform, env);
    this.receiptBatchMs = options.receiptBatchMs ?? RECEIPT_BATCH_MS;
    this.pacer = new SendPacer(options.now);
    this.mode = options.permissionMode;
    this.inbox = new InboxServer({
      ...options.inbox,
      sessionId: () => this.writer.sessionId,
      home,
      env,
      pid: this.pid,
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      probe: this.probe,
      ...(options.now !== undefined ? { now: options.now } : {}),
      permissionClass: () => permissionClassOf(this.mode),
      onMessage: () => this.emit({ type: 'message' }),
      onReceipt: (receipt) => this.noteReceipt(receipt),
    });
  }

  /** Bind the inbox, then advertise it in the record. Never rejects. */
  start(): Promise<InboxStartResult> {
    this.starting ??= this.inbox.start().then((result) => {
      this.startFailed = result.status !== 'listening';
      if (result.status === 'listening' && !this.closed) {
        this.writer.setMessagingSocket(result.socketPath);
        this.listening = true;
      }
      return result;
    });
    return this.starting;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listening = false;
    if (this.receiptTimer) clearTimeout(this.receiptTimer);
    this.receiptTimer = undefined;
    this.listeners.clear();
    await this.inbox.close();
  }

  /**
   * True from the start of the inbox's start until it fails or closes: a start that is still
   * binding does not take the tools away for a turn and put them back the next, which would
   * rebuild the cached tool list. A send waits for the start.
   */
  available(): boolean {
    return this.starting !== undefined && !this.startFailed && !this.closed;
  }

  /** Follow the session's permission mode: what it sends is marked with its class, and what it accepts is judged by it. */
  setPermissionMode(mode: string): void {
    this.mode = mode;
  }

  /** Hear about arriving messages and receipt batches. Returns the unsubscribe. */
  subscribe(listener: (event: SessionMessagingEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The live sessions now. Read only: a listing never sweeps the registry (the writer's own reads
   * and `book doctor` do), so the read-only tools change nothing on disk.
   */
  async list(): Promise<PeerSessionListing> {
    const records = await listLiveSessions({
      dir: this.keysDir,
      probe: this.probe,
      ownPid: this.pid,
      sweep: false,
    });
    const rows = records.map((record) => peerSessionRow(record, record.pid === this.pid));
    return {
      ...(rows.some((row) => row.self) ? { self: rows.find((row) => row.self) } : {}),
      peers: rows.filter((row) => !row.self).sort((a, b) => a.startedAt - b.startedAt),
    };
  }

  /**
   * A turn starts that no peer message started (the user's, a notice's): what it sends starts a
   * fresh relay chain.
   */
  beginTurn(): void {
    this.turnChain = undefined;
  }

  async resolve(to: string): Promise<PeerAddressResolution> {
    return resolveIn(await this.list(), to);
  }

  async send(request: PeerSendRequest): Promise<PeerSendOutcome> {
    if (this.starting) await this.starting;
    const own = this.inbox.socketPath;
    const hopToken = this.inbox.hopToken;
    if (!this.listening || this.closed || own === undefined || hopToken === undefined) {
      return { status: 'unavailable' };
    }
    const listing = await this.list();
    const resolution = request.target
      ? sameSession(listing, request.target)
      : resolveIn(listing, request.to);
    if (!resolution.ok) {
      if (request.target && resolution.problem === 'not_found') {
        return {
          status: 'gone',
          detail: 'the session at that address changed after it was resolved',
          target: request.target,
        };
      }
      return {
        status: 'unresolved',
        problem: resolution.problem,
        to: request.to,
        candidates: resolution.candidates,
      };
    }
    const target = resolution.target;
    // Refused here rather than sent into a certain drop: the receiver drops a chain over 28 hops,
    // or one that has passed through it 10 times, and this session's own count is what it knows.
    const chain = [...(this.turnChain ?? []), hopToken];
    if (
      chain.length > INGRESS_LIMITS.maxChainLength ||
      countOwnHops(chain, new Set([hopToken])) >= INGRESS_LIMITS.maxSelfHops
    ) {
      return {
        status: 'relay_limit',
        detail: `the relay is ${chain.length} hops long and has passed through this session ${countOwnHops(chain, new Set([hopToken]))} times`,
        target,
      };
    }
    const ownAddress = encodeUdsAddress(own);
    const sessionId = this.writer.sessionId;
    const content = renderEnvelope(
      {
        from: ownAddress,
        fromSession: sessionId,
        hopChain: appendHop(this.turnChain, hopToken),
        fromName: listing.self?.name ?? this.writer.current()?.name,
        fromMode: permissionClassOf(request.mode ?? this.mode),
      },
      request.message,
    );
    const msgId = randomUUID();
    // Remembered before the frame goes out: a receiver can answer before the send has returned.
    touchLru(this.outstanding, msgId, MAX_OUTSTANDING_SENDS, () => ({
      socketPath: target.socketPath,
      label: peerLabel(target),
    }));
    const result = await sendToInbox({
      socketPath: target.socketPath,
      keysDir: this.keysDir,
      probe: this.probe,
      pacer: this.pacer,
      frame: {
        type: 'user',
        message: { role: 'user', content },
        from: ownAddress,
        msg_id: msgId,
      },
    });
    if (result.status === 'sent') return { status: 'sent', target, msgId };
    this.outstanding.delete(msgId);
    return { status: result.status, detail: result.detail, target };
  }

  /**
   * The turn the queued messages make now, without taking them: a send the TUI cannot start yet
   * must leave them queued. A message whose sender's permission class differs from this
   * session's now — the mode may have changed since it arrived — is not in the turn, and is
   * refused when the batch is committed.
   */
  prepareDelivery(): PeerDeliveryBatch | undefined {
    const queued = this.inbox.queued();
    if (queued.length === 0) return undefined;
    const ownClass = permissionClassOf(this.mode);
    // The oldest messages, up to 10 delivered and 64 KiB of content; the rest wait for the next
    // idle turn. A first message over the byte cap goes alone, cut (`fitForDelivery`).
    const delivered: AcceptedPeerMessage[] = [];
    let bytes = 0;
    let count = 0;
    for (const message of queued) {
      if (senderClassOf(message) !== ownClass) {
        count++;
        continue;
      }
      const size = deliverySize(message);
      if (
        delivered.length > 0 &&
        (delivered.length >= MAX_DELIVERY_MESSAGES || bytes + size > MAX_DELIVERY_BYTES)
      ) {
        break;
      }
      delivered.push(message);
      bytes += size;
      count++;
      if (size > MAX_DELIVERY_BYTES) break;
    }
    return {
      count,
      delivered,
      ...(delivered.length > 0 ? { turn: buildPeerMessageTurn(delivered) } : {}),
    };
  }

  /**
   * Whether every message a prepared batch delivers still matches this session's permission class:
   * the mode may change while the turn is being prepared (a pre-turn compaction takes a while).
   */
  stillDeliverable(batch: PeerDeliveryBatch): boolean {
    const ownClass = permissionClassOf(this.mode);
    return batch.delivered.every((message) => senderClassOf(message) === ownClass);
  }

  /**
   * Take a prepared batch off the queue once its turn's user message is recorded (or at once, when
   * it has no turn): `delivered` receipts for the messages in the turn, `refused` for the rest.
   * The turn then continues the longest relay chain among its messages, the one nearest its limit.
   */
  commitDelivery(batch: PeerDeliveryBatch): void {
    const delivered = new Set(batch.delivered);
    if (batch.turn) {
      this.turnChain = batch.delivered
        .map((message) => message.envelope?.attributes.hopChain ?? [])
        .reduce<string[]>(
          (longest, chain) => (chain.length >= longest.length ? chain : longest),
          [],
        );
    }
    for (let index = 0; index < batch.count; index++) {
      const message = this.inbox.take();
      if (!message) break;
      if (delivered.has(message)) {
        this.inbox.acknowledge(message, 'delivered');
      } else {
        this.log.warn('peer message refused at delivery: permission class differs');
        this.inbox.acknowledge(message, 'refused', CROSS_CLASS_REFUSAL_REASON);
      }
    }
  }

  /**
   * A receipt about one of this session's own sends, batched for the notice. Only a receipt naming
   * a message this session sent, from the session it sent it to, counts: any other is dropped.
   */
  private noteReceipt(receipt: PeerMessageReceipt): void {
    const fromPath = decodeUdsAddress(receipt.from);
    const ids = [
      ...new Set([
        ...(receipt.origMsgId !== undefined ? [receipt.origMsgId] : []),
        ...(receipt.droppedMsgIds ?? []),
      ]),
    ];
    const matched = ids.filter((id) => {
      const send = this.outstanding.get(id);
      return send !== undefined && fromPath !== undefined && send.socketPath === fromPath;
    });
    if (matched.length === 0) {
      this.log.debug('receipt ignored: not about a message this session sent there');
      return;
    }
    const target = this.outstanding.get(matched[0])!.label;
    if (FINAL_STATUSES.has(receipt.status)) {
      for (const id of matched) this.outstanding.delete(id);
    }
    this.pendingReceipts.push({ receipt, target, msgIds: matched });
    this.receiptTimer ??= setTimeout(() => this.flushReceipts(), this.receiptBatchMs);
    this.receiptTimer.unref?.();
  }

  private flushReceipts(): void {
    this.receiptTimer = undefined;
    const receipts = this.pendingReceipts;
    this.pendingReceipts = [];
    if (receipts.length > 0 && !this.closed) this.emit({ type: 'receipts', receipts });
  }

  private emit(event: SessionMessagingEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.log.warn('messaging listener failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

function resolveIn(listing: PeerSessionListing, to: string): PeerAddressResolution {
  return resolvePeerAddress(listing.self ? [listing.self, ...listing.peers] : listing.peers, to);
}

/** The live row at `target`'s socket, only while it is still the session `target` was resolved to. */
function sameSession(
  listing: PeerSessionListing,
  target: Pick<PeerSessionRow, 'socketPath' | 'sessionId'>,
): PeerAddressResolution {
  const row = listing.peers.find(
    (candidate) =>
      candidate.socketPath !== undefined &&
      candidate.socketPath === target.socketPath &&
      candidate.sessionId === target.sessionId,
  );
  return row?.socketPath !== undefined
    ? { ok: true, target: { ...row, socketPath: row.socketPath } }
    : { ok: false, problem: 'not_found', candidates: [] };
}
