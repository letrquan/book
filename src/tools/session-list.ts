import type { SessionMessagingHandle, PeerSessionRow } from '../types/messaging.js';
import type { ToolDefinition } from '../types/tools.js';
import { foldControlCharacters } from '../control-characters.js';
import { peerLabel } from '../messaging/addressing.js';
import { toolFailure, toolSuccess } from './result.js';

export const SESSION_LIST_DESCRIPTION = `List the other Book sessions running on this machine, which SessionSend can message, with this session's own name first.

Each row is \`name [ref] · kind · status · started\`. The name is the address; the ref (6 hex) is needed only to tell two sessions with the same name apart. A session marked "no inbox" has messaging off and cannot be messaged. Do not poll this list or send "are you done?" messages: a reply arrives in this session on its own.`;

function age(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** One row: `name [ref] · kind · status · started …`, and why a session cannot be messaged. */
export function formatSessionRow(row: PeerSessionRow, now: number): string {
  const status = row.waitingFor ? `${row.status} (${row.waitingFor})` : row.status;
  const parts = [peerLabel(row), row.kind, status, `started ${age(now - row.startedAt)}`];
  if (row.socketPath === undefined) parts.push('no inbox (messaging is off there)');
  return parts.map(foldControlCharacters).join(' · ');
}

/** What `SessionList` returns for a listing. */
export function formatSessionListing(
  listing: { self?: PeerSessionRow; peers: readonly PeerSessionRow[] },
  now: number,
): string {
  const lines = [
    listing.self
      ? `This session is \`${foldControlCharacters(peerLabel(listing.self))}\`: a message to it would be a message to yourself.`
      : "This session's own record is not written yet, so peers cannot see it.",
    '',
  ];
  if (listing.peers.length === 0) {
    lines.push('No other Book session is running on this machine.');
  } else {
    lines.push(`Other live Book sessions on this machine (${listing.peers.length}):`);
    for (const row of listing.peers) lines.push(`- ${formatSessionRow(row, now)}`);
  }
  return lines.join('\n');
}

export function createSessionListTool(
  messaging: SessionMessagingHandle,
  options: { now?: () => number } = {},
): ToolDefinition {
  const now = options.now ?? Date.now;
  return {
    name: 'SessionList',
    description: SESSION_LIST_DESCRIPTION,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    idempotent: true,
    catalog: {
      // Core while messaging is on, and offered only to the root session of the interactive TUI:
      // a session the model has to discover first is a peer it never learns about (D2).
      exposure: 'core',
      roles: ['root'],
      category: 'session',
      effects: ['read'],
      keywords: ['sessions', 'peers', 'other sessions', 'list', 'cross-session', 'messaging'],
      available: () => messaging.available(),
    },
    execute: async () => {
      try {
        const listing = await messaging.list();
        return toolSuccess(formatSessionListing(listing, now()), {
          presentation: {
            kind: 'text',
            summary: `${listing.peers.length} other session${listing.peers.length === 1 ? '' : 's'}`,
          },
        });
      } catch (error) {
        return toolFailure(
          `Could not list sessions: ${error instanceof Error ? error.message : String(error)}`,
          { code: 'session_list_failed', retryable: true },
        );
      }
    },
  };
}
