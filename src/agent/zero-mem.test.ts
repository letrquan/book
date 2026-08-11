import { describe, expect, it } from 'vitest';
import type { Message } from '../types/messages.js';
import { ZeroMemIndex, buildZeroMemHistory, type ZeroMemSemanticModel } from './zero-mem.js';

function message(
  id: string,
  content: string,
  timestamp: number,
  role: Message['role'] = 'user',
): Message {
  return {
    id,
    role,
    content,
    includeInContext: true,
    kind: 'conversation',
    timestamp,
  };
}

const aliases = new Map([
  ['automobile', 'vehicle'],
  ['car', 'vehicle'],
  ['crimson', 'red'],
  ['color', 'red'],
  ['milliseconds', 'duration-unit'],
  ['seconds', 'duration-unit'],
]);

function hash(value: string): number {
  let result = 2_166_136_261;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16_777_619);
  }
  return (result >>> 0) % 128;
}

function vectorize(value: string): Float32Array {
  const vector = new Float32Array(128);
  for (const raw of value.toLocaleLowerCase().match(/[a-z0-9._:/()-]+/g) ?? []) {
    const token = aliases.get(raw) ?? raw;
    vector[hash(token)] += 1;
  }
  let norm = 0;
  for (const item of vector) norm += item * item;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let index = 0; index < vector.length; index++) vector[index] /= norm;
  return vector;
}

function semanticModel(): ZeroMemSemanticModel {
  return {
    name: 'deterministic-test-semantic-model',
    async embed(texts) {
      return texts.map(vectorize);
    },
    async extractEntities(texts) {
      return texts.map((text) => {
        const entities = [
          ...(text.match(/\b(?:Alice|Redis|API|Project Zephyr|Wednesday|Thursday)\b/g) ?? []),
          ...(text.match(/\b[A-Za-z][A-Za-z0-9]*(?:[._:/()-][A-Za-z0-9]+)+\b/g) ?? []),
        ];
        return [...new Set(entities)];
      });
    },
  };
}

describe('Zero-Mem paper-aligned prototype', () => {
  it('uses semantic embeddings for vocabulary-mismatched retrieval', async () => {
    const history = [
      message('vehicle', 'The automobile selected for launch was crimson.', 1),
      message('unrelated', 'The database backup completed on Thursday.', 2),
    ];
    const index = await ZeroMemIndex.create(history, {
      semanticModel: semanticModel(),
      topK: 1,
      closureK: 0,
    });
    const result = await index.retrieve('What color was the car?');

    expect(result.evidence.map((item) => item.message.id)).toEqual(['vehicle']);
    expect(result.evidence[0]?.reasons).toContain('bge-m3-match');
  });

  it('incrementally indexes new trace messages', async () => {
    const index = await ZeroMemIndex.create(
      [message('initial', 'The database backup completed on Thursday.', 1)],
      { semanticModel: semanticModel(), topK: 1, closureK: 0 },
    );

    await expect(
      index.append([message('vehicle', 'The automobile selected for launch was crimson.', 2)]),
    ).resolves.toBe(1);
    const result = await index.retrieve('What color was the car?');

    expect(result.evidence.map((item) => item.message.id)).toEqual(['vehicle']);
    expect(index.diagnostics().episodes.map((item) => item.messageId)).toEqual([
      'initial',
      'vehicle',
    ]);
  });

  it('links existing entities to incrementally indexed sentences', async () => {
    const index = await ZeroMemIndex.create([message('owner', 'Alice owns Project Zephyr.', 1)], {
      semanticModel: semanticModel(),
      topK: 2,
      closureK: 1,
    });

    await index.append([message('storage', 'Project Zephyr uses Redis for storage.', 2)]);
    const result = await index.retrieve('Which storage system is connected to Alice?');

    expect(result.evidence.map((item) => item.message.id)).toEqual(
      expect.arrayContaining(['owner', 'storage']),
    );
  });

  it('implements occurrence-frequency entity weights and paper gamma', async () => {
    const index = await ZeroMemIndex.create(
      [message('weighted', 'Redis, Redis, Redis, and API.', 1)],
      { semanticModel: semanticModel() },
    );
    const diagnostics = index.diagnostics();
    const redis = diagnostics.entityContextWeights.find((item) => item.entity === 'Redis');
    const api = diagnostics.entityContextWeights.find((item) => item.entity === 'API');

    expect(diagnostics.gamma).toBe(0.6);
    expect(redis?.weight).toBeCloseTo(0.75);
    expect(api?.weight).toBeCloseTo(0.25);
  });

  it('recovers distributed relational evidence through entity co-occurrence', async () => {
    const history = [
      message('owner', 'Alice owns Project Zephyr.', 1),
      message('storage', 'Project Zephyr uses Redis for storage.', 2),
      message('noise', 'The garden roses bloom in spring.', 3),
    ];
    const index = await ZeroMemIndex.create(history, {
      semanticModel: semanticModel(),
      topK: 2,
      closureK: 1,
    });
    const result = await index.retrieve('Which storage system is connected to Alice?');

    expect(result.profile.route).toBe('relational');
    expect(result.evidence.map((item) => item.message.id)).toEqual(
      expect.arrayContaining(['owner', 'storage']),
    );
  });

  it('keeps relational queries graph-first when scoped to a session', async () => {
    const index = await ZeroMemIndex.create(
      [
        message('owner', 'Alice owns Project Zephyr.', 1),
        message('storage', 'Project Zephyr uses Redis for storage.', 2),
      ],
      {
        semanticModel: semanticModel(),
        traceMetadata: {
          owner: { sessionId: 'session-a' },
          storage: { sessionId: 'session-a' },
        },
        topK: 2,
        closureK: 1,
      },
    );

    const result = await index.retrieve('Which storage system is connected to Alice?', {
      sessionId: 'session-a',
    });

    expect(result.profile.route).toBe('relational');
    expect(result.evidence.map((item) => item.message.id)).toEqual(
      expect.arrayContaining(['owner', 'storage']),
    );
  });

  it('routes singular rejection questions with a why-clause as explanations', async () => {
    const index = await ZeroMemIndex.create(
      [message('decision', 'Redis was rejected because the benchmark must work offline.', 1)],
      { semanticModel: semanticModel() },
    );
    const result = await index.retrieve('Which proposed dependency was rejected, and why?');

    expect(result.profile.answerType).toBe('explanation');
  });

  it('keeps every question in a multi-question retrieval query', async () => {
    const query = 'What is the region? Which database was selected?';
    const index = await ZeroMemIndex.create(
      [
        message('region', 'The selected region is eu-west-1.', 1),
        message('database', 'The selected database is PostgreSQL.', 2),
      ],
      { semanticModel: semanticModel(), topK: 2, closureK: 0 },
    );

    const result = await index.retrieve(query);

    expect(result.query).toBe(query);
    expect(result.profile.keywords).toEqual(expect.arrayContaining(['region', 'database']));
  });

  it('enforces query boundaries and builds semantic episodes inside them', async () => {
    const history = [
      message('old', 'The cache uses Redis for workspace keys.', 1),
      message('related', 'Redis persists the cache keys between runs.', 2),
      message('new', 'The garden roses are crimson.', 3),
    ];
    const index = await ZeroMemIndex.create(history, {
      semanticModel: semanticModel(),
      traceMetadata: {
        old: { sessionId: 'session-a', boundaryId: 'old' },
        related: { sessionId: 'session-a', boundaryId: 'old' },
        new: { sessionId: 'session-b', boundaryId: 'current' },
      },
      episodeSimilarityThreshold: 0.15,
    });
    const result = await index.retrieve('What color are the roses?', {
      sessionId: 'session-b',
      boundaryId: 'current',
    });
    const episodes = index.diagnostics().episodes;

    expect(result.evidence.map((item) => item.message.id)).toEqual(['new']);
    expect(episodes.find((item) => item.messageId === 'old')?.episode).toBe(
      episodes.find((item) => item.messageId === 'related')?.episode,
    );
    expect(episodes.find((item) => item.messageId === 'new')?.episode).not.toBe(
      episodes.find((item) => item.messageId === 'related')?.episode,
    );
  });

  it('builds semantic episodes without relying on explicit boundaries', async () => {
    const index = await ZeroMemIndex.create(
      [
        message('vehicle-1', 'The automobile selected for launch was crimson.', 1),
        message('vehicle-2', 'The red vehicle passed its final launch inspection.', 2),
        message('database', 'The database backup completed on Thursday.', 3),
      ],
      {
        semanticModel: semanticModel(),
        episodeSimilarityThreshold: 0.2,
      },
    );
    const episodes = index.diagnostics().episodes;

    expect(episodes.find((item) => item.messageId === 'vehicle-1')?.episode).toBe(
      episodes.find((item) => item.messageId === 'vehicle-2')?.episode,
    );
    expect(episodes.find((item) => item.messageId === 'database')?.episode).not.toBe(
      episodes.find((item) => item.messageId === 'vehicle-2')?.episode,
    );
  });

  it('matches temporal cues as whole words', async () => {
    const index = await ZeroMemIndex.create(
      [message('fact', 'The deployment behavior is documented.', 1)],
      { semanticModel: semanticModel() },
    );

    const result = await index.retrieve(
      'What knowledge is known about an unknown deployment behavior?',
    );

    expect(result.profile.temporalCues).toEqual([]);
  });

  it('normalizes recency from the earliest trace timestamp', async () => {
    const vector = (similarity: number): Float32Array =>
      new Float32Array([similarity, Math.sqrt(Math.max(0, 1 - similarity * similarity))]);
    const recencyModel: ZeroMemSemanticModel = {
      name: 'recency-test-model',
      async embed(texts) {
        return texts.map((text) =>
          text.includes('alpha')
            ? vector(1)
            : text.includes('beta')
              ? vector(0.995)
              : text.includes('gamma')
                ? vector(0)
                : vector(1),
        );
      },
      async extractEntities(texts) {
        return texts.map(() => []);
      },
    };
    const start = 1_700_000_000_000;
    const year = 365 * 24 * 60 * 60 * 1_000;
    const index = await ZeroMemIndex.create(
      [
        message('old', 'Deployment region code alpha.', start),
        message('middle', 'Deployment region code gamma.', start + year / 2),
        message('new', 'Deployment region code beta.', start + year),
      ],
      {
        semanticModel: recencyModel,
        topK: 3,
        closureK: 0,
        episodeSimilarityThreshold: 0,
      },
    );

    const result = await index.retrieve('What is the latest deployment region code?');
    const currently = await index.retrieve('What is currently the deployment region code?');

    expect(result.ranked[0]?.message.id).toBe('new');
    expect(currently.profile.temporalCues).toEqual(['current']);
    expect(currently.ranked[0]?.message.id).toBe('new');
  });

  it('prefers an authoritative current correction over stale and unrelated state phrases', async () => {
    const index = await ZeroMemIndex.create(
      [
        message('old-user', 'For now, assume npm is the package manager.', 1),
        message(
          'old-assistant',
          'Temporary assumption recorded: npm, awaiting an authoritative maintainer correction.',
          2,
          'assistant',
        ),
        message('filler', 'No current value or open thread changed.', 3),
        message(
          'correction-user',
          'Maintainer correction: this repository requires pnpm 9. The earlier npm assumption was wrong.',
          4,
        ),
        message(
          'correction-assistant',
          'Authoritative convention updated: use pnpm 9. The npm assumption is rejected.',
          5,
          'assistant',
        ),
        message(
          'unrelated-current',
          'The adapter patch was reverted after a regression. It is not active now.',
          6,
        ),
      ],
      {
        semanticModel: semanticModel(),
        topK: 5,
        closureK: 3,
        episodeSimilarityThreshold: 0.15,
      },
    );
    const result = await index.retrieve(
      'Which package manager and major version does the maintainer require now?',
    );
    const ids = result.evidence.map((item) => item.message.id);

    expect(ids).toEqual(expect.arrayContaining(['correction-user', 'correction-assistant']));
    expect(ids).not.toContain('old-assistant');
    expect(ids).not.toContain('unrelated-current');
  });

  it('calibrates current evidence using complete tool traces', async () => {
    const old = message('old', 'The initial staging region was us-east-1.', 1);
    const current = message('current', '', 2, 'assistant');
    current.toolCalls = [{ id: 'inspect-1', name: 'inspect_deployment', arguments: {} }];
    current.toolResults = [
      {
        version: 2,
        toolCallId: 'inspect-1',
        status: 'success',
        content: 'Current state updated: staging is now eu-west-1; us-east-1 is historical only.',
      },
    ];
    const unrelated = message(
      'unrelated',
      'Current state updated: no constraint or accepted value changed in the latest handoff.',
      3,
    );
    const otherCorrection = message(
      'other-correction',
      'Maintainer correction: an earlier package convention was wrong and has been updated.',
      4,
    );
    const index = await ZeroMemIndex.create([old, current, unrelated, otherCorrection], {
      semanticModel: semanticModel(),
    });
    const result = await index.retrieve('What is the current staging region?');

    expect(result.evidence.map((item) => item.message.id)).toContain('current');
    expect(result.evidence.map((item) => item.message.id)).not.toContain('old');
    expect(result.evidence.map((item) => item.message.id)).not.toContain('other-correction');
    expect(result.evidence[0]?.text).toContain('[tool-call:inspect-1 name=inspect_deployment]');
    expect(result.evidence[0]?.text).toContain('eu-west-1');
  });

  it('preserves actions, reasoning, attachments, observations, and excludes checkpoints', async () => {
    const trace = message('trace', 'Deployment inspection completed.', 1, 'assistant');
    trace.reasoningContent = 'Checked the target architecture before reporting.';
    trace.attachments = [
      {
        id: 'image-1',
        sha256: 'abc',
        storageKey: 'attachments/image-1',
        mediaType: 'image/png',
        byteSize: 42,
        displayName: 'architecture.png',
      },
    ];
    trace.fileObservations = [
      {
        path: 'deploy.json',
        workspaceId: 'workspace',
        sha256: 'def',
        byteSize: 10,
        lineStart: 1,
        lineEnd: 2,
        operation: 'read',
        sourceRef: 'tool:read',
        timestamp: 1,
      },
    ];
    const checkpoint = message('checkpoint', 'Generated compact summary.', 2, 'assistant');
    checkpoint.kind = 'checkpoint';
    const index = await ZeroMemIndex.create([trace, checkpoint], {
      semanticModel: semanticModel(),
    });
    const { history, result } = await buildZeroMemHistory(index, 'What inspection completed?');

    expect(result.stats.candidateCount).toBe(1);
    expect(history[0]?.content).toContain('[reasoning]');
    expect(history[0]?.content).toContain('[attachment:image-1');
    expect(history[0]?.content).toContain('[file-observation operation=read path=deploy.json');
    expect(history[0]?.content).not.toContain('Generated compact summary');
  });

  it('returns an empty evidence set for an explicitly absent secret', async () => {
    const index = await ZeroMemIndex.create(
      [message('fact', 'The staging region is eu-west-1.', 1)],
      { semanticModel: semanticModel() },
    );
    const result = await index.retrieve('What is the staging database password?');

    expect(result.evidence).toEqual([]);
    expect(result.stats.evidenceCount).toBe(0);
  });

  it('normalizes spaced and hyphenated API key sensitivity checks', async () => {
    const absentIndex = await ZeroMemIndex.create(
      [message('fact', 'The staging region is eu-west-1.', 1)],
      { semanticModel: semanticModel() },
    );
    const absent = await absentIndex.retrieve('What is the staging API key?');

    expect(absent.evidence).toEqual([]);

    const recordedIndex = await ZeroMemIndex.create(
      [message('key', 'The staging API key is example-key-value.', 1)],
      { semanticModel: semanticModel() },
    );
    const recorded = await recordedIndex.retrieve('What is the staging API-key?');

    expect(recorded.evidence.map((item) => item.message.id)).toContain('key');
  });
});
