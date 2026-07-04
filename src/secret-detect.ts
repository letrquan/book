/**
 * Shared secret / high-entropy text detector.
 *
 * Used by the memory auto-capture path to avoid persisting secrets as memory
 * candidates. Intended to be reused by future log redactors and tool-output
 * scrubbers so the pattern list lives in one place.
 */

export const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(api[_-]?key|token|password|passwd|secret)\s*[:=]\s*\S{8,}/i,
  /https?:\/\/[^\s/]+:[^\s/]+@/i,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
];

/**
 * Returns a short reason string when `text` looks like a secret or is
 * otherwise unfit to persist, or `null` when the text is acceptable.
 */
export function looksLikeSecretOrUnfit(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'empty';
  if (SECRET_PATTERNS.some((re) => re.test(trimmed))) return 'looks like a secret';
  const longTokens = trimmed.match(/[A-Za-z0-9+/=_-]{48,}/g) ?? [];
  if (longTokens.some((token) => new Set(token).size > 20)) return 'contains high-entropy text';
  return null;
}
