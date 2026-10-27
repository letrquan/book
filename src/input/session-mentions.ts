import { mentionTokens } from './input-expansion.js';
import type { ActiveFileMention, FileMentionCandidate } from './file-mentions.js';
import { onAbort } from '../async.js';
import { resolvePeerAddress } from '../messaging/addressing.js';
import type {
  PeerSessionListing,
  PeerSessionRow,
  SessionMessagingHandle,
} from '../types/messaging.js';

/**
 * `@session` mentions (#620): an at-sign token that names another live Book session rather than a
 * file. They are read from the tokens file mentions are read from, outside code, and a token that
 * names something on disk stays a file mention. A mention spells a session the way `SessionSend`
 * addresses one: its name, or `name [ref]` when the name alone does not reach it.
 */

/** The live sessions a mention can name, as last read: the messaging runtime's, cached. */
export interface SessionMentionSource {
  /** Whether the inbox is listening. */
  available(): boolean;
  /** The sessions as last read, without waiting: undefined before the first read. */
  peek(): PeerSessionListing | undefined;
  /**
   * The sessions read within the last few seconds, read again when older. Undefined when the read
   * fails, the inbox is not listening, or `signal` aborts first.
   */
  fresh(signal?: AbortSignal): Promise<PeerSessionListing | undefined>;
}

/** How long a read of the registry answers for, in milliseconds. */
const SNAPSHOT_MAX_AGE_MS = 5_000;

/**
 * The registry as `@session` mentions read it: a snapshot of the messaging runtime's listing, read
 * again only when a mention needs it and it is older than a few seconds, one read at a time. A read
 * is a directory listing plus a liveness probe per session (a `ps` per record on macOS), so a
 * keystroke or a turn that names no session never pays for one. Owned with the inbox; it holds no
 * timer, so it needs no closing.
 */
export class SessionMentionSnapshot implements SessionMentionSource {
  private listing: PeerSessionListing | undefined;
  private readAt = 0;
  private reading: Promise<PeerSessionListing | undefined> | undefined;

  constructor(
    private readonly messaging: Pick<SessionMessagingHandle, 'available' | 'list'>,
    private readonly now: () => number = Date.now,
  ) {}

  available(): boolean {
    return this.messaging.available();
  }

  peek(): PeerSessionListing | undefined {
    return this.listing;
  }

  fresh(signal?: AbortSignal): Promise<PeerSessionListing | undefined> {
    if (!this.messaging.available()) return Promise.resolve(undefined);
    if (this.listing && this.now() - this.readAt < SNAPSHOT_MAX_AGE_MS) {
      return Promise.resolve(this.listing);
    }
    this.reading ??= this.messaging.list().then(
      (listing) => {
        this.listing = listing;
        this.readAt = this.now();
        this.reading = undefined;
        return listing;
      },
      () => {
        this.reading = undefined;
        return undefined;
      },
    );
    if (!signal) return this.reading;
    // The read itself runs on and fills the snapshot; an abort only stops this caller waiting.
    const reading = this.reading;
    return new Promise((resolve) => {
      const dispose = onAbort(signal, () => resolve(undefined));
      void reading.then((listing) => {
        dispose();
        resolve(listing);
      });
    });
  }
}

export interface SessionMention {
  name: string;
  /** The 6-hex ref, lowercased, when the mention carried one. */
  ref?: string;
  /** The token's path, which a file of that name would be inlined by. */
  path: string;
}

/** A ref written after the token, `@name [a1b2c3]`: the token itself ends at the space. */
const REF_AFTER = /^[ \t]*\[([0-9a-fA-F]{6})\]/;
/** A ref written onto the token, `@name[a1b2c3]`. */
const REF_ON = /^(.*\S)\[([0-9a-fA-F]{6})\]$/;

/** The key a mention is told apart by: its name and ref as written. */
export function sessionMentionKey(mention: Pick<SessionMention, 'name' | 'ref'>): string {
  return `${mention.name}\0${mention.ref ?? ''}`;
}

/**
 * The session mentions `input` could hold, each spelling once, in order, without looking at the
 * disk or the registry: which of them name a session, and which a file, is for the caller.
 */
export function findSessionMentions(input: string): SessionMention[] {
  const seen = new Set<string>();
  const mentions: SessionMention[] = [];
  for (const token of mentionTokens(input)) {
    // A `uds:` address is copied from a message's `from` to reply to it, never mentioned.
    if (token.path.startsWith('uds:')) continue;
    const after = REF_AFTER.exec(input.slice(token.end));
    const on = after ? null : REF_ON.exec(token.path);
    const mention: SessionMention = after
      ? { name: token.path, ref: after[1].toLowerCase(), path: token.path }
      : on
        ? { name: on[1], ref: on[2].toLowerCase(), path: token.path }
        : { name: token.path, path: token.path };
    const key = sessionMentionKey(mention);
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push(mention);
  }
  return mentions;
}

/** The rows a listing holds, this session's own first. */
export function listingRows(listing: PeerSessionListing): PeerSessionRow[] {
  return [...(listing.self ? [listing.self] : []), ...listing.peers];
}

/**
 * Whether `target` needs its ref to be addressed: the bare name reaches a session only while no
 * other live session holds it (`resolvePeerAddress`). Used for both the note's `to` and the
 * completion, so a user's rule on the bare name covers what either offers.
 */
export function addressNeedsRef(rows: readonly PeerSessionRow[], target: PeerSessionRow): boolean {
  const bare = resolvePeerAddress(rows, target.name);
  return !(bare.ok && bare.target.socketPath === target.socketPath);
}

/** A session as a mention spells it: quoted when the name has a space, with its ref if asked. */
export function mentionAddress(
  row: Pick<PeerSessionRow, 'name' | 'ref'>,
  withRef: boolean,
): string {
  const name = /\s/.test(row.name) ? `"${row.name}"` : row.name;
  return withRef && row.ref !== undefined ? `${name} [${row.ref}]` : name;
}

/** Sessions `@` alone offers before the files; a typed name offers every session it matches. */
const BARE_MENTION_SESSIONS = 3;

/**
 * The sessions `@` completion offers, above the files: the other live sessions that can receive a
 * message, matching `query` as a prefix first, then anywhere in the name. Each is offered as its
 * mention is typed, with its ref only when the name alone does not reach it. Read from the
 * snapshot as it stands, so the files never wait for the registry.
 */
export function sessionMentionCandidates(
  listing: PeerSessionListing | undefined,
  query: string,
): FileMentionCandidate[] {
  if (!listing) return [];
  const rows = listingRows(listing);
  const wanted = query.toLowerCase();
  const scored = listing.peers.flatMap((peer) => {
    if (peer.socketPath === undefined) return [];
    const name = peer.name.toLowerCase();
    const score = name.startsWith(wanted) ? 0 : name.includes(wanted) ? 1 : undefined;
    return score === undefined ? [] : [{ peer, score }];
  });
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.peer.name.localeCompare(b.peer.name) ||
      a.peer.startedAt - b.peer.startedAt,
  );
  return (wanted ? scored : scored.slice(0, BARE_MENTION_SESSIONS)).map(({ peer }) => ({
    path: mentionAddress(peer, addressNeedsRef(rows, peer)),
    kind: 'session',
    desc: peer.waitingFor ? `${peer.status} (${peer.waitingFor})` : peer.status,
  }));
}

/**
 * Replace the mention being typed with a session's address. Unlike a path, the address is never
 * quoted as a whole: `@name [ref]` is a name and a ref, and a quoted name arrives quoted already.
 */
export function replaceActiveSessionMention(
  input: string,
  mention: ActiveFileMention,
  address: string,
): string {
  return `${input.slice(0, mention.start)}@${address} ${input.slice(mention.end)}`;
}
