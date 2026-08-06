import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../types/messages.js';
import type { LoadedPaperZeroMemModel } from './zero-mem-models.js';
import { ZeroMemRuntime } from './zero-mem-runtime.js';
import type { ZeroMemSemanticModel } from './zero-mem.js';

function message(id: string, content: string, timestamp: number, role: Message['role'] = 'user') {
  return { id, content, timestamp, role, includeInContext: true } satisfies Message;
}

function vectorize(value: string): Float32Array {
  const vector = new Float32Array(32);
  for (const token of value.toLowerCase().match(/[a-z0-9-]+/g) ?? []) {
    let hash = 0;
    for (const character of token) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    vector[hash % vector.length] += 1;
  }
  return vector;
}

function loadedModel(): LoadedPaperZeroMemModel {
  const model: ZeroMemSemanticModel = {
    name: 'zero-mem-runtime-test',
    async embed(texts) {
      return texts.map(vectorize);
    },
    async extractEntities(texts) {
      return texts.map((text) => text.match(/\b[A-Z][A-Za-z0-9-]+\b/g) ?? []);
    },
  };
  return {
    model,
    loadMs: 7,
    cacheDir: 'test-cache',
    embeddingModel: 'test-embedding',
    nerModel: 'test-ner',
    dispose: vi.fn(async () => {}),
  };
}

describe('ZeroMemRuntime', () => {
  it('loads once and incrementally adds completed transcript messages', async () => {
    const semantic = loadedModel();
    const loadModel = vi.fn(async () => semantic);
    const runtime = new ZeroMemRuntime({ loadModel, recentTailMessages: 0 });
    const first = message('fact-1', 'The launch color is crimson.', 1);
    const current = message('query-1', 'What is the launch color?', 2);

    const initial = await runtime.prepare({
      transcript: [first, current],
      query: current.content,
      currentMessageId: current.id,
      sessionId: 'session-1',
    });
    expect(initial.history[0]?.content).toContain('crimson');

    const secondFact = message('fact-2', 'The release region is eu-west-1.', 3, 'assistant');
    const nextQuery = message('query-2', 'Which release region is active?', 4);
    const next = await runtime.prepare({
      transcript: [first, current, secondFact, nextQuery],
      query: nextQuery.content,
      currentMessageId: nextQuery.id,
      sessionId: 'session-1',
    });

    expect(loadModel).toHaveBeenCalledOnce();
    expect(next.indexedMessages).toBe(3);
    expect(next.history[0]?.content).toContain('eu-west-1');
  });

  it('does not load semantic models for an empty transcript', async () => {
    const loadModel = vi.fn(async () => loadedModel());
    const runtime = new ZeroMemRuntime({ loadModel });

    await expect(runtime.warm([], 'session-1')).resolves.toMatchObject({ indexedMessages: 0 });
    expect(loadModel).not.toHaveBeenCalled();
  });
});
