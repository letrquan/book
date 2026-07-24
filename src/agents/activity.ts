import type { ToolCall, ToolResult } from '../types/tools.js';

const SENSITIVE_KEY = /(?:api[-_]?key|authorization|cookie|password|secret|token)/i;
const RESULT_PREVIEW_CHARS = 240;

function redactValue(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

export function redactToolCallForDisplay(toolCall: ToolCall): ToolCall {
  return {
    ...toolCall,
    arguments: redactValue(toolCall.arguments) as Record<string, unknown>,
  };
}

function compactPreview(value: string | undefined): string {
  const line = value
    ?.split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find(Boolean);
  if (!line) return '';
  const compact = line.replace(/\s+/g, ' ');
  return compact.length <= RESULT_PREVIEW_CHARS
    ? compact
    : `${compact.slice(0, RESULT_PREVIEW_CHARS - 3).trimEnd()}...`;
}

/** Keep realtime activity events small while preserving useful tool-row semantics. */
export function projectToolResultForDisplay(result: ToolResult): ToolResult {
  const presentation = result.presentation
    ? {
        ...result.presentation,
        details: compactPreview(result.presentation.details),
      }
    : undefined;
  return {
    version: 2,
    toolCallId: result.toolCallId,
    status: result.status,
    content: compactPreview(result.content),
    structuredError: result.structuredError
      ? {
          code: result.structuredError.code,
          message: compactPreview(result.structuredError.message),
          retryable: result.structuredError.retryable,
          remediation: compactPreview(result.structuredError.remediation) || undefined,
        }
      : undefined,
    presentation,
    metrics: result.metrics,
    artifacts: result.artifacts?.fileMutation
      ? { fileMutation: result.artifacts.fileMutation }
      : undefined,
    pagination: result.pagination,
  };
}
