import type { Message } from '../types/messages.js';

const STARTUP_NOTICE_ID_PREFIX = 'startup-notice-';

/**
 * The launch's warnings as local transcript rows. They live only in the in-memory transcript:
 * never written to the session file (a resumed session would otherwise replay the notices of the
 * launch that wrote them) and never in the model's context (`includeInContext: false`).
 */
export function startupNoticeMessages(
  lines: readonly string[],
  timestamp: number = Date.now(),
): Message[] {
  return lines.map((content, index) => ({
    id: `${STARTUP_NOTICE_ID_PREFIX}${index}`,
    role: 'assistant' as const,
    content,
    includeInContext: false,
    kind: 'local' as const,
    timestamp,
  }));
}

export function isStartupNotice(entry: unknown): boolean {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'role' in entry &&
    'id' in entry &&
    typeof entry.id === 'string' &&
    entry.id.startsWith(STARTUP_NOTICE_ID_PREFIX)
  );
}
