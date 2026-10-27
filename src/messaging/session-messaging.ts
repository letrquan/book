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
  PeerMessageReceipt,
  PeerSendOutcome,
  PeerSendRequest,
  PeerSessionListing,
  SessionMessagingHandle,
} from '../types/messaging.js';
import { peerLabel, peerSessionRow, resolvePeerAddress } from './addressing.js';
import { buildPeerMessageTurn, type PeerMessageTurn, type ReceiptForSend } from './delivery.js';
import { appendHop, permissionClassOf, renderEnvelope } from './envelope.js';
import { sendToInbox } from './inbox-client.js';
import {
  CROSS_CLASS_REFUSAL_REASON,
  InboxServer,
  senderClassOf,
  type InboxServerOptions,
} from './inbox-server.js';
import { touchLru } from './ingress-guard.js';
import { createLivenessProbe, type LivenessProbe } from './liveness.js';
import { SendPacer } from './pacer.js';
import { listLiveSessions, liveSessionsDir } from './registry.js';
import { decodeUdsAddress, encodeUdsAddress } from './wire.js';

/** How long receipts gather before they are told as one notice (Claude Code's 500 ms). */
export const RECEIPT_BATCH_MS = 500;
/** Sends remembered while their receipts may still come. */
const MAX_OUTSTANDING_SENDS = 256;
/** Sessions whose last delivered relay chain is remembered, for a send after it was compacted away. */
const MAX_REMEMBERED_CHAINS = 16;
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
  private readonly chains = new Map<string, string[]>();
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

  async list(): Promise<PeerSessionListing> {
    const records = await listLiveSessions({
      dir: this.keysDir,
      probe: this.probe,
      ownPid: this.pid,
    });
    const rows = records.map((record) => peerSessionRow(record, record.pid === this.pid));
    return {
      ...(rows.some((row) => row.self) ? { self: rows.find((row) => row.self) } : {}),
      peers: rows.filter((row) => !row.self).sort((a, b) => a.startedAt - b.startedAt),
    };
  }

  async send(request: PeerSendRequest): Promise<PeerSendOutcome> {
    if (this.starting) await this.starting;
    const own = this.inbox.socketPath;
    const hopToken = this.inbox.hopToken;
    if (!this.listening || this.closed || own === undefined || hopToken === undefined) {
      return { status: 'unavailable' };
    }
    const listing = await this.list();
    const rows = listing.self ? [listing.self, ...listing.peers] : listing.peers;
    const resolution = resolvePeerAddress(rows, request.to);
    if (!resolution.ok) {
      return {
        status: 'unresolved',
        problem: resolution.problem,
        to: request.to,
        candidates: resolution.candidates,
      };
    }
    const target = resolution.target;
    const ownAddress = encodeUdsAddress(own);
    const sessionId = this.writer.sessionId;
    const content = renderEnvelope(
      {
        from: ownAddress,
        fromSession: sessionId,
        hopChain: appendHop(request.hopChain ?? this.chains.get(sessionId), hopToken),
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
    const delivered = queued.filter((message) => senderClassOf(message) === ownClass);
    return {
      count: queued.length,
      delivered,
      ...(delivered.length > 0 ? { turn: buildPeerMessageTurn(delivered) } : {}),
    };
  }

  /**
   * Take a prepared batch off the queue, once its turn has started (or at once, when it has none):
   * `delivered` receipts for the messages in the turn, `refused` for the rest.
   */
  commitDelivery(batch: PeerDeliveryBatch): void {
    const delivered = new Set(batch.delivered);
    for (let index = 0; index < batch.count; index++) {
      const message = this.inbox.take();
      if (!message) break;
      if (delivered.has(message)) {
        this.inbox.acknowledge(message, 'delivered');
        const chain = message.envelope?.attributes.hopChain;
        if (chain) {
          // The newest chain per session id, the most recent sessions kept.
          this.chains.delete(this.writer.sessionId);
          touchLru(this.chains, this.writer.sessionId, MAX_REMEMBERED_CHAINS, () => chain);
        }
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
