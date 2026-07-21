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
});
