import { describe, expect, it } from 'vitest';
import { createStreamParser, parseStreamLineDetailed } from './stream-json.js';

describe('createStreamParser', () => {
  it('produces identical events for fragmented chunks, CRLF, and multiple lines', () => {
    const events: unknown[] = [];
    const parser = createStreamParser((event) => events.push(event));
    parser.feed('{"type":"user","content":"one"}\r\n{"type":"assis');
    parser.feed('tant","text":"two"}\n{"type":"done"}');
    parser.flush();

    expect(events).toEqual([
      { type: 'user', content: 'one' },
      { type: 'assistant', text: 'two' },
      { type: 'done' },
    ]);
  });

  it('reports invalid JSON, invalid shapes, and oversized records', () => {
    const diagnostics: string[] = [];
    const parser = createStreamParser(() => {}, {
      maxBufferedLineBytes: 20,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });
    parser.feed('{bad}\n{"type":"unknown"}\n');
    parser.feed('{"type":"assistant","text":"too long"}\n{"type":"done"}\n');

    expect(diagnostics).toEqual(['invalid-json', 'invalid-shape', 'oversized-line']);
  });

  it('validates input-specific required fields', () => {
    expect(parseStreamLineDetailed('{"type":"user"}').diagnostic?.code).toBe('invalid-shape');
  });

  it.each([
    { type: 'agent_status', agent: { agentId: 'a1' } },
    { type: 'agent_activity', agentId: 'a1', activity: { id: 'activity' } },
    { type: 'agent_text_delta', agentId: 'a1', text: 'delta' },
    { type: 'agent_message', agentId: 'a1', message: { id: 'message' } },
    { type: 'agent_permission', agentId: 'a1', request: { id: 'permission' } },
    { type: 'agent_question', agentId: 'a1', request: { id: 'question' } },
  ])('parses managed-agent event $type', (event) => {
    expect(parseStreamLineDetailed(JSON.stringify(event))).toEqual({ event });
  });
});
