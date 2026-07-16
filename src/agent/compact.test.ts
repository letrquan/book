import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  shouldCompact,
  compactHistory,
  buildCompactPrompt,
  serializeHistoryForCompact,
  resolveContextLimit,
  usagePressureTokens,
  runCompact,
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
      { id: '1', role: 'user', content: 'old1', timestamp: 0 },
      { id: '2', role: 'assistant', content: 'old2', timestamp: 0 },
      { id: '3', role: 'user', content: 'recent1', timestamp: 0 },
      { id: '4', role: 'assistant', content: 'recent2', timestamp: 0 },
    ];
    const { kept, summarized } = compactHistory(history, 2);
    expect(kept.length).toBe(2);
    expect(kept[0].content).toBe('recent1');
    expect(summarized.length).toBe(2);
    expect(summarized[0].content).toBe('old1');
  });

  it('returns empty summarized when history is short', () => {
    const history: Message[] = [{ id: '1', role: 'user', content: 'only', timestamp: 0 }];
    const { kept, summarized } = compactHistory(history, 2);
    expect(kept.length).toBe(1);
    expect(summarized.length).toBe(0);
  });
});

describe('buildCompactPrompt / serialize', () => {
  it('builds a summarization prompt from the summarized turns', () => {
    const summarized: Message[] = [
      { id: '1', role: 'user', content: 'do X', timestamp: 0 },
      { id: '2', role: 'assistant', content: 'done X', timestamp: 0 },
    ];
    const prompt = buildCompactPrompt(summarized);
    expect(prompt).toMatch(/Summarize/);
    expect(prompt).toMatch(/User: do X/);
    expect(prompt).toMatch(/Assistant: done X/);
  });

  it('includes focus instructions', () => {
    const prompt = buildCompactPrompt(
      [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
      'focus on auth',
    );
    expect(prompt).toMatch(/Special focus from the user: focus on auth/);
  });

  it('includes truncated tool activity', () => {
    const msgs: Message[] = [
      {
        id: '1',
        role: 'assistant',
        content: '',
        timestamp: 0,
        toolCalls: [
          { id: 't1', name: 'Read', arguments: { file_path: 'a.ts' } },
        ],
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

describe('runCompact', () => {
  beforeEach(() => {
    mockedStream.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('skips when history is too short', async () => {
    const result = await runCompact(makeConfig(), [
      { id: '1', role: 'user', content: 'only', timestamp: 0 },
    ], { trigger: 'manual' });
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toBe('too-short');
      expect(result.message).toMatch(/Not enough messages/);
    }
  });

  it('returns compacted history on successful stream', async () => {
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: 'Summary of work.' };
      yield {
        type: 'done',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    });

    const history: Message[] = [
      { id: '1', role: 'user', content: 'do X', timestamp: 0 },
      { id: '2', role: 'assistant', content: 'done X', timestamp: 0 },
    ];
    const result = await runCompact(makeConfig(), history, { trigger: 'manual' });
    expect(result.status).toBe('compacted');
    if (result.status === 'compacted') {
      expect(result.replacementHistory).toHaveLength(1);
      expect(result.replacementHistory[0].content).toMatch(/Summary of work/);
      expect(result.summary).toBe('Summary of work.');
      expect(result.preMessageCount).toBe(2);
    }
  });

  it('fails closed on provider error events', async () => {
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: 'partial' };
      yield { type: 'error', error: 'boom' };
    });

    const history: Message[] = [
      { id: '1', role: 'user', content: 'a', timestamp: 0 },
      { id: '2', role: 'assistant', content: 'b', timestamp: 0 },
    ];
    const result = await runCompact(makeConfig(), history, { trigger: 'auto' });
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
      { id: '1', role: 'user', content: 'a', timestamp: 0 },
      { id: '2', role: 'assistant', content: 'b', timestamp: 0 },
    ];
    const result = await runCompact(makeConfig(), history, { trigger: 'manual' });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('empty-summary');
    }
  });
});
