import type { Message, NestedToolInvocation } from '../types.js';

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
