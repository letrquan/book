/**
 * Peer messages a session holds back for its user (#620 PR 5): the record of one, and what the
 * transcript says about it — when it is held, when it is settled, and when a late approval cannot
 * release it. Every word a peer wrote passes {@link peerTextSpan} first: one line, no control or
 * invisible character, no harness tag, and no `«»` to close the preview early and forge the rest
 * of the row.
 */

import type { AcceptedPeerMessage } from '../types/messaging.js';
import { neutralizeTags } from '../prompt-tags.js';
import { plainSpan } from './peer-text.js';
import type { HoldCause } from './receive-policy.js';

/** Held messages a session keeps; the oldest is expired to make room (Claude Code's 100). */
export const MAX_HELD_MESSAGES = 100;
/** Characters of a held message's body the transcript row shows. */
export const HOLD_PREVIEW_CHARS = 120;
/** Characters of a held message's body the approval sheet shows. */
export const APPROVAL_PREVIEW_CHARS = 600;
/** Characters of the name a peer claims that a row shows. */
const CLAIMED_NAME_CHARS = 64;
/** Rows about held messages the transcript shows a minute; the rest are counted into the next. */
export const HOLD_ROWS_PER_MINUTE = 20;

/** A message this session holds. */
export interface HeldPeerMessage {
  /** This session's handle for it; a peer's `msg_id` is not trusted to be unique. */
  readonly id: string;
  readonly message: AcceptedPeerMessage;
  cause: HoldCause;
  readonly heldAt: number;
  /** When it expires unapproved (`messaging.approvalTimeout` after it was held). */
  readonly expiresAt: number;
  /**
   * The session the registry says owns the frame's reply address, as `name [ref]`; the bare
   * `[ref]` when no live record advertises it, or `an unattributed sender` with no address.
   */
  sender: string;
  /** The name the envelope claims, as a span; absent when it claims none. */
  readonly claimedName?: string;
  /** The body as one capped span. */
  readonly preview: string;
  /** The user chose "Later": the approval sheet does not offer it again. */
  deferred: boolean;
}

/** How a held message was settled. */
export type HoldOutcome = 'released' | 'denied' | 'expired' | 'refused';

/** What settled it: the user's answer, a mode or policy change, its deadline, or the cap. */
export type HoldSettledBy = 'approval' | 'mode' | 'policy' | 'timeout' | 'room' | 'user';

/**
 * Text a peer wrote, as one span of a transcript row: control characters folded, invisible ones
 * dropped, whitespace collapsed, cut to `max` characters, harness tags neutralized, and `«»`
 * replaced so the span cannot end the preview it sits in.
 */
export function peerTextSpan(text: string, max: number): string {
  const folded = plainSpan(text).replace(/\s+/g, ' ').trim();
  const chars = Array.from(folded);
  const cut = chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : folded;
  return neutralizeTags(cut).replace(/[«»]/g, '"');
}

/** The body a held message shows: the envelope's when it has one, else what arrived. */
export function heldBody(message: AcceptedPeerMessage): string {
  return message.envelope?.body ?? message.content;
}

/** The name an envelope claims, as a span, or undefined. */
export function claimedNameOf(message: AcceptedPeerMessage): string | undefined {
  const name = message.envelope?.attributes.fromName;
  return name ? peerTextSpan(name, CLAIMED_NAME_CHARS) : undefined;
}

const CAUSE_TEXT: Record<HoldCause, string> = {
  'mode-mismatch':
    "Its sender's permission class differs from this session's (bypassPermissions and auto on one side, every other mode on the other).",
  'no-mode-asserted':
    'It names no permission mode, and this session runs tools without asking (bypassPermissions or auto).',
  'mode-unknown': 'A permission mode involved is not one Book knows, so it is held to be safe.',
  policy: 'messaging.inbound is set to hold.',
};

/** Why a message is held, as one sentence. */
export function holdCauseText(cause: HoldCause): string {
  return CAUSE_TEXT[cause];
}

/**
 * The transcript row for a message just held:
 * `⚠ Held peer message — from <name [ref]> (peer claims name: X); preview: «…» — not delivered (N held).`
 */
export function heldMessageLine(held: HeldPeerMessage, heldCount: number): string {
  const claims = held.claimedName !== undefined ? ` (peer claims name: ${held.claimedName})` : '';
  return `⚠ Held peer message — from ${held.sender}${claims}; preview: «${held.preview}» — not delivered (${heldCount} held). ${holdCauseText(held.cause)}`;
}

/** The transcript row for a held message settled by something other than the user's answer. */
export function settledMessageLine(
  held: HeldPeerMessage,
  outcome: HoldOutcome,
  by: HoldSettledBy,
): string {
  const subject = `Held peer message from ${held.sender}`;
  switch (outcome) {
    case 'released':
      return by === 'approval'
        ? `✓ ${subject} approved: it is delivered when this session is next idle.`
        : `✓ ${subject} released: this session now accepts it.`;
    case 'denied':
      return `${subject} denied; its sender was told.`;
    case 'refused':
      return `⚠ ${subject} refused: messaging.inbound is now refuse. Its sender was told.`;
    case 'expired':
      return by === 'room'
        ? `⚠ ${subject} expired to make room: ${MAX_HELD_MESSAGES} messages are held at most. Its sender was told.`
        : `⚠ ${subject} expired without approval; its sender was told.`;
  }
}

/**
 * What an approval that found no room, or came after the message was settled, tells the user.
 * A policy that turned to `refuse` refused the message when it changed, and its row said so.
 */
export function lateApprovalLine(
  held: HeldPeerMessage | undefined,
  outcome: 'no-room' | 'resolved',
): string {
  return outcome === 'no-room'
    ? `⚠ Not released yet: the delivery queue is full. The peer message from ${held?.sender ?? 'that session'} stays held; approve it again once the queue drains.`
    : '⚠ That held peer message was already settled (expired, refused, released or denied) before the approval.';
}

/**
 * Rows about held messages, at most {@link HOLD_ROWS_PER_MINUTE} a minute: a peer flooding this
 * session can fill the held buffer, but not the transcript. A row after a suppressed run says how
 * many were not shown. The held messages themselves, and the approval sheet, are unaffected.
 */
export class HoldRowLimiter {
  private windowStart = Number.NEGATIVE_INFINITY;
  private shown = 0;
  private suppressed = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** The row to show, or undefined when it is suppressed. */
  admit(line: string): string | undefined {
    const now = this.now();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.shown = 0;
    }
    if (this.shown >= HOLD_ROWS_PER_MINUTE) {
      this.suppressed++;
      return undefined;
    }
    this.shown++;
    const note =
      this.suppressed > 0 ? ` (${this.suppressed} more held-message rows were not shown.)` : '';
    this.suppressed = 0;
    return `${line}${note}`;
  }
}
