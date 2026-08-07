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

  it('preserves the no-evidence warning alongside the recent tail', async () => {
    const runtime = new ZeroMemRuntime({
      loadModel: async () => loadedModel(),
      recentTailMessages: 1,
    });
    const fact = message('fact-1', 'The staging region is eu-west-1.', 1);
    const query = message('query-1', 'What is the staging database password?', 2);

    const prepared = await runtime.prepare({
      transcript: [fact, query],
      query: query.content,
      currentMessageId: query.id,
      sessionId: 'session-1',
    });

    expect(prepared.retrieval?.evidence).toEqual([]);
    expect(prepared.history[0]?.content).toContain(
      '[No admissible historical trace matched this query. Do not invent an answer.]',
    );
    expect(prepared.history[1]).toEqual(fact);
  });

  it('serializes overlapping transcript synchronizations', async () => {
    let releaseFirstEmbedding: (() => void) | undefined;
    let markFirstEmbeddingStarted: (() => void) | undefined;
    const firstEmbeddingStarted = new Promise<void>((resolve) => {
      markFirstEmbeddingStarted = resolve;
    });
    const firstEmbeddingGate = new Promise<void>((resolve) => {
      releaseFirstEmbedding = resolve;
    });
    let embedCalls = 0;
    const semantic = loadedModel();
    semantic.model = {
      name: 'serialized-zero-mem-runtime-test',
      async embed(texts) {
        embedCalls++;
        if (embedCalls === 1) {
          markFirstEmbeddingStarted?.();
          await firstEmbeddingGate;
        }
        return texts.map(vectorize);
      },
      async extractEntities(texts) {
        return texts.map(() => []);
      },
    };
    const runtime = new ZeroMemRuntime({ loadModel: async () => semantic });
    const first = message('fact-1', 'alpha fact.', 1);
    const second = message('fact-2', 'beta fact.', 2);
    const firstWarm = runtime.warm([first], 'session-1');

    await firstEmbeddingStarted;
    const secondWarm = runtime.warm([first, second], 'session-1');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(embedCalls).toBe(1);
    releaseFirstEmbedding?.();
    await expect(firstWarm).resolves.toMatchObject({ indexedMessages: 1 });
    await expect(secondWarm).resolves.toMatchObject({ indexedMessages: 2 });
    expect(embedCalls).toBe(2);
  });

  it('waits for active model work before disposing loaded pipelines', async () => {
    let releaseEmbedding: (() => void) | undefined;
    let markEmbeddingStarted: (() => void) | undefined;
    const embeddingStarted = new Promise<void>((resolve) => {
      markEmbeddingStarted = resolve;
    });
    const embeddingGate = new Promise<void>((resolve) => {
      releaseEmbedding = resolve;
    });
    const semantic = loadedModel();
    semantic.model = {
      name: 'dispose-zero-mem-runtime-test',
      async embed(texts) {
        markEmbeddingStarted?.();
        await embeddingGate;
        return texts.map(vectorize);
      },
      async extractEntities(texts) {
        return texts.map(() => []);
      },
    };
    const runtime = new ZeroMemRuntime({ loadModel: async () => semantic });
    const pendingWarm = runtime.warm([message('fact-1', 'alpha fact.', 1)], 'session-1');

    await embeddingStarted;
    const pendingDispose = runtime.dispose();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(semantic.dispose).not.toHaveBeenCalled();
    releaseEmbedding?.();
    await expect(pendingWarm).rejects.toThrow('Zero-Mem runtime was disposed.');
    await pendingDispose;
    expect(semantic.dispose).toHaveBeenCalledOnce();
  });

  it('disposes a model that resolves after the runtime is disposed', async () => {
    let resolveModel: ((model: LoadedPaperZeroMemModel) => void) | undefined;
    const loadModel = vi.fn(
      () =>
        new Promise<LoadedPaperZeroMemModel>((resolve) => {
          resolveModel = resolve;
        }),
    );
    const semantic = loadedModel();
    const runtime = new ZeroMemRuntime({ loadModel });
    const pendingWarm = runtime.warm(
      [message('fact-1', 'The launch color is crimson.', 1)],
      'session-1',
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resolveModel).toBeDefined();
    const pendingDispose = runtime.dispose();
    resolveModel!(semantic);

    await expect(pendingWarm).rejects.toThrow('Zero-Mem runtime was disposed.');
    await pendingDispose;
    expect(semantic.dispose).toHaveBeenCalledOnce();
    await expect(
      runtime.warm([message('fact-2', 'The release region is eu-west-1.', 2)], 'session-1'),
    ).rejects.toThrow('Zero-Mem runtime was disposed.');
  });
});
