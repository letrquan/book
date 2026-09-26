import { describe, expect, it } from 'vitest';
import { extractJsonObject, parseJsonObject } from './json.js';

describe('extractJsonObject', () => {
  it('reads the first JSON object out of a json fence', () => {
    expect(extractJsonObject('```json\n{"a": 1}\n```')).toBe('{"a": 1}');
    expect(extractJsonObject('sure:\n```\n{"a": 1}\n```\ndone')).toBe('{"a": 1}');
  });

  it('does not let a ``` run inside a JSON string end the fence early (#299)', () => {
    // A memory body quoting a fenced code block: the lazy fence match cut the
    // candidate at the run inside the string, the truncated text never balanced,
    // and memory extraction marked the session unparseable and moved on.
    const body = 'run this:\n```bash\nnpm test\n```\nthen stop';
    const json = JSON.stringify({
      memories: [{ action: 'create', type: 'project', title: 't', body }],
    });
    const reply = '```json\n' + json + '\n```';

    expect(extractJsonObject(reply)).toBe(json);
    expect(parseJsonObject(reply)).toEqual({
      memories: [{ action: 'create', type: 'project', title: 't', body }],
    });
  });

  it('finds the object in unfenced text whose strings hold ``` runs', () => {
    // The first ``` run the regex sees is inside the string, so the fenced
    // candidate is `ts\nx\n` — no object in it. The whole text still holds one.
    const json = JSON.stringify({ body: 'see ```ts\nx\n```' });
    expect(parseJsonObject(json)).toEqual({ body: 'see ```ts\nx\n```' });
  });

  it('still prefers the fenced object over an example ahead of it', () => {
    const reply = 'Like {"not": "this"}:\n```json\n{"a": 1}\n```';
    expect(parseJsonObject(reply)).toEqual({ a: 1 });
  });

  it('returns undefined when no complete object is there', () => {
    expect(extractJsonObject('no json here')).toBeUndefined();
    expect(extractJsonObject('{"a": ')).toBeUndefined();
    expect(extractJsonObject('```json\n{"a": ')).toBeUndefined();
  });
});
