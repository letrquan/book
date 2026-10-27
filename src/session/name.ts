import type { Message } from '../types/messages.js';

/**
 * A user-role turn the host delivered rather than the user typed: a completion notification, or
 * another session's message (#620). Its text is nobody's prompt, so it never names a session.
 */
export function isHostDeliveredTurn(message: { kind?: Message['kind'] | string }): boolean {
  return message.kind === 'agent-notification' || message.kind === 'peer-message';
}

/** Label used for a session before its first prompt has been recorded. */
export const UNTITLED_SESSION_NAME = 'Untitled session';

const MAX_SESSION_NAME_LENGTH = 56;

/** Return a compact, deterministic title suitable for user-facing session lists. */
export function deriveSessionName(prompt: string): string {
  const normalized = prompt
    // A leading fence line (```ts) names no task; the code after it does. The word after
    // the fence is a language tag only because a newline follows it: this runs before the
    // newlines are flattened, and an inline ```span``` never matches.
    .replace(/^\s*`{3,}[^\n`]*\r?\n/, '')
    // A fence on a line of its own, opening or closing, wherever it falls.
    .replace(/^[ \t]*`{3,}[\w+-]*[ \t\r]*$/gm, '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Any other command marker. A backtick is not one: it opens an inline code span the
    // name keeps.
    .replace(/^[/!#>*_~-]+\s*/, '')
    .replace(/[.!?,;:]+$/, '')
    .trim();
  if (!normalized) return UNTITLED_SESSION_NAME;

  const titled = normalized.replace(/^[a-z]/, (letter) => letter.toUpperCase());
  if (Array.from(titled).length <= MAX_SESSION_NAME_LENGTH) return titled;

  const prefix = Array.from(titled)
    .slice(0, MAX_SESSION_NAME_LENGTH - 3)
    .join('')
    .trimEnd();
  const lastSpace = prefix.lastIndexOf(' ');
  const clipped =
    lastSpace >= Math.floor(MAX_SESSION_NAME_LENGTH * 0.55) ? prefix.slice(0, lastSpace) : prefix;
  return `${clipped}...`;
}

/** Keep internal session identifiers out of user-facing labels. */
export function displaySessionName(name?: string): string {
  return name?.trim() || UNTITLED_SESSION_NAME;
}
