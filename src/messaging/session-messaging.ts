/**
 * The interactive session's messaging runtime (#620): its inbox, its sender pacing, what it has
 * sent and is still waiting to hear about, the messages its receive policy holds for the user
 * (`receive-policy.ts`, PR 5), and the turn its queued messages make.
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
import { DEFAULT_MESSAGING_APPROVAL_TIMEOUT_MS } from '../settings.js';
import type {
  AcceptedPeerMessage,
  InboxStartResult,
  LiveSessionRecord,
  PeerAddressResolution,
  PeerMessageReceipt,
  PeerPermissionClass,
  PeerSendOutcome,
  PeerSendRequest,
  PeerSessionListing,
  PeerSessionRow,
  SessionMessagingHandle,
} from '../types/messaging.js';
import { peerLabel, peerRef, peerSessionRow, resolvePeerAddress } from './addressing.js';
import {
  buildPeerMessageTurn,
  deliverySize,
  MAX_DELIVERY_BYTES,
  MAX_DELIVERY_MESSAGES,
  type PeerMessageTurn,
  type ReceiptForSend,
} from './delivery.js';
import { appendHop, permissionClassOf, renderEnvelope } from './envelope.js';
import {
  claimedNameOf,
  heldBody,
  HOLD_PREVIEW_CHARS,
  MAX_HELD_MESSAGES,
  peerTextSpan,
  type HeldPeerMessage,
  type HoldOutcome,
  type HoldSettledBy,
} from './hold.js';
import { sendToInbox } from './inbox-client.js';
import { CLOSE_DRAIN_MS, InboxServer, type InboxServerOptions } from './inbox-server.js';
import { countOwnHops, INGRESS_LIMITS, touchLru } from './ingress-guard.js';
import { createLivenessProbe, type LivenessProbe } from './liveness.js';
import { SendPacer } from './pacer.js';
import {
  assertedModeOf,
  evaluateReceivePolicy,
  isParityHold,
  peerTurnClass,
  type HoldCause,
  type InboundSetting,
  type ReceiveVerdict,
} from './receive-policy.js';
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
  | { type: 'message' }
  | { type: 'receipts'; receipts: ReceiptForSend[] }
  /** A message was held, or a held one's cause changed: `count` are held now. */
  | { type: 'held'; held: HeldPeerMessage; count: number }
  | {
      type: 'hold-settled';
      held: HeldPeerMessage;
      outcome: HoldOutcome;
      by: HoldSettledBy;
      count: number;
    };

/**
 * What approving a held message did. There is no "the policy refuses now": a change of
 * `messaging.inbound` to `refuse` refuses every held message at once (`setInbound`), so an
 * approval after it finds the message already settled.
 */
export type HeldApproval =
  | { outcome: 'released'; held: HeldPeerMessage }
  /** The delivery queue is full: it stays held. */
  | { outcome: 'no-room'; held: HeldPeerMessage }
  /** It was settled before the approval: expired, released or denied. */
  | { outcome: 'resolved' };

/** The `reason` of the receipts this session sends about the messages its policy takes. */
const RECEIPT_REASONS = {
  refused: 'the receive policy refuses peer messages',
  denied: 'denied by the user',
  expired: {
    timeout: 'not approved in time',
    room: 'evicted: too many messages held',
    shutdown: 'the session ended',
  },
} as const;

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
  /** `messaging.inbound`, resolved; unset, mode parity decides. The TUI keeps it current. */
  inbound?: InboundSetting;
  /** How long a held message waits for approval before it expires (`messaging.approvalTimeout`). */
  approvalTimeoutMs?: number;
  /** Test seam: how many held messages are kept ({@link MAX_HELD_MESSAGES}). */
  holdCapacity?: number;
  /** Test seam: how long the receipts of a close may take ({@link CLOSE_DRAIN_MS}). */
  closeDrainMs?: number;
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
  /** The turn to start, or undefined when the policy takes every queued message back. */
  turn?: PeerMessageTurn;
  /** How many queued messages the batch covers, delivered and taken back alike. */
  readonly count: number;
  readonly delivered: readonly AcceptedPeerMessage[];
  /**
   * The queued messages the policy no longer accepts — the mode changed since they arrived — and
   * what each becomes when the batch is committed: held again, or refused.
   */
  readonly diverted: ReadonlyMap<
    AcceptedPeerMessage,
    Exclude<ReceiveVerdict, { action: 'accept' }>
  >;
  /**
   * The permission class the turn runs in (`peerTurnClass`). The permission gate holds the turn
   * to it for the whole run, whatever the mode is switched to meanwhile.
   */
  readonly turnClass: PeerPermissionClass;
}

const ACCEPT: ReceiveVerdict = { action: 'accept' };

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
  private inbound?: InboundSetting;
  private readonly approvalTimeoutMs: number;
  private readonly holdCapacity: number;
  private readonly closeDrainMs: number;
  private readonly now: () => number;
  /** The messages held for the user, oldest first. */
  private readonly heldMessages = new Map<string, HeldPeerMessage>();
  /** One timer, for the earliest deadline among the held messages. */
  private expiryTimer?: ReturnType<typeof setTimeout>;
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
    this.inbound = options.inbound;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_MESSAGING_APPROVAL_TIMEOUT_MS;
    this.holdCapacity = options.holdCapacity ?? MAX_HELD_MESSAGES;
    this.closeDrainMs = options.closeDrainMs ?? CLOSE_DRAIN_MS;
    this.now = options.now ?? Date.now;
    this.inbox = new InboxServer({
      ...options.inbox,
      sessionId: () => this.writer.sessionId,
      home,
      env,
      pid: this.pid,
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      probe: this.probe,
      ...(options.now !== undefined ? { now: options.now } : {}),
      limits: { ...options.inbox?.limits, closeDrainMs: this.closeDrainMs },
      screen: (message) => this.screen(message),
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

  /**
   * Settle every held message as `expired`, then close the inbox. The receipts go out before the
   * inbox closes, since a closed one sends nothing, and get {@link CLOSE_DRAIN_MS} together: a
   * sender that never answers cannot hold the exit up.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.listening = false;
    if (this.receiptTimer) clearTimeout(this.receiptTimer);
    this.receiptTimer = undefined;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    for (const held of this.heldMessages.values()) {
      this.inbox.acknowledge(held.message, 'expired', RECEIPT_REASONS.expired.shutdown, {
        timeoutMs: this.closeDrainMs,
      });
    }
    this.heldMessages.clear();
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

  /**
   * Follow the session's permission mode: what it sends is marked with its class, and what it
   * accepts is judged by it. Every held message is judged again under the new mode.
   */
  setPermissionMode(mode: string): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.reconsiderHeld('mode');
  }

  /** Follow `messaging.inbound` as the settings change; every held message is judged again. */
  setInbound(inbound: InboundSetting | undefined): void {
    if (inbound === this.inbound) return;
    this.inbound = inbound;
    this.reconsiderHeld('policy');
  }

  /** The held messages, oldest first. */
  heldList(): readonly HeldPeerMessage[] {
    return [...this.heldMessages.values()];
  }

  /**
   * The held message to ask the user about next: the oldest the parity rules held that the user
   * has not put off. One `messaging.inbound: hold` held is not offered: the user's setting holds
   * it, and only a change of that setting releases it.
   */
  nextApproval(): HeldPeerMessage | undefined {
    for (const held of this.heldMessages.values()) {
      if (isParityHold(held.cause) && !held.deferred) return held;
    }
    return undefined;
  }

  /**
   * The user approved a held message: it joins the delivery queue, to be delivered as a peer turn
   * when the session is next idle, and its sender hears `released` then. A late approval says why
   * it could not: the queue is full, or the message is already settled.
   */
  approve(id: string): HeldApproval {
    const held = this.heldMessages.get(id);
    if (!held) return { outcome: 'resolved' };
    if (!this.release(held, 'approval')) return { outcome: 'no-room', held };
    return { outcome: 'released', held };
  }

  /** The user denied a held message: its sender hears `denied`. False when it was already settled. */
  deny(id: string): boolean {
    const held = this.heldMessages.get(id);
    if (!held) return false;
    this.settle(held, 'denied', 'user');
    return true;
  }

  /** The user put a held message off: it stays held until its deadline, and is not offered again. */
  defer(id: string): void {
    const held = this.heldMessages.get(id);
    if (held) held.deferred = true;
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
   * must leave them queued. A message the policy would no longer accept — the mode may have
   * changed since it arrived — is not in the turn: it is held again (or refused) when the batch is
   * committed. A released one is delivered without being judged again.
   */
  prepareDelivery(): PeerDeliveryBatch | undefined {
    const queued = this.inbox.queued();
    if (queued.length === 0) return undefined;
    // The oldest messages, up to 10 delivered and 64 KiB of content; the rest wait for the next
    // idle turn. A first message over the byte cap goes alone, cut (`fitForDelivery`).
    const delivered: AcceptedPeerMessage[] = [];
    const diverted = new Map<AcceptedPeerMessage, Exclude<ReceiveVerdict, { action: 'accept' }>>();
    let bytes = 0;
    let count = 0;
    for (const message of queued) {
      const verdict = message.released ? ACCEPT : this.judge(message);
      if (verdict.action !== 'accept') {
        diverted.set(message, verdict);
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
      diverted,
      turnClass: peerTurnClass(this.mode, delivered.map(assertedModeOf)),
      ...(delivered.length > 0 ? { turn: buildPeerMessageTurn(delivered) } : {}),
    };
  }

  /**
   * Whether the policy still accepts every message a prepared batch delivers: the mode may change
   * while the turn is being prepared (a pre-turn compaction takes a while).
   */
  stillDeliverable(batch: PeerDeliveryBatch): boolean {
    return batch.delivered.every(
      (message) => message.released || this.judge(message).action === 'accept',
    );
  }

  /**
   * Take a prepared batch off the queue once its turn's user message is recorded (or at once, when
   * it has no turn): `delivered` receipts for the messages in the turn (`released` for one that
   * was held), and the rest held again or refused. The turn then continues the longest relay
   * chain among its messages, the one nearest its limit.
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
        this.inbox.acknowledge(message, message.released ? 'released' : 'delivered');
        continue;
      }
      const verdict = batch.diverted.get(message);
      if (verdict?.action === 'hold') this.hold(message, verdict.cause);
      else this.refuse(message);
    }
  }

  /** The policy's verdict on a message now. */
  private judge(message: AcceptedPeerMessage): ReceiveVerdict {
    return evaluateReceivePolicy({
      inbound: this.inbound,
      receiverMode: this.mode,
      senderMode: assertedModeOf(message),
    });
  }

  /** The inbox asks about each admitted message: queue it, or hold or refuse it here. */
  private screen(message: AcceptedPeerMessage): 'queue' | 'taken' {
    const verdict = this.judge(message);
    if (verdict.action === 'accept') return 'queue';
    if (verdict.action === 'hold') this.hold(message, verdict.cause);
    else this.refuse(message);
    return 'taken';
  }

  private refuse(message: AcceptedPeerMessage): void {
    this.log.warn('peer message refused by the receive policy', { from: message.from });
    this.inbox.acknowledge(message, 'refused', RECEIPT_REASONS.refused);
  }

  /**
   * Hold a message for the user, telling its sender. Over the cap, the oldest held message expires
   * to make room. The row names the sender once the registry is read; until then, by its ref.
   */
  private hold(message: AcceptedPeerMessage, cause: HoldCause): void {
    if (this.closed) return;
    for (const oldest of this.heldMessages.values()) {
      if (this.heldMessages.size < this.holdCapacity) break;
      this.settle(oldest, 'expired', 'room');
    }
    const now = this.now();
    const path = message.from !== undefined ? decodeUdsAddress(message.from) : undefined;
    const claimedName = claimedNameOf(message);
    const held: HeldPeerMessage = {
      id: randomUUID(),
      message,
      cause,
      heldAt: now,
      expiresAt: now + this.approvalTimeoutMs,
      sender: path !== undefined ? `[${peerRef(path)}]` : 'an unattributed sender',
      ...(claimedName !== undefined ? { claimedName } : {}),
      preview: peerTextSpan(heldBody(message), HOLD_PREVIEW_CHARS),
      deferred: false,
    };
    this.heldMessages.set(held.id, held);
    this.inbox.acknowledge(message, 'held', cause);
    this.scheduleExpiry();
    void this.nameSender(held, path).then(() => {
      if (this.heldMessages.get(held.id) === held) {
        this.emit({ type: 'held', held, count: this.heldMessages.size });
      }
    });
  }

  /** `name [ref]` of the live session whose record advertises the address the frame named. */
  private async nameSender(held: HeldPeerMessage, path: string | undefined): Promise<void> {
    if (path === undefined) return;
    try {
      const row = (await this.list()).peers.find((candidate) => candidate.socketPath === path);
      if (row) held.sender = peerLabel(row);
    } catch {
      // The ref stands.
    }
  }

  /** Release a held message onto the delivery queue; false, and still held, when it is full. */
  private release(held: HeldPeerMessage, by: HoldSettledBy): boolean {
    if (!this.inbox.enqueue({ ...held.message, released: true })) return false;
    this.settle(held, 'released', by);
    return true;
  }

  /** Stop holding a message; its sender hears the outcome, except `released`, told at delivery. */
  private settle(held: HeldPeerMessage, outcome: HoldOutcome, by: HoldSettledBy): void {
    if (!this.heldMessages.delete(held.id)) return;
    if (outcome === 'refused')
      this.inbox.acknowledge(held.message, 'refused', RECEIPT_REASONS.refused);
    else if (outcome === 'denied')
      this.inbox.acknowledge(held.message, 'denied', RECEIPT_REASONS.denied);
    else if (outcome === 'expired') {
      this.inbox.acknowledge(
        held.message,
        'expired',
        by === 'room' ? RECEIPT_REASONS.expired.room : RECEIPT_REASONS.expired.timeout,
      );
    }
    this.scheduleExpiry();
    this.emit({ type: 'hold-settled', held, outcome, by, count: this.heldMessages.size });
  }

  /** Judge every held message again: release what is accepted now, refuse what is refused. */
  private reconsiderHeld(by: 'mode' | 'policy'): void {
    for (const held of [...this.heldMessages.values()]) {
      const verdict = this.judge(held.message);
      if (verdict.action === 'accept') {
        this.release(held, by);
      } else if (verdict.action === 'refuse') {
        this.settle(held, 'refused', 'policy');
      } else if (verdict.cause !== held.cause) {
        held.cause = verdict.cause;
        held.deferred = false;
        this.emit({ type: 'held', held, count: this.heldMessages.size });
      }
    }
  }

  /** Arm the one timer for the earliest deadline, or none while nothing is held. */
  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (this.closed || this.heldMessages.size === 0) return;
    let next = Infinity;
    for (const held of this.heldMessages.values()) next = Math.min(next, held.expiresAt);
    this.expiryTimer = setTimeout(() => this.expireDue(), Math.max(0, next - this.now()));
    this.expiryTimer.unref?.();
  }

  private expireDue(): void {
    this.expiryTimer = undefined;
    const now = this.now();
    for (const held of [...this.heldMessages.values()]) {
      if (held.expiresAt <= now) this.settle(held, 'expired', 'timeout');
    }
    this.scheduleExpiry();
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
