/**
 * The interactive session's messaging runtime (#620): its inbox, its sender pacing, what it has
 * sent and is still waiting to hear about, the messages its receive policy holds for the user
 * (`receive-policy.ts`, PR 5), the turn its queued messages make, and `notify_when_idle` both ways
 * (`idle-notify.ts`, PR 6): the subscriptions other sessions made to it, and the ones it made.
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
  IdleSubscribeResult,
  InboxStartResult,
  LiveSessionRecord,
  LiveSessionStatus,
  PeerAddressResolution,
  PeerIdleNoticeReceipt,
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
import {
  assertedClassOf,
  EarliestDeadlineTimer,
  EVICTED_DROP_REASON,
  IDLE_LIMITS,
  idleDetail,
  IdleSubscriptions,
  type IdleLimits,
  type IdleNoticeState,
  type IdleSubscription,
  type PeerIdleNoticeEvent,
} from './idle-notify.js';
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
  type AssertedMode,
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
/** This session's own `notify_when_idle` subscriptions remembered while their notices may come. */
const MAX_AWAITED_IDLE_NOTICES = 256;
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
  /** What the approval sheet can offer changed: a message put off, or room for one. */
  | { type: 'holds-changed' }
  /** A session this one subscribed to went idle, exited, or let the subscription expire. */
  | { type: 'idle-notice'; notice: PeerIdleNoticeEvent }
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
  closing: 'the session is closing',
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
  /** Test seam: the `notify_when_idle` debounce, re-check, lifetime and table limits. */
  idleLimits?: Partial<IdleLimits>;
  /** Test seams passed to the inbox (its socket directory, uid, exit backstop, limits). */
  inbox?: Partial<
    Pick<InboxServerOptions, 'uid' | 'tmpdir' | 'processEvents' | 'limits' | 'randomBytes' | 'log'>
  >;
}

interface OutstandingSend {
  socketPath: string;
  label: string;
}

/** A `notify_when_idle` subscription this session made, waiting for its one notice. */
interface AwaitedIdleNotice {
  socketPath: string;
  sessionId: string;
  label: string;
  /** The relay chain it was sent on, which the turn its notice starts continues. */
  chain: readonly string[];
  /** When this session gives up on the notice and says the subscription expired. */
  lapsesAt: number;
}

/** The turn a delivery makes, and what taking it off the queue settles. */
export interface PeerDeliveryBatch {
  /** The turn to start, or undefined when the policy takes every queued message back. */
  turn?: PeerMessageTurn;
  /** How many queued messages the batch covers, delivered and taken back alike. */
  readonly count: number;
  readonly delivered: readonly AcceptedPeerMessage[];
  /**
   * The queued messages the policy did not accept when the batch was prepared — the mode or the
   * settings changed since they arrived. Each is judged again when the batch is committed: held,
   * refused, or left queued when the policy accepts it by then.
   */
  readonly withheld: readonly AcceptedPeerMessage[];
  /**
   * The permission class the turn runs in (`peerTurnClass`). The permission gate holds the turn
   * to it for the whole run, whatever the mode is switched to meanwhile.
   */
  readonly turnClass: PeerPermissionClass;
}

const ACCEPT: ReceiveVerdict = { action: 'accept' };
/** How often messages put off with Later are offered again, at most: once per idle besides. */
export const REOFFER_INTERVAL_MS = 5 * 60_000;
/** How long one registry listing names the senders of held messages. */
const SENDER_LISTING_MAX_AGE_MS = 2_000;
/** Characters of a sender's `name [ref]` a held row shows. */
const SENDER_LABEL_CHARS = 80;

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
  /** Reply addresses the user denied everything from: what parity would hold from them is refused. */
  private readonly refusedSenders = new Set<string>();
  /** When held messages put off were last offered again. */
  private lastReofferAt?: number;
  /** The listing held messages' senders are named from (`senderListing`). */
  private senderNames?: { readAt: number; listing: Promise<PeerSessionListing | undefined> };
  /** The subscriptions other sessions made to this one. */
  private readonly idleSubscriptions: IdleSubscriptions;
  /** This session's last reply, for an idle notice's `detail`; the TUI provides it. */
  private turnText?: () => string | undefined;
  /** The subscriptions this session made, by the `msg_id` their notice names. */
  private readonly awaitingIdle = new Map<string, AwaitedIdleNotice>();
  private readonly idleLimits: IdleLimits;
  /** One timer, for the earliest of this session's own subscriptions to lapse. */
  private readonly lapses: EarliestDeadlineTimer;
  /** The session's status as its record reports it, and whether host work waits to start a turn. */
  private sessionStatus?: LiveSessionStatus;
  private hostWork = false;
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
      onSubscribe: (request) =>
        this.idleSubscriptions.add({
          from: request.from,
          msgId: request.msgId,
          fromMode: assertedClassOf(request.fromMode),
        }),
      onIdleNotice: (notice) => this.noteIdleNotice(notice),
    });
    this.idleLimits = { ...IDLE_LIMITS, ...options.idleLimits };
    this.idleSubscriptions = new IdleSubscriptions({
      now: this.now,
      limits: this.idleLimits,
      // A turn follows queued messages, and held ones wait for the user: neither is idle yet.
      pending: () => this.inbox.queued().length > 0 || this.heldMessages.size > 0,
      notify: (subscriptions, state, finishedAt) =>
        this.answerIdleSubscriptions(subscriptions, state, finishedAt),
      evict: (subscriptions) => {
        for (const subscription of subscriptions) {
          this.inbox.dropSubscription(subscription.from, subscription.msgId, EVICTED_DROP_REASON);
        }
      },
    });
    this.lapses = new EarliestDeadlineTimer(this.now, () => this.lapseDue());
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
   * Settle every message that was never delivered — held, released or queued — as `expired`, and
   * answer every idle subscription still waiting as `exited`, then close the inbox. The receipts
   * and notices go out before the inbox closes, since a closed one sends nothing, and get
   * {@link CLOSE_DRAIN_MS} together: a session that never answers cannot hold the exit up.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.listening = false;
    if (this.receiptTimer) clearTimeout(this.receiptTimer);
    this.receiptTimer = undefined;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.lapses.clear();
    this.awaitingIdle.clear();
    const undelivered = [
      ...[...this.heldMessages.values()].map((held) => held.message),
      ...this.inbox.queued(),
    ];
    for (const message of undelivered) {
      this.inbox.acknowledge(message, 'expired', RECEIPT_REASONS.expired.shutdown, {
        timeoutMs: this.closeDrainMs,
      });
    }
    this.heldMessages.clear();
    this.idleSubscriptions.close();
    this.listeners.clear();
    await this.inbox.close();
  }

  /**
   * The session's status, as its live-session record reports it (`liveSessionStateOf`): what
   * `SessionList` shows other sessions. With {@link setHostWork}, the one definition of idle the
   * subscriptions other sessions made to this one are answered by.
   */
  setSessionStatus(status: LiveSessionStatus): void {
    this.sessionStatus = status;
    this.updateIdle();
  }

  /**
   * Whether the host has work that will start a turn of its own: the user's queued follow-ups, a
   * completion or notice waiting to be delivered (its retry included), or one being delivered.
   */
  setHostWork(pending: boolean): void {
    this.hostWork = pending;
    this.updateIdle();
  }

  /** Idle: the record says so, and nothing waits to start a turn; queued peer messages are judged at firing. */
  private updateIdle(): void {
    this.idleSubscriptions.setIdle(this.sessionStatus === 'idle' && !this.hostWork);
  }

  /**
   * Where this session's last reply comes from, for the `detail` of the idle notices it sends. The
   * TUI provides it, with provider secrets already redacted; it is sanitized and cut here.
   */
  setTurnTextSource(source: () => string | undefined): void {
    this.turnText = source;
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
   * has not put off, and, while the delivery queue is full, not one whose approval found it full.
   * One `messaging.inbound: hold` held is not offered: the user's setting holds it, and only a
   * change of that setting releases it.
   */
  nextApproval(): HeldPeerMessage | undefined {
    const full = this.inbox.queueFull;
    for (const held of this.heldMessages.values()) {
      if (!isParityHold(held.cause) || held.deferred || (held.awaitingRoom && full)) continue;
      return held;
    }
    return undefined;
  }

  /**
   * The user approved a held message: it joins the delivery queue, to be delivered as a peer turn
   * when the session is next idle, and its sender hears `released` then. One the queue has no
   * room for stays held and is offered again once it has; one already settled says so.
   */
  approve(id: string): HeldApproval {
    const held = this.heldMessages.get(id);
    if (!held) return { outcome: 'resolved' };
    if (!this.release(held, 'approval')) {
      held.awaitingRoom = true;
      return { outcome: 'no-room', held };
    }
    return { outcome: 'released', held };
  }

  /**
   * The session went idle: every held message the user put off is offered again — at most every
   * {@link REOFFER_INTERVAL_MS}, so a sender that keeps sending cannot bring the sheet back after
   * every turn. Between times the status line's held count is the only reminder.
   */
  reofferDeferred(): void {
    const deferred = [...this.heldMessages.values()].filter((held) => held.deferred);
    if (deferred.length === 0) return;
    const now = this.now();
    if (this.lastReofferAt !== undefined && now - this.lastReofferAt < REOFFER_INTERVAL_MS) return;
    this.lastReofferAt = now;
    for (const held of deferred) held.deferred = false;
    this.emit({ type: 'holds-changed' });
  }

  /** How many messages are held from the sender of `held`, `held` included. */
  heldFromSender(held: HeldPeerMessage): number {
    const sender = senderKey(held.message);
    return this.heldList().filter((candidate) => senderKey(candidate.message) === sender).length;
  }

  /**
   * The user denied everything from one sender: every message held from it is denied, and what
   * mode parity would hold from it later is refused, for the rest of this session. Returns how
   * many were denied.
   */
  denyAllFrom(id: string): number {
    const held = this.heldMessages.get(id);
    if (!held) return 0;
    const sender = senderKey(held.message);
    this.refusedSenders.add(sender);
    const denied = this.heldList().filter((candidate) => senderKey(candidate.message) === sender);
    for (const candidate of denied) this.settle(candidate, 'denied', 'user');
    return denied.length;
  }

  /** The user denied every held message, from every sender. Returns how many. */
  denyAll(): number {
    const denied = this.heldList();
    for (const held of denied) this.settle(held, 'denied', 'user');
    return denied.length;
  }

  /** The user denied a held message: its sender hears `denied`. False when it was already settled. */
  deny(id: string): boolean {
    const held = this.heldMessages.get(id);
    if (!held) return false;
    this.settle(held, 'denied', 'user');
    return true;
  }

  /**
   * The user put a held message off, and with it its sender: everything held from that sender —
   * and what it sends next — stays held, offered again when the session is next idle.
   */
  defer(id: string): void {
    const held = this.heldMessages.get(id);
    if (!held) return;
    const sender = senderKey(held.message);
    for (const candidate of this.heldMessages.values()) {
      if (senderKey(candidate.message) === sender) candidate.deferred = true;
    }
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

  /**
   * Send a message, ask for one idle notice (`notifyWhenIdle`), or both: the message first, and the
   * subscription only once it went. Without a `message`, the send is the subscription alone.
   *
   * Either counts one hop on the relay this turn continues, and either is refused here once that
   * relay would be dropped as a loop: a subscription made from the notice of the last one continues
   * its relay, so a model that keeps re-subscribing meets the limit. A pure subscription is paced
   * as a message is; one sent with a message rides on that message's place.
   */
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
    const ownAddress = encodeUdsAddress(own);
    // Refused here rather than sent into a certain drop: the receiver drops a chain over 28 hops,
    // or one that has passed through it 10 times, and this session's own count is what it knows.
    const chain = [...(this.turnChain ?? []), hopToken];
    const ownHops = countOwnHops(chain, new Set([hopToken]));
    if (chain.length > INGRESS_LIMITS.maxChainLength || ownHops >= INGRESS_LIMITS.maxSelfHops) {
      const detail = `the relay is ${chain.length} hops long and has passed through this session ${ownHops} times`;
      return request.message === undefined
        ? { status: 'not_subscribed', reason: 'relay_limit', detail, target }
        : { status: 'relay_limit', detail, target };
    }
    const hopChain = appendHop(this.turnChain, hopToken);
    if (request.message === undefined) {
      const idle = await this.subscribeIdle(target, ownAddress, request.mode, hopChain, true);
      return idle.status === 'subscribed'
        ? { status: 'subscribed', target }
        : { status: 'not_subscribed', reason: idle.status, detail: idle.detail, target };
    }
    const sessionId = this.writer.sessionId;
    const content = renderEnvelope(
      {
        from: ownAddress,
        fromSession: sessionId,
        hopChain,
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
    if (result.status !== 'sent') {
      this.outstanding.delete(msgId);
      return { status: result.status, detail: result.detail, target };
    }
    if (!request.notifyWhenIdle) return { status: 'sent', target, msgId };
    // After the message: the receiver queues it first, so it is not idle until that turn is over.
    const idle = await this.subscribeIdle(target, ownAddress, request.mode, hopChain, false);
    return { status: 'sent', target, msgId, idle };
  }

  /**
   * Ask `target` for one idle notice. Every request is sent, and replaces any subscription this
   * session is still waiting on there: the receiver may have dropped that one, or lost its notice,
   * without a word, and a repeat must never be answered by a notice that may not come.
   */
  private async subscribeIdle(
    target: PeerSessionRow & { socketPath: string },
    ownAddress: string,
    mode: string | undefined,
    chain: readonly string[],
    paced: boolean,
  ): Promise<IdleSubscribeResult> {
    for (const [msgId, awaited] of [...this.awaitingIdle]) {
      if (awaited.socketPath === target.socketPath && awaited.sessionId === target.sessionId) {
        this.awaitingIdle.delete(msgId);
      }
    }
    const msgId = randomUUID();
    // Remembered before the frame goes out: an idle receiver answers within a second.
    touchLru(this.awaitingIdle, msgId, MAX_AWAITED_IDLE_NOTICES, () => ({
      socketPath: target.socketPath,
      sessionId: target.sessionId,
      label: peerLabel(target),
      chain,
      lapsesAt: this.now() + this.idleLimits.ttlMs + this.idleLimits.lapseGraceMs,
    }));
    this.armLapses();
    const result = await sendToInbox({
      socketPath: target.socketPath,
      keysDir: this.keysDir,
      probe: this.probe,
      ...(paced ? { pacer: this.pacer } : {}),
      frame: {
        type: 'control',
        action: 'notify_when_idle',
        from: ownAddress,
        msg_id: msgId,
        from_mode: permissionClassOf(mode ?? this.mode),
        hop_chain: [...chain],
      },
    });
    if (result.status === 'sent') return { status: 'subscribed' };
    this.awaitingIdle.delete(msgId);
    this.armLapses();
    return { status: result.status, detail: result.detail };
  }

  /**
   * The relay a host-delivered notice turn continues: the longer of the session's own and the one
   * the notice's subscription was sent on. Called when the notice's turn is recorded.
   */
  continueRelay(chain: readonly string[]): void {
    if (chain.length >= (this.turnChain?.length ?? 0)) this.turnChain = [...chain];
  }

  /**
   * Answer subscriptions other sessions made: a `peer_idle_notice` to each. Its `detail`, this
   * session's last reply, goes only to a subscriber this session's receive policy would accept a
   * message from now; one from the other permission class, or one the user refused, learns only
   * that this session is idle.
   */
  private answerIdleSubscriptions(
    subscriptions: readonly IdleSubscription[],
    state: IdleNoticeState,
    finishedAt?: number,
  ): void {
    const summary = state === 'expired' ? undefined : idleDetail(this.lastTurnText());
    const fromMode = permissionClassOf(this.mode);
    for (const subscription of subscriptions) {
      const detail =
        summary !== undefined &&
        this.judgeSender(subscription.fromMode, subscription.from).action === 'accept'
          ? summary
          : undefined;
      this.inbox.sendIdleNotice(
        subscription.from,
        {
          origMsgId: subscription.msgId,
          state,
          ...(finishedAt !== undefined ? { finishedAt } : {}),
          ...(detail !== undefined ? { detail } : {}),
          fromMode,
        },
        this.closed ? { timeoutMs: this.closeDrainMs } : {},
      );
    }
  }

  private lastTurnText(): string | undefined {
    try {
      return this.turnText?.();
    } catch {
      return undefined;
    }
  }

  /**
   * The subscription a notice or receipt from `from` names, taken: only one this session made, to
   * the session at that address, and only once. Undefined for anything else.
   */
  private takeAwaited(msgId: string, from: string | undefined): AwaitedIdleNotice | undefined {
    const awaited = this.awaitingIdle.get(msgId);
    if (!awaited || decodeUdsAddress(from) !== awaited.socketPath) return undefined;
    this.awaitingIdle.delete(msgId);
    this.armLapses();
    return awaited;
  }

  /**
   * An idle notice about a subscription this session made. Its model hears it when this session's
   * receive policy would accept a message from the notifier, in a turn of that message's class;
   * its user always sees it.
   */
  private noteIdleNotice(notice: PeerIdleNoticeReceipt): void {
    const awaited = this.takeAwaited(notice.origMsgId, notice.from);
    if (!awaited) {
      this.log.debug('idle notice ignored: not about a subscription this session made there');
      return;
    }
    if (this.closed) return;
    const senderMode = assertedClassOf(notice.fromMode);
    const toModel = this.judgeSender(senderMode, notice.from ?? '').action === 'accept';
    const detail = idleDetail(notice.detail);
    this.emit({
      type: 'idle-notice',
      notice: {
        target: awaited.label,
        state: notice.state,
        ...(detail !== undefined ? { detail } : {}),
        ...(notice.state === 'expired' ? { withinMs: this.idleLimits.ttlMs } : {}),
        toModel,
        ...(toModel
          ? { turnClass: peerTurnClass(this.mode, [{ senderMode, approved: false }]) }
          : {}),
        chain: awaited.chain,
      },
    });
  }

  /**
   * A `dropped` receipt about subscriptions this session made: the session did not keep them. Told
   * as a delivery receipt is, to the model as well as the user: the words are this session's own.
   */
  private noteDroppedSubscriptions(receipt: PeerMessageReceipt, ids: readonly string[]): void {
    for (const id of ids) {
      const awaited = this.takeAwaited(id, receipt.from);
      if (!awaited || this.closed) continue;
      this.emit({
        type: 'idle-notice',
        notice: {
          target: awaited.label,
          state: 'dropped',
          ...(receipt.dropReason !== undefined ? { dropReason: receipt.dropReason } : {}),
          toModel: true,
          chain: awaited.chain,
        },
      });
    }
  }

  private armLapses(): void {
    if (this.closed) return;
    this.lapses.arm([...this.awaitingIdle.values()].map((awaited) => awaited.lapsesAt));
  }

  /**
   * Subscriptions whose session never answered, not even `expired` — killed outright, say — are
   * given up here, and the user told: the model is not woken for a notice that never came.
   */
  private lapseDue(): void {
    const now = this.now();
    for (const [msgId, awaited] of [...this.awaitingIdle]) {
      if (awaited.lapsesAt > now) continue;
      this.awaitingIdle.delete(msgId);
      this.emit({
        type: 'idle-notice',
        notice: {
          target: awaited.label,
          state: 'lapsed',
          withinMs: this.idleLimits.ttlMs + this.idleLimits.lapseGraceMs,
          toModel: false,
        },
      });
    }
    this.armLapses();
  }

  /**
   * The turn the queued messages make now, without taking them: a send the TUI cannot start yet
   * must leave them queued. Every queued message is judged again, a released one included: one
   * the policy would no longer accept — the mode or the settings may have changed since — is not
   * in the turn, and is judged once more when the batch is committed.
   */
  prepareDelivery(): PeerDeliveryBatch | undefined {
    const queued = this.inbox.queued();
    if (queued.length === 0) return undefined;
    // The oldest messages, up to 10 delivered and 64 KiB of content; the rest wait for the next
    // idle turn. A first message over the byte cap goes alone, cut (`fitForDelivery`).
    const delivered: AcceptedPeerMessage[] = [];
    const withheld: AcceptedPeerMessage[] = [];
    let bytes = 0;
    let count = 0;
    for (const message of queued) {
      const verdict = this.deliveryVerdict(message);
      if (verdict.action !== 'accept') {
        withheld.push(message);
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
      withheld,
      turnClass: peerTurnClass(
        this.mode,
        delivered.map((message) => ({
          senderMode: assertedModeOf(message),
          approved: message.release === 'approved',
        })),
      ),
      ...(delivered.length > 0 ? { turn: buildPeerMessageTurn(delivered) } : {}),
    };
  }

  /**
   * Whether the policy still accepts every message a prepared batch delivers: the mode may change
   * while the turn is being prepared (a pre-turn compaction takes a while).
   */
  stillDeliverable(batch: PeerDeliveryBatch): boolean {
    return batch.delivered.every((message) => this.deliveryVerdict(message).action === 'accept');
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
    for (const message of delivered) {
      if (!this.inbox.remove(message)) continue;
      this.inbox.acknowledge(message, message.release ? 'released' : 'delivered');
    }
    // Judged now, not by the verdict from when the batch was prepared: a pre-turn compaction can
    // take long enough for the mode or the settings to change again.
    for (const message of batch.withheld) {
      const verdict = this.deliveryVerdict(message);
      if (verdict.action === 'accept' || !this.inbox.remove(message)) continue;
      if (verdict.action === 'hold') this.hold(message, verdict.cause);
      else this.refuse(message);
    }
    // Taking messages off the queue may make room for an approval that found it full.
    if (!this.inbox.queueFull && this.heldList().some((held) => held.awaitingRoom)) {
      this.emit({ type: 'holds-changed' });
    }
  }

  /**
   * The verdict at delivery: the policy's, judged again for every queued message. The user's
   * approval answers a parity hold and `inbound: hold`, never `inbound: refuse`; a release by a
   * mode change answers nothing the policy now says.
   */
  private deliveryVerdict(message: AcceptedPeerMessage): ReceiveVerdict {
    const verdict = this.judge(message);
    if (message.release !== 'approved' || verdict.action === 'accept') return verdict;
    return verdict.action === 'refuse' ? verdict : ACCEPT;
  }

  /**
   * The policy's verdict on a message now. What parity would hold from a sender the user denied
   * everything from is refused instead.
   */
  private judge(message: AcceptedPeerMessage): ReceiveVerdict {
    return this.judgeSender(assertedModeOf(message), senderKey(message));
  }

  /**
   * The policy's verdict now on anything from a sender that asserts `senderMode`, reached at
   * `sender`: a message, or an idle notice's words.
   */
  private judgeSender(senderMode: AssertedMode, sender: string): ReceiveVerdict {
    const verdict = evaluateReceivePolicy({
      inbound: this.inbound,
      receiverMode: this.mode,
      senderMode,
    });
    return verdict.action === 'hold' &&
      isParityHold(verdict.cause) &&
      this.refusedSenders.has(sender)
      ? { action: 'refuse' }
      : verdict;
  }

  /** The inbox asks about each admitted message: queue it, or hold or refuse it here. */
  private screen(message: AcceptedPeerMessage): 'queue' | 'taken' {
    if (this.closed) {
      this.refuse(message, RECEIPT_REASONS.closing);
      return 'taken';
    }
    const verdict = this.judge(message);
    if (verdict.action === 'accept') return 'queue';
    if (verdict.action === 'hold') this.hold(message, verdict.cause);
    else this.refuse(message);
    return 'taken';
  }

  private refuse(message: AcceptedPeerMessage, reason: string = RECEIPT_REASONS.refused): void {
    this.log.warn('peer message refused', { from: message.from, reason });
    this.inbox.acknowledge(message, 'refused', reason);
  }

  /**
   * Hold a message for the user, telling its sender. Over the cap, the oldest held message expires
   * to make room. The row names the sender once the registry is read; until then, by its ref.
   */
  private hold(message: AcceptedPeerMessage, cause: HoldCause): void {
    if (this.closed) {
      this.refuse(message, RECEIPT_REASONS.closing);
      return;
    }
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
      // A sender the user put off stays put off: its next message does not bring the sheet back.
      deferred: this.heldList().some(
        (candidate) => candidate.deferred && senderKey(candidate.message) === senderKey(message),
      ),
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

  /**
   * `name [ref]` of the live session whose record advertises the address the frame named, as a
   * span: that session wrote its own name, so it is sanitized like any other peer text.
   */
  private async nameSender(held: HeldPeerMessage, path: string | undefined): Promise<void> {
    if (path === undefined) return;
    const listing = await this.senderListing();
    const row = listing?.peers.find((candidate) => candidate.socketPath === path);
    if (row) held.sender = peerTextSpan(peerLabel(row), SENDER_LABEL_CHARS);
  }

  /**
   * One registry listing for naming the senders of held messages, read at most every
   * {@link SENDER_LISTING_MAX_AGE_MS} and shared by every hold meanwhile: a burst of holds costs
   * one scan, not one each.
   */
  private senderListing(): Promise<PeerSessionListing | undefined> {
    if (this.senderNames && this.now() - this.senderNames.readAt < SENDER_LISTING_MAX_AGE_MS) {
      return this.senderNames.listing;
    }
    const readAt = this.now();
    const listing = this.list().catch(() => undefined);
    this.senderNames = { readAt, listing };
    return listing;
  }

  /** Release a held message onto the delivery queue; false, and still held, when it is full. */
  private release(held: HeldPeerMessage, by: HoldSettledBy): boolean {
    const release = by === 'approval' ? 'approved' : 'released';
    if (!this.inbox.enqueue({ ...held.message, release })) return false;
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
    // A drop receipt may name this session's subscriptions as well as, or instead of, its messages.
    if (receipt.status === 'dropped') this.noteDroppedSubscriptions(receipt, ids);
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

/** Which sender a message is from, for grouping: its reply address, or none. */
function senderKey(message: AcceptedPeerMessage): string {
  return message.from ?? '';
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
