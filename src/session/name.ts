/** Label used for a session before its first prompt has been recorded. */
export const UNTITLED_SESSION_NAME = 'Untitled session';

const MAX_SESSION_NAME_LENGTH = 56;

/** Return a compact, deterministic title suitable for user-facing session lists. */
export function deriveSessionName(prompt: string): string {
  const normalized = prompt
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[/!#>*_`~-]+\s*/, '')
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
