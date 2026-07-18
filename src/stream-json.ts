/**
 * Shared stream-json parsing utilities.
 *
 * Both `sdk.ts` (query() generator) and `headless.ts` (stream-json output mode)
 * parse the same newline-delimited JSON format. This module provides a unified
 * parser that both consumers can use.
 */

/** Known event types in the stream-json wire format. */
export type StreamJsonEvent =
  | { type: 'system'; model?: string; cwd?: string }
  | { type: 'session'; session_id?: string }
  | { type: 'assistant'; text?: string }
  | { type: 'tool_use'; tool_call?: unknown }
  | { type: 'tool_result'; tool_result?: unknown }
  | { type: 'user_question'; request?: unknown; status?: 'pending' | 'unavailable' }
  | { type: 'user_question_result'; request_id?: string; response?: unknown }
  | { type: 'error'; error?: string }
  | { type: 'result'; result?: unknown }
  | { type: 'done' };

/**
 * Parse a single line of stream-json output into a typed event.
 * Returns `null` for empty lines or unparseable JSON.
 */
export function parseStreamLine(line: string): StreamJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
      return parsed as StreamJsonEvent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Create a stream-json line parser that buffers partial lines and emits
 * complete events. Suitable for use with a readable stream's 'data' events.
 *
 * Returns an object with a `feed(chunk)` method and a `flush()` method
 * to emit any remaining buffered data.
 */
export function createStreamParser(onEvent: (event: StreamJsonEvent) => void) {
  let buffer = '';

  return {
    feed(chunk: string | Buffer): void {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      // Keep the last (potentially incomplete) line in the buffer.
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const event = parseStreamLine(line);
        if (event) onEvent(event);
      }
    },

    flush(): void {
      if (buffer.trim()) {
        const event = parseStreamLine(buffer);
        if (event) onEvent(event);
        buffer = '';
      }
    },
  };
}
