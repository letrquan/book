/** Known event types in the stream-json wire format. */
export type StreamJsonEvent =
  | { type: 'user'; content: string }
  | { type: 'system'; model?: string; cwd?: string; [key: string]: unknown }
  | { type: 'session'; session_id?: string }
  | { type: 'assistant'; text?: string }
  | { type: 'tool_use'; tool_call?: unknown }
  | { type: 'tool_result'; tool_result?: unknown }
  | { type: 'user_question'; request?: unknown; status?: 'pending' | 'unavailable' }
  | { type: 'user_question_result'; request_id?: string; response?: unknown }
  | { type: 'agent_start' | 'agent_update' | 'agent_result'; agent?: unknown }
  | { type: 'agent_question'; agentId?: string; request?: unknown }
  | { type: 'agent_status'; agent?: unknown }
  | { type: 'agent_activity'; agentId?: string; activity?: unknown }
  | { type: 'agent_text_delta'; agentId?: string; text?: string }
  | { type: 'agent_message'; agentId?: string; message?: unknown }
  | { type: 'agent_completion'; notification?: unknown }
  | { type: 'agent_permission'; agentId?: string; request?: unknown }
  | { type: 'evidence_update'; evidence?: unknown }
  | { type: 'agent_apply'; agentId?: string; evidenceId?: string; status?: string }
  | { type: 'hook_event'; event?: string; [key: string]: unknown }
  | { type: 'mode_change'; mode?: string }
  | { type: 'plan_approval'; status?: string }
  | { type: 'prompt_suggestions'; suggestions?: string[] }
  | { type: 'error'; error?: string }
  | { type: 'result'; result?: unknown }
  | { type: 'done' };

export type StreamJsonDiagnosticCode = 'invalid-json' | 'invalid-shape' | 'oversized-line';

export interface StreamJsonDiagnostic {
  code: StreamJsonDiagnosticCode;
  message: string;
  line?: string;
}

export interface StreamParserOptions {
  maxBufferedLineBytes?: number;
  onDiagnostic?: (diagnostic: StreamJsonDiagnostic) => void;
}

const EVENT_TYPES = new Set<StreamJsonEvent['type']>([
  'user',
  'system',
  'session',
  'assistant',
  'tool_use',
  'tool_result',
  'user_question',
  'user_question_result',
  'agent_start',
  'agent_update',
  'agent_result',
  'agent_question',
  'agent_status',
  'agent_activity',
  'agent_text_delta',
  'agent_message',
  'agent_completion',
  'agent_permission',
  'evidence_update',
  'agent_apply',
  'hook_event',
  'mode_change',
  'plan_approval',
  'prompt_suggestions',
  'error',
  'result',
  'done',
]);

const DEFAULT_MAX_BUFFERED_LINE_BYTES = 1024 * 1024;

export function parseStreamLineDetailed(line: string): {
  event?: StreamJsonEvent;
  diagnostic?: StreamJsonDiagnostic;
} {
  const trimmed = line.trim();
  if (!trimmed) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      diagnostic: {
        code: 'invalid-json',
        message: `Invalid stream-json record: ${error instanceof Error ? error.message : String(error)}`,
        line: trimmed,
      },
    };
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !('type' in parsed) ||
    typeof parsed.type !== 'string' ||
    !EVENT_TYPES.has(parsed.type as StreamJsonEvent['type']) ||
    (parsed.type === 'user' && typeof (parsed as { content?: unknown }).content !== 'string')
  ) {
    return {
      diagnostic: {
        code: 'invalid-shape',
        message: 'Stream-json records must be objects with a supported type and valid fields.',
        line: trimmed,
      },
    };
  }

  return { event: parsed as StreamJsonEvent };
}

export function parseStreamLine(line: string): StreamJsonEvent | null {
  return parseStreamLineDetailed(line).event ?? null;
}

export function createStreamParser(
  onEvent: (event: StreamJsonEvent) => void,
  options: StreamParserOptions = {},
) {
  const maxBufferedLineBytes = options.maxBufferedLineBytes ?? DEFAULT_MAX_BUFFERED_LINE_BYTES;
  if (!Number.isSafeInteger(maxBufferedLineBytes) || maxBufferedLineBytes < 1) {
    throw new Error('maxBufferedLineBytes must be a positive safe integer');
  }

  let buffer = '';
  let discardingOversizedLine = false;

  const emitLine = (line: string): void => {
    const { event, diagnostic } = parseStreamLineDetailed(line.replace(/\r$/, ''));
    if (event) onEvent(event);
    if (diagnostic) options.onDiagnostic?.(diagnostic);
  };

  const append = (segment: string, terminated: boolean): void => {
    if (discardingOversizedLine) {
      if (terminated) discardingOversizedLine = false;
      return;
    }

    if (Buffer.byteLength(buffer) + Buffer.byteLength(segment) > maxBufferedLineBytes) {
      buffer = '';
      options.onDiagnostic?.({
        code: 'oversized-line',
        message: `Stream-json record exceeds the ${maxBufferedLineBytes}-byte limit.`,
      });
      discardingOversizedLine = !terminated;
      return;
    }

    buffer += segment;
    if (terminated) {
      emitLine(buffer);
      buffer = '';
    }
  };

  return {
    feed(chunk: string | Buffer): void {
      const segments = chunk.toString().split('\n');
      for (let index = 0; index < segments.length; index++) {
        append(segments[index] ?? '', index < segments.length - 1);
      }
    },

    flush(): void {
      if (!discardingOversizedLine && buffer.length > 0) emitLine(buffer);
      buffer = '';
      discardingOversizedLine = false;
    },
  };
}
