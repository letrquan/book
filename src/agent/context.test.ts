import { describe, it, expect } from 'vitest';
import { buildMessages } from './context.js';
import { userMsg, assistantMsg, toolCall, toolResult, defaultConfig } from '../test/fixtures.js';

const config = defaultConfig();

describe('buildMessages', () => {
  it('emits tool_calls on assistant messages and a tool role message per result', () => {
    const tc = toolCall('call_1', 'read_file', { filePath: 'a.ts' });
    const tr = toolResult('call_1', '1: hi');
    const history = [
      userMsg('read a.ts'),
      assistantMsg('Reading...', [tc], [tr]),
    ];

    const out = buildMessages(config, history, []);

    // [0] system, [1] user, [2] assistant (content + tool_calls), [3] tool result
    expect(out[2].role).toBe('assistant');
    expect(out[2].tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"filePath":"a.ts"}' },
      },
    ]);
    expect(out[3].role).toBe('tool');
    expect(out[3].tool_call_id).toBe('call_1');
    expect(out[3].content).toBe('1: hi');
  });

  it('keeps tool messages in call order when a turn has multiple tool calls', () => {
    const t1 = toolCall('c1', 'bash', { command: 'ls' });
    const t2 = toolCall('c2', 'bash', { command: 'pwd' });
    const r1 = toolResult('c1', 'a\nb');
    const r2 = toolResult('c2', '/x');
    const history = [userMsg('go'), assistantMsg('', [t1, t2], [r1, r2])];

    const out = buildMessages(config, history, []);
    expect(
      out.filter((m) => m.role === 'tool').map((m) => m.tool_call_id),
    ).toEqual(['c1', 'c2']);
  });

  it('omits tool_calls when an assistant message has none', () => {
    const history = [userMsg('hi'), assistantMsg('hello')];
    const out = buildMessages(config, history, []);
    expect(out[2].tool_calls).toBeUndefined();
    expect(out.find((m) => m.role === 'tool')).toBeUndefined();
  });
});
