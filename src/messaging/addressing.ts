/**
 * Who a session is to its peers, and which session a `SessionSend` address names (#620). The name
 * is the address; the ref — 6 hex of `sha256(socket path)` — tells two sessions of one name apart;
 * and a reply copies the message's `from`, the sender's `uds:` socket address.
 */

import type {
  PeerAddressResolution,
  PeerSessionRow,
  ReadLiveSessionRecord,
} from '../types/messaging.js';
import { foldControlCharacters } from '../control-characters.js';
import { neutralizeTags } from '../prompt-tags.js';
import { sanitizeEnvelopeName } from './envelope.js';
import { socketPathHash } from './registry.js';
import { decodeUdsAddress } from './wire.js';

/** The ref `SessionList` prints for an inbox socket. */
export function peerRef(socketPath: string): string {
  return socketPathHash(socketPath).slice(0, 6);
}

/** Code points a record's free-text field keeps in a row. */
const MAX_FIELD_CHARS = 64;

/**
 * A record's free-text field as a row shows it to the model. Another session wrote it, so its
 * control characters are folded and its harness tags neutralized, as a message's body is.
 */
function recordField(value: string): string {
  return neutralizeTags(
    Array.from(foldControlCharacters(value)).slice(0, MAX_FIELD_CHARS).join(''),
  );
}

/**
 * A live record as a row, with its ref and socket only when it advertises an inbox. Every field
 * another session wrote is sanitized here, once, so the listing, the address errors and the name
 * this session puts in its envelopes all read the same safe text: the name as an envelope holds
 * it (`sanitizeEnvelopeName`), the rest through {@link recordField}.
 */
export function peerSessionRow(record: ReadLiveSessionRecord, self: boolean): PeerSessionRow {
  const features = Array.isArray(record.features) ? record.features : [];
  const socketPath =
    typeof record.messagingSocketPath === 'string' && features.includes('inbox')
      ? record.messagingSocketPath
      : undefined;
  return {
    name: sanitizeEnvelopeName(record.name) || 'unnamed',
    ...(socketPath !== undefined ? { ref: peerRef(socketPath), socketPath } : {}),
    kind: typeof record.kind === 'string' ? recordField(record.kind) : 'unknown',
    status: typeof record.status === 'string' ? recordField(record.status) : 'unknown',
    ...(typeof record.waitingFor === 'string'
      ? { waitingFor: recordField(record.waitingFor) }
      : {}),
    startedAt: record.startedAt,
    sessionId: record.sessionId,
    pid: record.pid,
    self,
  };
}

/** `name [ref]`, or the bare name of a session that has no ref. */
export function peerLabel(row: Pick<PeerSessionRow, 'name' | 'ref'>): string {
  return row.ref !== undefined ? `${row.name} [${row.ref}]` : row.name;
}

const NAME_WITH_REF = /^(.*\S)\s*\[([0-9a-fA-F]{6})\]$/;

function addressable(row: PeerSessionRow): row is PeerSessionRow & { socketPath: string } {
  return row.socketPath !== undefined;
}

/**
 * The session `to` names among `rows` (this one's own included): by `uds:` address, by
 * `name [ref]`, or by a bare name no other live session holds.
 */
export function resolvePeerAddress(
  rows: readonly PeerSessionRow[],
  to: string,
): PeerAddressResolution {
  const address = to.trim();
  let matches: PeerSessionRow[];
  if (address.startsWith('uds:')) {
    const path = decodeUdsAddress(address);
    matches = path === undefined ? [] : rows.filter((row) => row.socketPath === path);
  } else {
    const withRef = NAME_WITH_REF.exec(address);
    matches = withRef
      ? rows.filter((row) => row.name === withRef[1] && row.ref === withRef[2].toLowerCase())
      : rows.filter((row) => row.name === address);
  }
  if (matches.length === 0) return { ok: false, problem: 'not_found', candidates: [] };
  const others = matches.filter((row) => !row.self);
  if (others.length === 0) return { ok: false, problem: 'self', candidates: matches };
  // A bare name addresses a session only while no other live session holds it, inbox or not: a
  // shared name is answered with the refs, and the `name [ref]` retry is what a rule on the bare
  // name does not cover, so the permission check asks.
  const bareName = !address.startsWith('uds:') && !NAME_WITH_REF.test(address);
  if (bareName && others.length > 1) {
    return { ok: false, problem: 'ambiguous', candidates: others };
  }
  const reachable = others.filter(addressable);
  if (reachable.length === 0) return { ok: false, problem: 'no_inbox', candidates: others };
  if (reachable.length > 1) return { ok: false, problem: 'ambiguous', candidates: reachable };
  return { ok: true, target: reachable[0] };
}
