/**
 * The `<cross-session-message>` envelope a peer message travels in (#620), in Claude Code's
 * attribute order and encoding:
 *
 * ```
 * <cross-session-message from="uds:/run/user/1000/book-socks/4242.sock" from-session="…"
 *  hop-chain="<24 hex>,<24 hex>" from-name="book-3f" from-mode="prompting">
 * {body}
 * </cross-session-message>
 * ```
 *
 * The sender escapes the envelope tag inside the body (`<` → `<\`). The receiver parses with one
 * strict pattern and renders what it parsed again: only a message that comes back byte for byte is
 * an envelope. Anything else — a forged closer in the body, an attribute out of order or unknown,
 * a name with a control character in it — is delivered as neutralized text with no sender.
 *
 * The relay chain is how a loop between sessions is caught (`ingress-guard.ts`): each session that
 * sends appends its hop token, `HMAC-SHA256(peer token, own address)` cut to 24 hex, to the chain
 * the last peer message in its conversation carried.
 */

import { createHmac } from 'node:crypto';
import type {
  PeerEnvelope,
  PeerEnvelopeAttributes,
  PeerPermissionClass,
} from '../types/messaging.js';
import { neutralizeTags } from '../prompt-tags.js';
import { decodeUdsAddress, encodeUdsAddress } from './wire.js';

export const ENVELOPE_TAG = 'cross-session-message';
/**
 * Hop tokens a chain keeps: the newest, once a relay grows past it. Claude Code's constant, kept
 * verbatim for interop even though a receiver drops any chain over 28 as a runaway
 * (`INGRESS_LIMITS.maxChainLength`): a chain of 29 to 32 is still well-formed, and rejecting it as
 * malformed would turn a counted drop into an unattributed delivery. A Book sender never sends one:
 * `SessionMessaging.send` refuses locally before a chain would pass 28 (`relay_limit`).
 */
export const MAX_HOP_CHAIN = 32;
/** Code points a name or session id keeps. */
export const MAX_ENVELOPE_NAME_CHARS = 64;
const HOP_TOKEN = /^[0-9a-f]{24}$/;
const ENVELOPE = new RegExp(
  `^<${ENVELOPE_TAG}((?: [a-z-]+="[^"]*")*)>\\n([\\s\\S]*)\\n</${ENVELOPE_TAG}>$`,
);
const ATTRIBUTE = / ([a-z-]+)="([^"]*)"/g;
// Format and control characters, surrogates and the line and paragraph separators (Claude Code's
// set), the characters that would break the attribute or read as markup, and the glyphs the TUI's
// held-message rows are built from (`«»`, the dashes, the marks), so a name cannot draw a row's
// structure (#620 PR 5).
const NAME_STRIPPED = /[\p{Cf}\p{Cc}\p{Cs}\p{Zl}\p{Zp}"<>&«»—–·•●✓⚠›]/gu;

/** The permission class of a mode (D5): `bypass` for `bypassPermissions` and `auto`. */
export function permissionClassOf(mode: string | undefined): PeerPermissionClass {
  return mode === 'bypassPermissions' || mode === 'auto' ? 'bypass' : 'prompting';
}

/**
 * A session's hop token: `HMAC-SHA256(key = its peer token, its own `uds:` address)`, cut to 24
 * hex. Only the inbox holds the token, so only it can derive this; the digest reveals nothing of
 * the key and travels in every chain the session sends.
 */
export function deriveHopToken(peerToken: string, ownAddress: string): string {
  return createHmac('sha256', peerToken).update(ownAddress).digest('hex').slice(0, 24);
}

/** `chain` with `token` appended, keeping the newest {@link MAX_HOP_CHAIN}. */
export function appendHop(chain: readonly string[] | undefined, token: string): string[] {
  return [...(chain ?? []), token].slice(-MAX_HOP_CHAIN);
}

/** A name or session id as an attribute holds it: stripped (see above), cut to 64 code points. */
export function sanitizeEnvelopeName(name: string): string {
  return Array.from(name.replace(NAME_STRIPPED, '')).slice(0, MAX_ENVELOPE_NAME_CHARS).join('');
}

/** The sender's escape of the envelope tag inside a body: Claude Code's `<` → `<\`. */
export function escapeEnvelopeBody(body: string): string {
  return neutralizeTags(body, { tags: [ENVELOPE_TAG], style: 'backslash' });
}

function canonicalAddress(address: string): string | undefined {
  const path = decodeUdsAddress(address);
  return path !== undefined && encodeUdsAddress(path) === address ? address : undefined;
}

function renderAttributes(attributes: PeerEnvelopeAttributes): string {
  const parts: string[] = [];
  const from = attributes.from !== undefined ? canonicalAddress(attributes.from) : undefined;
  if (from !== undefined) parts.push(`from="${from}"`);
  if (attributes.fromSession !== undefined) {
    const session = sanitizeEnvelopeName(attributes.fromSession);
    if (session) parts.push(`from-session="${session}"`);
  }
  const chain = (attributes.hopChain ?? []).filter((token) => HOP_TOKEN.test(token));
  if (chain.length > 0) parts.push(`hop-chain="${chain.slice(-MAX_HOP_CHAIN).join(',')}"`);
  if (attributes.fromName !== undefined) {
    const name = sanitizeEnvelopeName(attributes.fromName);
    if (name) parts.push(`from-name="${name}"`);
  }
  if (attributes.fromMode === 'bypass' || attributes.fromMode === 'prompting') {
    parts.push(`from-mode="${attributes.fromMode}"`);
  }
  return parts.map((part) => ` ${part}`).join('');
}

/** The envelope around `body`, which is escaped here; attributes that cannot be written are left out. */
export function renderEnvelope(attributes: PeerEnvelopeAttributes, body: string): string {
  return `<${ENVELOPE_TAG}${renderAttributes(attributes)}>\n${escapeEnvelopeBody(body)}\n</${ENVELOPE_TAG}>`;
}

/**
 * The envelope `content` is, or undefined when it is not one byte for byte. The body comes back
 * as the sender escaped it: rendering it again is what the comparison checks.
 */
export function parseEnvelope(content: string): PeerEnvelope | undefined {
  const match = ENVELOPE.exec(content);
  if (!match) return undefined;
  const raw = new Map<string, string>();
  for (const [, key, value] of match[1].matchAll(ATTRIBUTE)) {
    if (raw.has(key)) return undefined;
    raw.set(key, value);
  }
  const mode = raw.get('from-mode');
  const attributes: PeerEnvelopeAttributes = {
    ...(raw.has('from') ? { from: raw.get('from') } : {}),
    ...(raw.has('from-session') ? { fromSession: raw.get('from-session') } : {}),
    ...(raw.has('hop-chain') ? { hopChain: raw.get('hop-chain')!.split(',') } : {}),
    ...(raw.has('from-name') ? { fromName: raw.get('from-name') } : {}),
    ...(mode === 'bypass' || mode === 'prompting' ? { fromMode: mode } : {}),
  };
  const body = match[2];
  return renderEnvelope(attributes, body) === content ? { attributes, body } : undefined;
}
