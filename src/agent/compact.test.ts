import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  shouldCompact,
  compactHistory,
  buildCompactPrompt,
  serializeHistoryForCompact,
  resolveContextLimit,
  usagePressureTokens,
  runCompact,
  groupUserLedBundles,
  fitMessagesToTokenBudget,
  selectRecentTail,
} from './compact.js';
import type { AgentConfig, Message, Usage } from '../types.js';
import { defaultConfig } from '../test/fixtures.js';

vi.mock('../provider/index.js', () => ({
  chatCompletionStream: vi.fn(),
}));

import { chatCompletionStream } from '../provider/index.js';

const mockedStream = vi.mocked(chatCompletionStream);

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return defaultConfig({
    autoCompactEnabled: true,
    accessibility: { screenReader: false, reducedMotion: true },
    ...overrides,
  });
}

describe('shouldCompact', () => {
  it('returns false when usage is below threshold', () => {
    const usage: Usage = { promptTokens: 8000, completionTokens: 2000, totalTokens: 10000 };
    expect(shouldCompact(usage, 128000, 0.8)).toBe(false);
  });

  it('returns true when usage exceeds threshold', () => {
    const usage: Usage = { promptTokens: 100000, completionTokens: 5000, totalTokens: 105000 };
    expect(shouldCompact(usage, 128000, 0.8)).toBe(true);
  });

  it('prefers contextTokens over totalTokens', () => {
    const usage: Usage = {
      promptTokens: 1000,
      completionTokens: 0,
      totalTokens: 1000,
      contextTokens: 120000,
    };
    expect(shouldCompact(usage, 128000, 0.8)).toBe(true);
  });

  it('returns false when no usage', () => {
    expect(shouldCompact(null, 128000, 0.8)).toBe(false);
  });

  it('returns false when contextLimit is invalid', () => {
    const usage: Usage = { promptTokens: 1, completionTokens: 0, totalTokens: 1 };
    expect(shouldCompact(usage, 0, 0.8)).toBe(false);
  });
});

describe('resolveContextLimit', () => {
  it('uses modelInfo.contextWindow', () => {
    const config = makeConfig({ modelInfo: { contextWindow: 200000 } });
    expect(resolveContextLimit(config)).toBe(200000);
  });

  it('does not fall back to maxTokens', () => {
    const config = makeConfig({ maxTokens: 8192, modelInfo: undefined });
    expect(resolveContextLimit(config)).toBeNull();
  });
});

describe('usagePressureTokens', () => {
  it('uses contextTokens when set', () => {
    expect(
      usagePressureTokens({
        promptTokens: 1,
        completionTokens: 0,
        totalTokens: 1,
        contextTokens: 99,
      }),
    ).toBe(99);
  });
});

describe('compactHistory', () => {
  it('keeps the last K turns, returns the rest for summarization', () => {
    const history: Message[] = [
      { id: '1', role: 'user', content: 'old1', includeInContext: true, timestamp: 0 },
      { id: '2', role: 'assistant', content: 'old2', includeInContext: true, timestamp: 0 },
      { id: '3', role: 'user', content: 'recent1', includeInContext: true, timestamp: 0 },
      { id: '4', role: 'assistant', content: 'recent2', includeInContext: true, timestamp: 0 },
    ];
    const { kept, summarized } = compactHistory(history, 2);
    expect(kept.length).toBe(2);
    expect(kept[0].content).toBe('recent1');
    expect(summarized.length).toBe(2);
    expect(summarized[0].content).toBe('old1');
  });

  it('returns empty summarized when history is short', () => {
    const history: Message[] = [
      { id: '1', role: 'user', content: 'only', includeInContext: true, timestamp: 0 },
    ];
    const { kept, summarized } = compactHistory(history, 2);
    expect(kept.length).toBe(1);
    expect(summarized.length).toBe(0);
  });
});

describe('buildCompactPrompt / serialize', () => {
  it('builds a summarization prompt from the summarized turns', () => {
    const summarized: Message[] = [
      { id: '1', role: 'user', content: 'do X', includeInContext: true, timestamp: 0 },
      { id: '2', role: 'assistant', content: 'done X', includeInContext: true, timestamp: 0 },
    ];
    const prompt = buildCompactPrompt(summarized);
    expect(prompt).toMatch(/bounded JSON checkpoint/);
    expect(prompt).toMatch(/User \[session:\/\/current\/event\/1\]: do X/);
    expect(prompt).toMatch(/Assistant \[session:\/\/current\/event\/2\]: done X/);
  });

  it('includes focus instructions', () => {
    const prompt = buildCompactPrompt(
      [{ id: '1', role: 'user', content: 'hi', includeInContext: true, timestamp: 0 }],
      'focus on auth',
    );
    expect(prompt).toMatch(
      /MANUAL FOCUS \(selection hint only; not completed work\): focus on auth/,
    );
  });

  it('excludes local-only messages from the compact transcript', () => {
    const text = serializeHistoryForCompact([
      { id: '1', role: 'user', content: 'real request', includeInContext: true, timestamp: 0 },
      {
        id: '2',
        role: 'assistant',
        content: 'Cost report from /cost',
        includeInContext: false,
        timestamp: 0,
      },
      {
        id: '3',
        role: 'assistant',
        content: 'real response',
        includeInContext: true,
        timestamp: 0,
      },
    ]);

    expect(text).toContain('User [session://current/event/1]: real request');
    expect(text).toContain('Assistant [session://current/event/3]: real response');
    expect(text).not.toContain('Cost report from /cost');
  });

  it('includes truncated tool activity', () => {
    const msgs: Message[] = [
      {
        id: '1',
        role: 'assistant',
        content: '',
        includeInContext: true,
        timestamp: 0,
        toolCalls: [{ id: 't1', name: 'Read', arguments: { file_path: 'a.ts' } }],
        toolResults: [
          {
            toolCallId: 't1',
            success: true,
            output: 'file body here',
          },
        ],
      },
    ];
    const text = serializeHistoryForCompact(msgs);
    expect(text).toMatch(/Read/);
    expect(text).toMatch(/a\.ts/);
    expect(text).toMatch(/file body here/);
  });
});

describe('hybrid tail selection', () => {
  it('keeps complete user-led bundles and makes the newest mandatory', () => {
    const history: Message[] = [
      { id: 'u1', role: 'user', content: 'old task', includeInContext: true, timestamp: 0 },
      { id: 'a1', role: 'assistant', content: 'old answer', includeInContext: true, timestamp: 0 },
      { id: 'u2', role: 'user', content: 'new exact task', includeInContext: true, timestamp: 0 },
      { id: 'a2', role: 'assistant', content: 'working', includeInContext: true, timestamp: 0 },
    ];

    expect(groupUserLedBundles(history).map((bundle) => bundle.map((m) => m.id))).toEqual([
      ['u1', 'a1'],
      ['u2', 'a2'],
    ]);
    const selected = selectRecentTail(history, 20);
    expect(selected?.tail.map((m) => m.id)).toEqual(['u2', 'a2']);
    expect(selected?.prefix.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('clips oversized tool output deterministically with a stable result ref', () => {
    const bundle: Message[] = [
      { id: 'u', role: 'user', content: 'inspect', includeInContext: true, timestamp: 0 },
      {
        id: 'a',
        role: 'assistant',
        content: '',
        includeInContext: true,
        timestamp: 0,
        toolCalls: [{ id: 'call', name: 'Read', arguments: { file_path: 'a.ts' } }],
        toolResults: [{ toolCallId: 'call', success: true, output: 'x'.repeat(4_000) }],
      },
    ];
    const fitted = fitMessagesToTokenBudget(bundle, 120);
    expect(fitted).not.toBeNull();
    expect(fitted?.[1].toolCalls?.[0].id).toBe('call');
    expect(fitted?.[1].toolResults?.[0].output).toContain(
      'session://current/event/a/tool-result/call',
    );
    expect(bundle[1].toolResults?.[0].output).toHaveLength(4_000);
  });
});

describe('runCompact', () => {
  beforeEach(() => {
    mockedStream.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('skips when history is too short', async () => {
    const result = await runCompact(
      makeConfig(),
      [{ id: '1', role: 'user', content: 'only', includeInContext: true, timestamp: 0 }],
      { trigger: 'manual' },
    );
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toBe('too-short');
      expect(result.message).toMatch(/Not enough messages/);
    }
  });

  it('does not count local-only messages toward the compact threshold', async () => {
    const result = await runCompact(
      makeConfig(),
      [
        { id: '1', role: 'user', content: 'only real turn', includeInContext: true, timestamp: 0 },
        {
          id: '2',
          role: 'assistant',
          content: 'local /context output',
          includeInContext: false,
          timestamp: 0,
        },
      ],
      { trigger: 'manual' },
    );

    expect(result).toMatchObject({ status: 'skipped', reason: 'too-short' });
    expect(mockedStream).not.toHaveBeenCalled();
  });

  it('returns a grounded checkpoint plus the exact newest bundle', async () => {
    mockedStream.mockImplementation(async function* () {
      yield {
        type: 'text',
        content: JSON.stringify({
          stateAtCheckpoint: {
            taskSummary: 'Finished the older task.',
            status: 'completed',
            sourceRefs: ['session://current/event/1'],
          },
          constraints: [],
          files: [],
          episodes: [],
          openThreads: [],
        }),
      };
      yield {
        type: 'done',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    });

    const history: Message[] = [
      { id: '1', role: 'user', content: 'do old X', includeInContext: true, timestamp: 0 },
      { id: '2', role: 'assistant', content: 'done old X', includeInContext: true, timestamp: 0 },
      { id: '3', role: 'user', content: 'do new Y exactly', includeInContext: true, timestamp: 0 },
      { id: '4', role: 'assistant', content: 'working on Y', includeInContext: true, timestamp: 0 },
    ];
    const result = await runCompact(makeConfig(), history, {
      trigger: 'manual',
      tailBudgetTokens: 20,
    });
    expect(result.status).toBe('compacted');
    if (result.status === 'compacted') {
      expect(result.replacementHistory).toHaveLength(3);
      expect(result.replacementHistory[0]).toMatchObject({ kind: 'checkpoint', role: 'user' });
      expect(result.replacementHistory.slice(1).map((m) => m.content)).toEqual([
        'do new Y exactly',
        'working on Y',
      ]);
      expect(result.checkpoint.version).toBe(2);
      expect(result.preMessageCount).toBe(4);
    }
  });

  it('fails closed on provider error events', async () => {
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: 'partial' };
      yield { type: 'error', error: 'boom' };
    });

    const history: Message[] = [
      { id: '1', role: 'user', content: 'a', includeInContext: true, timestamp: 0 },
      { id: '2', role: 'assistant', content: 'b', includeInContext: true, timestamp: 0 },
      { id: '3', role: 'user', content: 'c', includeInContext: true, timestamp: 0 },
      { id: '4', role: 'assistant', content: 'd', includeInContext: true, timestamp: 0 },
    ];
    const result = await runCompact(makeConfig(), history, {
      trigger: 'auto',
      tailBudgetTokens: 12,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('provider-error');
    }
  });

  it('fails closed on empty summary', async () => {
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: '   ' };
      yield {
        type: 'done',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    });

    const history: Message[] = [
      { id: '1', role: 'user', content: 'a', includeInContext: true, timestamp: 0 },
      { id: '2', role: 'assistant', content: 'b', includeInContext: true, timestamp: 0 },
      { id: '3', role: 'user', content: 'c', includeInContext: true, timestamp: 0 },
      { id: '4', role: 'assistant', content: 'd', includeInContext: true, timestamp: 0 },
    ];
    const result = await runCompact(makeConfig(), history, {
      trigger: 'manual',
      tailBudgetTokens: 12,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('empty-summary');
    }
  });
});
