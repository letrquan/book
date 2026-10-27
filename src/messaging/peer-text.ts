/**
 * The words peer awareness (#620 PR 4) puts in front of the model: shared by the
 * `<session-state>` lines and the `stale_file_observation` error, so the two never disagree.
 */

import { foldControlCharacters } from '../control-characters.js';
import { neutralizeTags } from '../prompt-tags.js';
import type { PeerEditAttribution } from '../types/messaging.js';

/** Invisible format characters: zero-width spaces and joiners, word joiners, Unicode tag text. */
const FORMAT_CHARACTERS = /\p{Cf}/gu;

/**
 * Text from outside the harness, one line of it, with its control characters folded and its
 * invisible format characters removed, so neither a line break nor hidden text survives.
 */
export function plainSpan(text: string): string {
  return foldControlCharacters(text).replace(FORMAT_CHARACTERS, '');
}

/**
 * Text from outside the harness — a file's name or lines, another session's name, branch or paths
 * — as one safe span of a prompt line: no line break or control character can start a line of its
 * own, nothing invisible rides along (a zero-width space inside a tag name would hide the tag from
 * the neutralizer), and no harness tag can open or close.
 */
export function promptSpan(text: string): string {
  return neutralizeTags(plainSpan(text));
}

/** A coarse age for a peer's recorded edit: `just now`, `4m ago`, `2h ago`. */
export function promptAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/**
 * The hedged sentence naming the session whose recorded edit a changed or stale file matches
 * (#620 4d). Hedged because `recentEdits` is the peer's own claim. With messaging, the model is
 * pointed at `SessionSend`; without it, at the user.
 */
export function peerEditSentence(path: string, attribution: PeerEditAttribution): string {
  const peer = promptSpan(attribution.peer);
  const recorded = `${peer} recorded an edit to ${promptSpan(path)} ${promptAgo(attribution.ageMs)}.`;
  return attribution.messaging
    ? `${recorded} Re-read it; if your changes overlap, coordinate with SessionSend to ${peer}.`
    : `${recorded} Re-read it; if your changes overlap, tell the user another session is editing it.`;
}
