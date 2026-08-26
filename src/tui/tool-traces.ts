import type { Message } from '../types/messages.js';
import type { NestedToolInvocation } from '../types/tools.js';
import { shouldDefaultExpandTool } from './tool-presentation.js';

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

export function countNestedToolInvocations(
  childrenByParent: NestedToolChildren,
  parentTraceId: string,
): number {
  let count = 0;
  const visited = new Set<string>();
  const stack = [...(childrenByParent.get(parentTraceId) ?? [])];
  while (stack.length > 0) {
    const invocation = stack.pop()!;
    if (visited.has(invocation.traceId)) continue;
    visited.add(invocation.traceId);
    count++;
    stack.push(...(childrenByParent.get(invocation.traceId) ?? []));
  }
  return count;
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

/** Select the newest action for explicit output expansion when none is active. */
export function selectLatestToolId(messages: readonly Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const nested = message.nestedToolInvocations ?? [];
    if (nested.length > 0) return nested[nested.length - 1].traceId;
    const calls = message.toolCalls ?? [];
    if (calls.length > 0) return calls[calls.length - 1].id;
  }
  return null;
}

/** Resolve the default expansion state used when a tool row is clicked. */
export function shouldDefaultExpandToolId(messages: readonly Message[], toolId: string): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;

    const nested = message.nestedToolInvocations?.find(
      (invocation) => invocation.traceId === toolId,
    );
    if (nested) return shouldDefaultExpandTool(nested.call.name, nested.result);

    const call = message.toolCalls?.find((candidate) => candidate.id === toolId);
    if (call) {
      const result = message.toolResults?.find((candidate) => candidate.toolCallId === toolId);
      return shouldDefaultExpandTool(call.name, result);
    }
  }

  return false;
}

/**
 * Select the one tool row whose body should be visible in the transcript.
 *
 * This selects the latest unfinished invocation. Completed file mutations use
 * the separate default-expansion policy in tool-presentation.
 */
export function selectExpandedToolId(messages: readonly Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const hasToolActivity =
      (message.toolCalls?.length ?? 0) > 0 || (message.nestedToolInvocations?.length ?? 0) > 0;
    if (!hasToolActivity) continue;
    const activeToolId = selectActiveToolId(message);
    if (activeToolId) return activeToolId;
  }

  return null;
}
