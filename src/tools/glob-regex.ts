/**
 * Convert a glob pattern to a regex. Supports * (any chars) and ** (same as *).
 * The pattern is anchored at both ends (^...$).
 */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}
