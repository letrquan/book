import { describe, expect, it } from 'vitest';
import type { Message } from '../../types.js';
import {
  advanceStaticHandoff,
  assertDisjointZones,
  createStaticHandoffState,
  isBlankAssistantContent,
  mergeAssistantMessages,
  partitionMessageZones,
  syncStaticHandoff,
} from './static-handoff.js';

function msg(id: string, role: 'user' | 'assistant', content: string): Message {
  return { id, role, content, timestamp: 1 };
}

describe('static-handoff pure helpers', () => {
  it('treats whitespace-only assistant text as empty', () => {
    expect(isBlankAssistantContent('')).toBe(true);
    expect(isBlankAssistantContent('   \n\t  ')).toBe(true);
    expect(isBlankAssistantContent('hello')).toBe(false);
  });

  it('merges whitespace-only tool-only assistant turns into the prior message', () => {
    const messages: Message[] = [
      msg('a1', 'assistant', 'I will inspect.'),
      {
        ...msg('a2', 'assistant', '  \n'),
        toolCalls: [{ id: 'c1', name: 'Read', arguments: { filePath: 'a.ts' } }],
        toolResults: [{ toolCallId: 'c1', success: true, output: 'ok' }],
      },
    ];
    const merged = mergeAssistantMessages(messages);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('a1');
    expect(merged[0].toolCalls).toHaveLength(1);
    expect(merged[0].toolResults).toHaveLength(1);
  });

  it('does not merge streaming or withheld ids during display merge', () => {
    const messages: Message[] = [
      msg('a1', 'assistant', 'base'),
      {
        ...msg('a2', 'assistant', ''),
        toolCalls: [{ id: 'c1', name: 'Read', arguments: { filePath: 'a.ts' } }],
      },
      {
        ...msg('a3', 'assistant', ''),
        toolCalls: [{ id: 'c2', name: 'Read', arguments: { filePath: 'b.ts' } }],
      },
    ];
    const merged = mergeAssistantMessages(messages, 'a2', new Set(['a3']));
    expect(merged.map((m) => m.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('withholds previous streaming id immediately on sync', () => {
    let state = createStaticHandoffState('a1');
    const ids = new Set(['a1', 'a2']);
    state = syncStaticHandoff(state, 'a2', ids);
    expect(state.observedStreamingId).toBe('a2');
    expect(state.withheldQueue).toEqual(['a1']);
  });

  it('releases one id per advance after the gap frame (FIFO)', () => {
    let state = createStaticHandoffState('a1');
    const ids = new Set(['a1', 'a2', 'a3']);
    state = syncStaticHandoff(state, 'a2', ids);
    state = syncStaticHandoff(state, 'a3', ids);
    expect(state.withheldQueue).toEqual(['a1', 'a2']);

    // Gap frame already painted with both withheld; each advance releases one head.
    state = advanceStaticHandoff(state);
    expect(state.withheldQueue).toEqual(['a2']);

    state = advanceStaticHandoff(state);
    expect(state.withheldQueue).toEqual([]);
  });

  it('keeps active/withheld/static zones disjoint for rapid A→B→C', () => {
    let state = createStaticHandoffState('a1');
    const messageIds = ['a1', 'a2', 'a3'];
    const idSet = new Set(messageIds);

    state = syncStaticHandoff(state, 'a2', idSet);
    state = syncStaticHandoff(state, 'a3', idSet);

    const zones = partitionMessageZones(messageIds, 'a3', state.withheldQueue);
    expect(zones.activeId).toBe('a3');
    expect([...zones.withheldIds]).toEqual(['a1', 'a2']);
    expect([...zones.staticIds]).toEqual([]);
    expect(assertDisjointZones(zones)).toBe(true);

    state = advanceStaticHandoff(state);
    const afterA = partitionMessageZones(messageIds, 'a3', state.withheldQueue);
    expect([...afterA.withheldIds]).toEqual(['a2']);
    expect([...afterA.staticIds]).toEqual(['a1']);
    expect(assertDisjointZones(afterA)).toBe(true);

    state = advanceStaticHandoff(state);
    const afterB = partitionMessageZones(messageIds, 'a3', state.withheldQueue);
    expect([...afterB.withheldIds]).toEqual([]);
    expect([...afterB.staticIds].sort()).toEqual(['a1', 'a2']);
    expect(assertDisjointZones(afterB)).toBe(true);
  });

  it('prunes withheld ids that disappear from messages', () => {
    let state = createStaticHandoffState('a1');
    state = syncStaticHandoff(state, 'a2', new Set(['a1', 'a2']));
    expect(state.withheldQueue).toEqual(['a1']);
    state = syncStaticHandoff(state, 'a2', new Set(['a2']));
    expect(state.withheldQueue).toEqual([]);
  });
});
