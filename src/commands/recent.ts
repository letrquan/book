/**
 * Session-level recently-used command tracker.
 *
 * Tracks how many times each command has been invoked via `/` in the current
 * session. Used to surface frequently-used commands at the top of the `/`
 * autocomplete when the user types an empty query.
 */

const usage = new Map<string, number>();

export function recordCommandUse(name: string): void {
  usage.set(name, (usage.get(name) ?? 0) + 1);
}

export function getRecentCommands(limit = 5): string[] {
  return Array.from(usage.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}
