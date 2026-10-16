import { describe, expect, it } from 'vitest';
import {
  dedupeToolCallIds,
  renameToolUseBlocks,
  renderedToolCallIds,
  uniqueToolCallId,
} from './tool-call-ids.js';
import { assistantMsg, toolCall, toolResult, userMsg } from '../test/fixtures.js';
import type { Message } from '../types/messages.js';

const turn = (id: string, callId: string, content = 'ok'): Message => ({
  ...assistantMsg('', [toolCall(callId, 'Echo')], [toolResult(callId, content)]),
  id,
});

describe('uniqueToolCallId', () => {
  it('returns an unused id unchanged', () => {
    expect(uniqueToolCallId(new Set(['a']), 'b')).toBe('b');
  });

  it('appends the smallest unused suffix from 2', () => {
    expect(uniqueToolCallId(new Set(['call_1']), 'call_1')).toBe('call_1_2');
    expect(uniqueToolCallId(new Set(['call_1', 'call_1_2', 'call_1_3']), 'call_1')).toBe(
      'call_1_4',
    );
    expect(uniqueToolCallId(new Set(['call_1', 'call_1_3']), 'call_1')).toBe('call_1_2');
  });
});

describe('dedupeToolCallIds', () => {
  it('returns the same array when every id is unique', () => {
    const messages = [userMsg('hi'), turn('a1', 'x'), turn('a2', 'y')];
    expect(dedupeToolCallIds(messages)).toBe(messages);
  });

  it('keeps the first occurrence and renames a later call with its result', () => {
    const messages = [userMsg('hi'), turn('a1', 'call_1', 'one'), turn('a2', 'call_1', 'two')];
    const out = dedupeToolCallIds(messages);

    expect(out).not.toBe(messages);
    expect(out[1]).toBe(messages[1]);
    expect(out[2].toolCalls?.[0].id).toBe('call_1_2');
    expect(out[2].toolResults?.[0].toolCallId).toBe('call_1_2');
    expect(out[2].toolResults?.[0].content).toBe('two');
    // The input is never mutated: the session keeps what it persisted.
    expect(messages[2].toolCalls?.[0].id).toBe('call_1');
    expect(messages[2].toolResults?.[0].toolCallId).toBe('call_1');
  });

  it('is deterministic, so a rebuild renders the same ids', () => {
    const messages = [turn('a1', 'call_1'), turn('a2', 'call_1'), turn('a3', 'call_1')];
    const ids = (out: readonly Message[]) => out.map((m) => m.toolCalls?.[0].id);
    expect(ids(dedupeToolCallIds(messages))).toEqual(['call_1', 'call_1_2', 'call_1_3']);
    expect(ids(dedupeToolCallIds(messages))).toEqual(ids(dedupeToolCallIds(messages)));
  });

  it('does not hand out an id a later message really carries', () => {
    const messages = [turn('a1', 'call_1'), turn('a2', 'call_1'), turn('a3', 'call_1_2')];
    const ids = dedupeToolCallIds(messages).map((m) => m.toolCalls?.[0].id);
    expect(ids).toEqual(['call_1', 'call_1_3', 'call_1_2']);
  });

  it('pairs results with the right call when only one of several repeats', () => {
    const first = turn('a1', 'dup');
    const second: Message = {
      ...assistantMsg(
        '',
        [toolCall('fresh', 'Echo'), toolCall('dup', 'Echo')],
        [toolResult('fresh', 'f'), toolResult('dup', 'd')],
      ),
      id: 'a2',
    };
    const out = dedupeToolCallIds([first, second]);
    expect(out[1].toolCalls?.map((c) => c.id)).toEqual(['fresh', 'dup_2']);
    expect(out[1].toolResults?.map((r) => [r.toolCallId, r.content])).toEqual([
      ['fresh', 'f'],
      ['dup_2', 'd'],
    ]);
  });

  it('renames the tool_use blocks a provider replays verbatim', () => {
    const blocks = [
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 'dup', name: 'Echo', input: {} },
    ];
    const second: Message = {
      ...turn('a2', 'dup'),
      providerMetadata: { anthropicContentBlocks: blocks },
    };
    const out = dedupeToolCallIds([turn('a1', 'dup'), second]);
    expect(out[1].providerMetadata?.anthropicContentBlocks).toEqual([
      blocks[0],
      { type: 'tool_use', id: 'dup_2', name: 'Echo', input: {} },
    ]);
    expect(blocks[1].id).toBe('dup');
  });

  it('ignores messages that are not sent to the model', () => {
    const hidden: Message = { ...turn('a1', 'call_1'), includeInContext: false };
    const messages = [hidden, turn('a2', 'call_1')];
    expect(dedupeToolCallIds(messages)).toBe(messages);
  });
});

describe('renderedToolCallIds', () => {
  it('lists the ids as they are rendered, renames included', () => {
    const ids = renderedToolCallIds([turn('a1', 'call_1'), turn('a2', 'call_1')]);
    expect([...ids].sort()).toEqual(['call_1', 'call_1_2']);
  });
});

describe('renameToolUseBlocks', () => {
  it('returns the same metadata when there is nothing to rename', () => {
    const metadata = { anthropicContentBlocks: [{ type: 'tool_use', id: 'a' }] };
    expect(renameToolUseBlocks(metadata, new Map())).toBe(metadata);
    expect(renameToolUseBlocks(metadata, new Map([['b', 'c']]))).toBe(metadata);
    expect(renameToolUseBlocks(undefined, new Map([['a', 'b']]))).toBeUndefined();
  });
});
