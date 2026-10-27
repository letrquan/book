/**
 * The inbox wire protocol: newline-delimited JSON over a Unix socket, frame for frame the shapes
 * Claude Code's inbox speaks (§1.4 of the messaging plan), so an interop adapter can come later.
 *
 * A connection's first line is an `auth` frame carrying the receiver's token. After it come `user`
 * frames (a message for the session) and `control` frames (`peer_message_status` receipts, and the
 * `notify_when_idle` / `peer_idle_notice` pair, `idle-notify.ts`). Frames are parsed leniently —
 * unknown fields are kept — but a line that is not a frame at all is never guessed at.
 */

import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** The longest line a peer may send, in UTF-16 code units, as Claude Code counts it. */
export const MAX_LINE_CHARS = 1_048_576;

/**
 * The longest first line a connection may send before it has authenticated. An auth frame is
 * about 60 characters; this leaves room for fields a later version adds, and no more.
 */
export const MAX_AUTH_LINE_CHARS = 1_024;

/** A peer token: 16 random bytes, in lowercase hex. */
export const PEER_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

export const authFrameSchema = z.looseObject({
  type: z.literal('auth'),
  token: z.string(),
});

export const userFrameSchema = z.looseObject({
  type: z.literal('user'),
  message: z.looseObject({
    role: z.literal('user').optional(),
    content: z.string().min(1),
  }),
  priority: z.string().optional(),
  /** The sender's reply address, `uds:<its own socket>`. */
  from: z.string().optional(),
  msg_id: z.string().optional(),
  from_plugin: z.unknown().optional(),
  file_attachments: z.unknown().optional(),
  /** The receiving session's id, when the sender knows it; a mismatch is dropped. */
  session_id: z.string().optional(),
});

export const PEER_MESSAGE_STATUSES = [
  'held',
  'denied',
  'expired',
  'delivered',
  'refused',
  'dropped',
] as const;

export const peerMessageStatusFrameSchema = z.looseObject({
  type: z.literal('control'),
  action: z.literal('peer_message_status'),
  status: z.enum(PEER_MESSAGE_STATUSES),
  /** Claude Code sends `expired` with `status_detail: "refused"` for a refusal. */
  status_detail: z.string().optional(),
  orig_msg_id: z.string().optional(),
  reason: z.string().optional(),
  drop_reason: z.string().optional(),
  dropped_msg_ids: z.array(z.string()).optional(),
  /** The receipt sender's own address. */
  from: z.string().optional(),
  msg_id: z.string().optional(),
  session_id: z.string().optional(),
});

export const notifyWhenIdleFrameSchema = z.looseObject({
  type: z.literal('control'),
  action: z.literal('notify_when_idle'),
  from: z.string(),
  msg_id: z.string(),
  from_mode: z.string().optional(),
  session_id: z.string().optional(),
});

export const peerIdleNoticeFrameSchema = z.looseObject({
  type: z.literal('control'),
  action: z.literal('peer_idle_notice'),
  orig_msg_id: z.string(),
  /**
   * Claude Code's states are `idle` and `exited`. Book adds `expired`, for a subscription that
   * lapsed unfired (D1-a: Book-only); a Claude Code receiver ignores it as malformed.
   */
  state: z.enum(['idle', 'exited', 'expired']),
  finished_at: z.union([z.number(), z.string()]).optional(),
  detail: z.string().optional(),
  from_mode: z.string().optional(),
  from: z.string().optional(),
  session_id: z.string().optional(),
});

export const controlFrameSchema = z.discriminatedUnion('action', [
  peerMessageStatusFrameSchema,
  notifyWhenIdleFrameSchema,
  peerIdleNoticeFrameSchema,
]);

/** The control actions this version handles; any other is a later version's, and is ignored. */
const CONTROL_ACTIONS: ReadonlySet<string> = new Set([
  'peer_message_status',
  'notify_when_idle',
  'peer_idle_notice',
]);

export type AuthFrame = z.infer<typeof authFrameSchema>;
export type UserFrame = z.infer<typeof userFrameSchema>;
export type PeerMessageStatusFrame = z.infer<typeof peerMessageStatusFrameSchema>;
export type NotifyWhenIdleFrame = z.infer<typeof notifyWhenIdleFrameSchema>;
export type PeerIdleNoticeFrame = z.infer<typeof peerIdleNoticeFrameSchema>;
export type ControlFrame = z.infer<typeof controlFrameSchema>;
export type InboxFrame = UserFrame | ControlFrame;

/**
 * One line, judged. `not-json` and `not-a-frame` are lines no peer should send; `unsupported` is a
 * frame of a kind this version does not handle (a control action from a later one), and
 * `malformed` a known kind with a field of the wrong shape. Never carries the line itself, so a
 * caller cannot log a body — or a token — by accident.
 */
export type ParsedLine<T> =
  | { ok: true; frame: T }
  | { ok: false; reason: 'not-json' | 'not-a-frame' | 'unsupported' | 'malformed' };

function parseJsonObject(line: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The connection's first line: an auth frame, or nothing. */
export function parseAuthLine(line: string): ParsedLine<AuthFrame> {
  const value = parseJsonObject(line);
  if (!value) return { ok: false, reason: 'not-json' };
  if (value.type !== 'auth') return { ok: false, reason: 'not-a-frame' };
  const parsed = authFrameSchema.safeParse(value);
  return parsed.success ? { ok: true, frame: parsed.data } : { ok: false, reason: 'malformed' };
}

/** A line after auth: a `user` or `control` frame. */
export function parseInboxLine(line: string): ParsedLine<InboxFrame> {
  const value = parseJsonObject(line);
  if (!value) return { ok: false, reason: 'not-json' };
  if (value.type === 'user') {
    const parsed = userFrameSchema.safeParse(value);
    return parsed.success ? { ok: true, frame: parsed.data } : { ok: false, reason: 'malformed' };
  }
  if (value.type === 'control') {
    if (typeof value.action !== 'string' || !CONTROL_ACTIONS.has(value.action)) {
      return { ok: false, reason: 'unsupported' };
    }
    const parsed = controlFrameSchema.safeParse(value);
    return parsed.success ? { ok: true, frame: parsed.data } : { ok: false, reason: 'malformed' };
  }
  return typeof value.type === 'string'
    ? { ok: false, reason: 'unsupported' }
    : { ok: false, reason: 'not-a-frame' };
}

/** A frame as one wire line, newline included. `JSON.stringify` escapes every newline inside. */
export function serializeFrame(frame: AuthFrame | InboxFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/** Whether a serialized line (newline included) is over {@link MAX_LINE_CHARS}. */
export function exceedsLineCap(line: string, maxChars = MAX_LINE_CHARS): boolean {
  return line.length - (line.endsWith('\n') ? 1 : 0) > maxChars;
}

/**
 * Whether `given` is the session's token, compared in constant time. A value that is not 32 hex
 * digits is refused before any buffer is built: `Buffer.from(…, 'hex')` silently truncates at the
 * first non-hex character, which would let a prefix compare equal.
 */
export function peerTokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || !PEER_TOKEN_PATTERN.test(given)) return false;
  if (!PEER_TOKEN_PATTERN.test(expected)) return false;
  return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}

/**
 * Splits a connection's text into lines without ever holding more than `maxChars` of one line.
 * The decoder upstream (`socket.setEncoding('utf8')`) keeps a multi-byte character split across
 * chunks whole, so `chunk` is always complete text.
 */
export class LineReader {
  private parts: string[] = [];
  private pending = 0;
  private completed = 0;

  /**
   * @param maxChars - the cap on every line.
   * @param firstLineMaxChars - a tighter cap on the first line alone: on a connection that is the
   *   auth line, about 60 characters, so an unauthenticated peer cannot make the inbox hold more.
   */
  constructor(
    private readonly maxChars = MAX_LINE_CHARS,
    private readonly firstLineMaxChars = maxChars,
  ) {}

  /** The lines `chunk` completes, and whether a line went over the cap (the connection is done). */
  push(chunk: string): { lines: string[]; overflow: boolean } {
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf('\n', start);
      if (newline < 0) break;
      const piece = chunk.slice(start, newline);
      if (this.pending + piece.length > this.cap) return this.overflow(lines);
      this.parts.push(piece);
      lines.push(this.parts.join(''));
      this.parts = [];
      this.pending = 0;
      this.completed++;
      start = newline + 1;
    }
    const rest = chunk.slice(start);
    if (this.pending + rest.length > this.cap) return this.overflow(lines);
    if (rest) {
      this.parts.push(rest);
      this.pending += rest.length;
    }
    return { lines, overflow: false };
  }

  /** The characters held for the line not yet ended. */
  get buffered(): number {
    return this.pending;
  }

  private get cap(): number {
    return this.completed === 0 ? this.firstLineMaxChars : this.maxChars;
  }

  private overflow(lines: string[]): { lines: string[]; overflow: true } {
    this.parts = [];
    this.pending = 0;
    return { lines, overflow: true };
  }
}

/** Characters an address keeps as they are; everything else is percent-encoded, as in Claude Code. */
const ADDRESS_SAFE = /[A-Za-z0-9:_/.\\-]/;
const ADDRESS_SHAPE = /^uds:[A-Za-z0-9:_/.\\%-]{1,200}$/;

/** `uds:<path>`, with anything outside the safe set percent-encoded. */
export function encodeUdsAddress(path: string): string {
  let encoded = '';
  for (const char of path) {
    encoded += ADDRESS_SAFE.test(char)
      ? char
      : Array.from(
          Buffer.from(char, 'utf8'),
          (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`,
        ).join('');
  }
  return `uds:${encoded}`;
}

/** The socket path a `uds:` address names, or undefined when it is not one. */
export function decodeUdsAddress(address: unknown): string | undefined {
  if (typeof address !== 'string' || !ADDRESS_SHAPE.test(address)) return undefined;
  try {
    const path = decodeURIComponent(address.slice('uds:'.length));
    return path.includes('\0') ? undefined : path;
  } catch {
    return undefined;
  }
}
