import { mentionTokens } from './input-expansion.js';
import type { ActiveFileMention, FileMentionCandidate } from './file-mentions.js';
import type {
  PeerSessionListing,
  PeerSessionRow,
  SessionMessagingHandle,
} from '../types/messaging.js';

/**
 * `@session` mentions (#620): an at-sign token that names another live Book session rather than a
 * file. They are read from the tokens file mentions are read from, outside code, and a token that
 * names something on disk stays a file mention. A mention spells a session the way `SessionSend`
 * addresses one: its name, or `name [ref]` when two share the name.
 */

/** The live sessions a mention can name: the messaging runtime, read only. */
export type SessionMentionSource = Pick<SessionMessagingHandle, 'available' | 'list'>;

export interface SessionMention {
  name: string;
  /** The 6-hex ref, lowercased, when the mention carried one. */
  ref?: string;
}

/** A ref written after the token, `@name [a1b2c3]`: the token itself ends at the space. */
const REF_AFTER = /^[ \t]*\[([0-9a-fA-F]{6})\]/;
/** A ref written onto the token, `@name[a1b2c3]`. */
const REF_ON = /^(.*\S)\[([0-9a-fA-F]{6})\]$/;

/**
 * The sessions `input` mentions, each once, in order. `namesPath` says whether a token names a file
 * or directory, which keeps it a file mention.
 */
export function findSessionMentions(
  input: string,
  namesPath: (path: string) => boolean,
): SessionMention[] {
  const seen = new Set<string>();
  const mentions: SessionMention[] = [];
  for (const token of mentionTokens(input)) {
    // A `uds:` address is copied from a message's `from` to reply to it, never mentioned.
    if (token.path.startsWith('uds:') || namesPath(token.path)) continue;
    const after = REF_AFTER.exec(input.slice(token.end));
    const on = after ? null : REF_ON.exec(token.path);
    const mention: SessionMention = after
      ? { name: token.path, ref: after[1].toLowerCase() }
      : on
        ? { name: on[1], ref: on[2].toLowerCase() }
        : { name: token.path };
    const key = `${mention.name}\0${mention.ref ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push(mention);
  }
  return mentions;
}

/** What a mention of `row` is typed as: quoted when the name has a space, with the ref if asked. */
function mentionAddress(row: Pick<PeerSessionRow, 'name' | 'ref'>, withRef: boolean): string {
  const name = /\s/.test(row.name) ? `"${row.name}"` : row.name;
  return withRef && row.ref !== undefined ? `${name} [${row.ref}]` : name;
}

/**
 * The sessions `@` completion offers after the files: the other live sessions that can receive a
 * message, matching `query` as a prefix first, then anywhere in the name. Each is offered as its
 * mention is typed, by name alone unless another session holds the name too. Nothing while the
 * inbox is not running, and nothing when the registry cannot be read: a completion is a hint.
 */
export async function getSessionMentionCandidates(
  source: SessionMentionSource | undefined,
  query: string,
): Promise<FileMentionCandidate[]> {
  if (!source?.available()) return [];
  let listing: PeerSessionListing;
  try {
    listing = await source.list();
  } catch {
    return [];
  }
  const wanted = query.toLowerCase();
  const holders = new Map<string, number>();
  for (const peer of listing.peers) holders.set(peer.name, (holders.get(peer.name) ?? 0) + 1);
  const scored = listing.peers.flatMap((peer) => {
    if (peer.ref === undefined) return [];
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
  return scored.map(({ peer }) => ({
    path: mentionAddress(peer, (holders.get(peer.name) ?? 0) > 1),
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
