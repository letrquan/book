import type { Message, NestedToolInvocation } from '../types.js';
import { isRenderableFileMutationDiff } from './file-mutation-display.js';

export type NestedToolChildren = ReadonlyMap<string, readonly NestedToolInvocation[]>;

export function indexNestedToolInvocations(
  invocations: readonly NestedToolInvocation[],
): Map<string, NestedToolInvocation[]> {
  const children = new Map<string, NestedToolInvocation[]>();
  for (const invocation of invocations) {
    const siblings = children.get(invocation.parentTraceId);
    if (siblings) siblings.push(invocation);
    else children.set(invocation.parentTraceId, [invocation]);
  }
  return children;
}

function selectCompletedFileMutationId(message: Message): string | null {
  const resultsById = new Map(
    (message.toolResults ?? []).map((result) => [result.toolCallId, result] as const),
  );
  const completed: Array<{ id: string; toolName: string; result: NestedToolInvocation['result'] }> =
    [
      ...(message.toolCalls ?? []).map((call) => ({
        id: call.id,
        toolName: call.name,
        result: resultsById.get(call.id),
      })),
      ...(message.nestedToolInvocations ?? []).map((invocation) => ({
        id: invocation.traceId,
        toolName: invocation.call.name,
        result: invocation.result,
      })),
    ];

  for (let index = completed.length - 1; index >= 0; index--) {
    const invocation = completed[index];
    if (isRenderableFileMutationDiff(invocation.toolName, invocation.result)) return invocation.id;
  }

  return null;
}

export function selectActiveToolId(message: Message | undefined): string | null {
  if (!message || message.role !== 'assistant') return null;

  const nested = message.nestedToolInvocations ?? [];
  for (let index = nested.length - 1; index >= 0; index--) {
    if (!nested[index].result) return nested[index].traceId;
  }

  const calls = message.toolCalls ?? [];
  const results = new Set((message.toolResults ?? []).map((result) => result.toolCallId));
  for (let index = calls.length - 1; index >= 0; index--) {
    if (!results.has(calls[index].id)) return calls[index].id;
  }

  return null;
}

/**
 * Select the one tool row whose body should be visible in the transcript.
 *
 * Running tools win. Once every invocation is terminal, keep the newest
 * successful file mutation from the latest tool-bearing assistant turn open as
 * a bounded diff preview. Text-only follow-up turns do not hide that preview.
 */
export function selectExpandedToolId(messages: readonly Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const hasToolActivity =
      (message.toolCalls?.length ?? 0) > 0 || (message.nestedToolInvocations?.length ?? 0) > 0;
    if (!hasToolActivity) continue;
    return selectActiveToolId(message) ?? selectCompletedFileMutationId(message);
  }

  return null;
}
