import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  shouldCompact,
  compactHistory,
  buildCompactPrompt,
  serializeHistoryForCompact,
  resolveContextLimit,
  usagePressureTokens,
  runCompact,
  DEFAULT_CONTEXT_WINDOW,
  IMAGE_TOKEN_ESTIMATE,
  estimateProviderRequestTokens,
} from './compact.js';
import type { AgentConfig } from '../types/runtime.js';
import type { Message, Usage } from '../types/messages.js';
import { defaultConfig, toolResult } from '../test/fixtures.js';

vi.mock('../provider/index.js', () => ({
  chatCompletionStream: vi.fn(),
  createProvider: () => ({
    id: 'test',
    stream: (...args: unknown[]) =>
      vi.mocked(chatCompletionStream)(...(args as Parameters<typeof chatCompletionStream>)),
  }),
}));

import { chatCompletionStream } from '../provider/index.js';

const mockedStream = vi.mocked(chatCompletionStream);

function validCheckpoint(eventRef = '1', summary = 'Summary of work.') {
  return JSON.stringify({
    version: 2,
    generation: 1,
    state: { summary, status: 'active' },
    constraints: [],
    files: [],
    episodes: [
      {
        task: 'do X',
        outcome: 'done X',
        status: 'complete',
        sources: [{ eventRef }],
      },
    ],
    openThreads: [],
    statistics: { summarizedMessages: 2, retainedMessages: 2, preTokens: 1, postTokens: 1 },
  });
}

const twoTurns: Message[] = [
  { id: '1', role: 'user', content: 'do X', includeInContext: true, timestamp: 0 },
  {
    id: '2',
    role: 'assistant',
    content: 'done X '.repeat(5_000),
    includeInContext: true,
    timestamp: 0,
  },
  { id: '3', role: 'user', content: 'do Y', includeInContext: true, timestamp: 0 },
  { id: '4', role: 'assistant', content: 'done Y', includeInContext: true, timestamp: 0 },
];

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return defaultConfig({
    autoCompactEnabled: true,
    accessibility: { screenReader: false, reducedMotion: true },
    modelInfo: { contextWindow: 32_000 },
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

  it('uses the 272K default instead of the output-token limit', () => {
    const config = makeConfig({ maxTokens: 8192, modelInfo: undefined });
    expect(resolveContextLimit(config)).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('defaults unknown model context windows to 272K', () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(272_000);
  });

  it('auto-compacts unknown models at 80% of the 272K default', () => {
    const contextLimit = resolveContextLimit(makeConfig({ modelInfo: undefined }));
    const below: Usage = {
      promptTokens: 217_599,
      completionTokens: 0,
      totalTokens: 217_599,
    };
    const atThreshold: Usage = {
      promptTokens: 217_600,
      completionTokens: 0,
      totalTokens: 217_600,
    };

    expect(shouldCompact(below, contextLimit)).toBe(false);
    expect(shouldCompact(atThreshold, contextLimit)).toBe(true);
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

describe('estimateProviderRequestTokens', () => {
  it('uses the same conservative image estimate as message history accounting', () => {
    const textOnly = estimateProviderRequestTokens(
      [{ role: 'user', content: [{ type: 'text', text: 'describe' }] }],
      [],
    );
    const withImage = estimateProviderRequestTokens(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'image', mediaType: 'image/png', data: 'encoded' },
          ],
        },
      ],
      [],
    );

    expect(withImage - textOnly).toBe(IMAGE_TOKEN_ESTIMATE);
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
    expect(prompt).toMatch(/Summarize/);
    expect(prompt).toMatch(/User: do X/);
    expect(prompt).toMatch(/Assistant: done X/);
  });

  it('includes focus instructions', () => {
    const prompt = buildCompactPrompt(
      [{ id: '1', role: 'user', content: 'hi', includeInContext: true, timestamp: 0 }],
      'focus on auth',
    );
    expect(prompt).toMatch(/Special focus from the user: focus on auth/);
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

    expect(text).toContain('User: real request');
    expect(text).toContain('Assistant: real response');
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
        toolResults: [toolResult('t1', 'file body here')],
      },
    ];
    const text = serializeHistoryForCompact(msgs);
    expect(text).toMatch(/Read/);
    expect(text).toMatch(/a\.ts/);
    expect(text).toMatch(/file body here/);
  });

  it('retains reasoning in the compact transcript', () => {
    const text = serializeHistoryForCompact([
      {
        id: 'reasoning-1',
        role: 'assistant',
        content: 'answer',
        reasoningContent: 'inspect first',
        includeInContext: true,
        timestamp: 0,
      },
    ]);
    expect(text).toContain('<reasoning_context>\ninspect first\n</reasoning_context>');
  });
});

describe('runCompact', () => {
  beforeEach(() => {
    mockedStream.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses the 272K fallback to retain a large newest bundle', async () => {
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: validCheckpoint() };
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
    const history: Message[] = [
      { id: '1', role: 'user', content: 'old task', includeInContext: true, timestamp: 0 },
      {
        id: '2',
        role: 'assistant',
        content: 'old evidence '.repeat(5_000),
        includeInContext: true,
        timestamp: 0,
      },
      { id: '3', role: 'user', content: 'new task', includeInContext: true, timestamp: 0 },
      {
        id: '4',
        role: 'assistant',
        content: 'new evidence '.repeat(2_500),
        includeInContext: true,
        timestamp: 0,
      },
    ];

    const result = await runCompact(makeConfig({ modelInfo: undefined }), history, {
      trigger: 'manual',
    });

    expect(result.status).toBe('compacted');
  });

  it('summarizes an oversized newest bundle instead of rejecting compaction', async () => {
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: validCheckpoint() };
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
    const history: Message[] = [
      { id: '1', role: 'user', content: 'old task', includeInContext: true, timestamp: 0 },
      {
        id: '2',
        role: 'assistant',
        content: 'old evidence '.repeat(3_000),
        includeInContext: true,
        timestamp: 0,
      },
      { id: '3', role: 'user', content: 'new task', includeInContext: true, timestamp: 0 },
      {
        id: '4',
        role: 'assistant',
        content: 'new evidence '.repeat(2_500),
        includeInContext: true,
        timestamp: 0,
      },
    ];

    const result = await runCompact(makeConfig(), history, { trigger: 'manual' });

    expect(result).toMatchObject({
      status: 'compacted',
      summarizedCount: 4,
      retainedCount: 0,
    });
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

  it('returns compacted history on successful stream', async () => {
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: validCheckpoint() };
      yield {
        type: 'done',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    });

    const result = await runCompact(makeConfig(), twoTurns, { trigger: 'manual' });
    expect(result.status).toBe('compacted');
    if (result.status === 'compacted') {
      expect(result.replacementHistory).toHaveLength(3);
      expect(result.replacementHistory[0].content).toMatch(/Summary of work/);
      expect(result.summary).toBe('Summary of work.');
      expect(result.preMessageCount).toBe(4);
      expect(result.replacementHistory.slice(1)).toEqual(twoTurns.slice(2));
      expect(result).toMatchObject({ strategy: 'single-pass', modelCalls: 1, degraded: false });
      expect(result.checkpoint.coverage).toMatchObject({
        status: 'complete',
        processedMessages: 2,
        omittedMessages: 0,
      });
    }
  });

  it('reports checkpoint usage with provider response identity', async () => {
    const onUsage = vi.fn();
    const usage: Usage = { promptTokens: 11, completionTokens: 3, totalTokens: 14 };
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: validCheckpoint() };
      yield {
        type: 'done',
        usage,
        responseModel: 'resolved-model',
        responseId: 'compact-response',
        finishReasons: ['stop'],
      };
    });

    const result = await runCompact(makeConfig({ model: 'requested-model' }), twoTurns, {
      trigger: 'manual',
      onUsage,
    });

    expect(result.status).toBe('compacted');
    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledWith(usage, {
      provider: 'test',
      requestedModel: 'requested-model',
      responseModel: 'resolved-model',
      responseId: 'compact-response',
      finishReasons: ['stop'],
    });
  });

  it('reports checkpoint completions that omit usage', async () => {
    const onUsageMissing = vi.fn();
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: validCheckpoint() };
      yield {
        type: 'done',
        responseModel: 'resolved-model',
        responseId: 'compact-response-without-usage',
        finishReasons: ['stop'],
      };
    });

    const result = await runCompact(makeConfig({ model: 'requested-model' }), twoTurns, {
      trigger: 'manual',
      onUsageMissing,
    });

    expect(result.status).toBe('compacted');
    expect(onUsageMissing).toHaveBeenCalledOnce();
    expect(onUsageMissing).toHaveBeenCalledWith({
      provider: 'test',
      requestedModel: 'requested-model',
      responseModel: 'resolved-model',
      responseId: 'compact-response-without-usage',
      finishReasons: ['stop'],
    });
  });

  it('marks retried checkpoint attempts as missing usage', async () => {
    const onUsageMissing = vi.fn();
    mockedStream.mockImplementation(async function* (_config, _messages, _tools, options) {
      options?.onRetry?.(1, 2, 0);
      yield { type: 'text', content: validCheckpoint() };
      yield {
        type: 'done',
        usage: { promptTokens: 11, completionTokens: 3, totalTokens: 14 },
        responseModel: 'resolved-model',
      };
    });

    const result = await runCompact(makeConfig({ model: 'requested-model' }), twoTurns, {
      trigger: 'manual',
      onUsageMissing,
    });

    expect(result.status).toBe('compacted');
    expect(onUsageMissing).toHaveBeenCalledWith({
      provider: 'test',
      requestedModel: 'requested-model',
    });
  });

  it('checks the root budget before starting a checkpoint model call', async () => {
    const result = await runCompact(makeConfig(), twoTurns, {
      trigger: 'manual',
      beforeModelCall: () => ({ allowed: false, message: 'budget exhausted' }),
    });

    expect(result).toEqual({
      status: 'failed',
      reason: 'budget-overflow',
      error: 'budget exhausted',
    });
    expect(mockedStream).not.toHaveBeenCalled();
  });

  it('supports bounded output and effort overrides for evaluation experiments', async () => {
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: validCheckpoint() };
      yield {
        type: 'done',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    });

    await runCompact(makeConfig(), twoTurns, {
      trigger: 'manual',
      checkpointMaxTokens: 768,
      effort: 'low',
    });

    expect(mockedStream).toHaveBeenCalledTimes(1);
    expect(mockedStream.mock.calls[0]?.[0]).toMatchObject({ effort: 'low', effortExplicit: true });
    expect(mockedStream.mock.calls[0]?.[1][0].content).toContain('accepted and rejected decisions');
    expect(mockedStream.mock.calls[0]?.[3]).toMatchObject({ maxOutputTokens: 768 });
  });

  it('routes checkpoint generation through the configured compact model', async () => {
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: validCheckpoint() };
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
    const base = makeConfig();
    const config = makeConfig({
      model: 'qwen',
      modelSelection: 'router/qwen',
      compactModel: 'router/gemini-flash',
      settings: {
        ...base.settings,
        provider: {
          router: {
            type: 'openai',
            baseURL: 'https://router.example/v1',
            apiKey: 'router-key',
            models: {
              'gemini-flash': {
                contextWindow: 1_000_000,
                effort: { default: 'high', levels: ['low', 'high'] },
              },
            },
          },
        },
      },
      effortExplicit: false,
      defaultEffort: 'medium',
    });

    await runCompact(config, twoTurns, { trigger: 'manual' });

    expect(mockedStream).toHaveBeenCalledTimes(1);
    expect(mockedStream.mock.calls[0]?.[0]).toMatchObject({
      model: 'gemini-flash',
      modelSelection: 'router/gemini-flash',
      baseUrl: 'https://router.example/v1',
      apiKey: 'router-key',
      effort: 'high',
    });
  });

  it('fails closed on provider error events', async () => {
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: 'partial' };
      yield { type: 'error', error: 'boom' };
    });

    const result = await runCompact(makeConfig(), twoTurns, { trigger: 'auto' });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('provider-error');
    }
  });

  it('leaves the input history untouched when compaction is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const history = structuredClone(twoTurns);

    const result = await runCompact(makeConfig(), history, {
      trigger: 'auto',
      signal: controller.signal,
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'aborted' });
    expect(history).toEqual(twoTurns);
    expect(mockedStream).not.toHaveBeenCalled();
  });

  it('returns an aborted result when a pre-compact hook is cancelled', async () => {
    const config = makeConfig();
    config.settings.hooks.PreCompact = [
      {
        command: `"${process.execPath}" -e "setTimeout(() => {}, 30000)"`,
        env: {},
      },
    ];
    const controller = new AbortController();
    const pending = runCompact(config, twoTurns, {
      trigger: 'auto',
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(new Error('compaction cancelled')), 25);

    await expect(pending).resolves.toMatchObject({ status: 'failed', reason: 'aborted' });
    expect(mockedStream).not.toHaveBeenCalled();
  });

  it('skips a no-op compaction without running the pre-compact hooks', async () => {
    const config = makeConfig();
    config.settings.hooks.PreCompact = [
      { command: `"${process.execPath}" -e "process.exit(0)"`, env: {} },
    ];
    const onHookEvent = vi.fn();
    // Four short turns all fit the retention budget, so nothing is summarized.
    const shortHistory: Message[] = [
      { id: '1', role: 'user', content: 'hi', includeInContext: true, timestamp: 0 },
      { id: '2', role: 'assistant', content: 'hello', includeInContext: true, timestamp: 0 },
      { id: '3', role: 'user', content: 'ok', includeInContext: true, timestamp: 0 },
      { id: '4', role: 'assistant', content: 'sure', includeInContext: true, timestamp: 0 },
    ];

    const result = await runCompact(config, shortHistory, { trigger: 'auto', onHookEvent });

    expect(result).toMatchObject({ status: 'skipped', reason: 'too-short' });
    expect(onHookEvent).not.toHaveBeenCalled();
    expect(mockedStream).not.toHaveBeenCalled();
  });

  it('accepts a checkpoint quoting tool-result text the reducer was actually shown', async () => {
    // The reducer prompt serializes tool arguments and tool-result bodies, so a
    // faithful quote of a build error lives there and not in `content`.
    const history: Message[] = [
      { id: '1', role: 'user', content: 'fix the build', includeInContext: true, timestamp: 0 },
      {
        id: '2',
        role: 'assistant',
        content: 'Running the build. '.repeat(3_000),
        includeInContext: true,
        timestamp: 0,
        toolCalls: [{ id: 't1', name: 'Bash', arguments: { command: 'npm run build' } }],
        toolResults: [toolResult('t1', 'TS2345: Argument of type string is not assignable')],
      },
      { id: '3', role: 'user', content: 'and then?', includeInContext: true, timestamp: 0 },
      { id: '4', role: 'assistant', content: 'done', includeInContext: true, timestamp: 0 },
    ];
    mockedStream.mockImplementation(async function* () {
      yield {
        type: 'text',
        content: JSON.stringify({
          version: 2,
          generation: 1,
          state: { summary: 'Build is broken.', status: 'blocked' },
          constraints: [],
          files: [],
          episodes: [
            {
              task: 'fix the build',
              outcome: 'compiler rejected the call',
              status: 'partial',
              sources: [
                {
                  eventRef: 'session://current/event/2',
                  quote: 'TS2345: Argument of type string is not assignable',
                },
              ],
            },
          ],
          openThreads: [],
          statistics: {
            summarizedMessages: 2,
            retainedMessages: 2,
            preTokens: 1,
            postTokens: 1,
          },
        }),
      };
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });

    const result = await runCompact(makeConfig(), history, { trigger: 'manual' });

    expect(result.status).toBe('compacted');
    if (result.status === 'compacted') {
      expect(result.degraded).toBeFalsy();
      expect(result.checkpoint.episodes[0].sources[0].quote).toContain('TS2345');
    }
  });

  it('trims an over-long file list instead of rejecting the checkpoint', async () => {
    const files = Array.from({ length: 34 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      summary: `touched file ${index}`,
      sources: [{ eventRef: 'session://current/event/1' }],
    }));
    mockedStream.mockImplementation(async function* () {
      yield {
        type: 'text',
        content: JSON.stringify({
          version: 2,
          generation: 1,
          state: { summary: 'Touched many files.', status: 'active' },
          constraints: [],
          files,
          episodes: [],
          openThreads: [],
          statistics: {
            summarizedMessages: 2,
            retainedMessages: 2,
            preTokens: 1,
            postTokens: 1,
          },
        }),
      };
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
    const history: Message[] = [
      { id: '1', role: 'user', content: 'touch every file', includeInContext: true, timestamp: 0 },
      {
        id: '2',
        role: 'assistant',
        content: 'Reading the tree. '.repeat(3_000),
        includeInContext: true,
        timestamp: 0,
        fileObservations: files.map((file, index) => ({
          path: file.path,
          workspaceId: 'w',
          sha256: `${index}`.padStart(64, '0'),
          byteSize: 10,
          operation: 'read' as const,
          sourceRef: 'session://current/event/2',
          timestamp: index,
        })),
      },
      { id: '3', role: 'user', content: 'and now?', includeInContext: true, timestamp: 0 },
      { id: '4', role: 'assistant', content: 'idle', includeInContext: true, timestamp: 0 },
    ];

    const result = await runCompact(makeConfig(), history, { trigger: 'manual' });

    expect(result.status).toBe('compacted');
    if (result.status === 'compacted') {
      expect(result.degraded).toBeFalsy();
      expect(result.checkpoint.files.length).toBeLessThanOrEqual(30);
      // Trimming keeps the newest entries, the direction `fitCheckpoint` evicts in.
      expect(result.checkpoint.files.at(-1)?.path).toBe('src/file-33.ts');
    }
  });

  it('uses a degraded retrieval checkpoint after repeated empty output', async () => {
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: '   ' };
      yield {
        type: 'done',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    });

    const result = await runCompact(makeConfig(), twoTurns, { trigger: 'manual' });
    expect(result.status).toBe('compacted');
    if (result.status === 'compacted') {
      expect(result).toMatchObject({
        degraded: true,
        strategy: 'degraded-fallback',
        modelCalls: 2,
      });
      expect(result.checkpoint.state.status).toBe('unknown');
      expect(result.checkpoint.state.summary).toMatch(/Exact history remains searchable/);
      expect(result.checkpoint.coverage?.reasons).toContain('invalid-checkpoint');
    }
  });

  it('performs exactly one schema repair attempt', async () => {
    mockedStream
      .mockImplementationOnce(async function* () {
        yield { type: 'text', content: '{"version":2}' };
        yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'text', content: validCheckpoint() };
        yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      });

    const result = await runCompact(makeConfig(), twoTurns, { trigger: 'manual' });
    expect(result.status).toBe('compacted');
    expect(mockedStream).toHaveBeenCalledTimes(2);
  });

  it('repairs once then degrades when checkpoint references do not exist', async () => {
    const invalid = JSON.parse(validCheckpoint());
    invalid.episodes[0].sources[0].eventRef = 'missing-event';
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: JSON.stringify(invalid) };
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });

    const result = await runCompact(makeConfig(), twoTurns, { trigger: 'manual' });
    expect(result).toMatchObject({
      status: 'compacted',
      degraded: true,
      strategy: 'degraded-fallback',
      modelCalls: 2,
    });
    if (result.status === 'compacted') {
      expect(result.checkpoint.episodes).toEqual([]);
      expect(result.checkpoint.coverage?.reasons).toContain('invalid-checkpoint');
    }
  });

  it('rolls an oversized historical prefix through sequential passes', async () => {
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: validCheckpoint() };
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
    const history: Message[] = [
      { id: '1', role: 'user', content: 'old task', includeInContext: true, timestamp: 0 },
      {
        id: '2',
        role: 'assistant',
        content: 'oversized evidence '.repeat(7_000),
        includeInContext: true,
        timestamp: 0,
      },
      { id: '3', role: 'user', content: 'new task', includeInContext: true, timestamp: 0 },
      { id: '4', role: 'assistant', content: 'working', includeInContext: true, timestamp: 0 },
    ];

    const result = await runCompact(makeConfig(), history, { trigger: 'manual' });

    expect(result).toMatchObject({
      status: 'compacted',
      strategy: 'multi-pass',
      degraded: false,
    });
    expect(mockedStream.mock.calls.length).toBeGreaterThan(1);
    if (result.status === 'compacted') {
      expect(result.modelCalls).toBe(mockedStream.mock.calls.length);
      expect(result.checkpoint.coverage).toMatchObject({
        status: 'complete',
        omittedMessages: 0,
        partiallyProcessedMessages: 0,
      });
    }
  });

  it('applies focus and upcoming intent on every rolling pass in chronological order', async () => {
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: validCheckpoint() };
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
    const history: Message[] = [
      { id: '1', role: 'user', content: 'old one', includeInContext: true, timestamp: 0 },
      {
        id: '2',
        role: 'assistant',
        content: 'one evidence '.repeat(7_000),
        includeInContext: true,
        timestamp: 0,
      },
      { id: '3', role: 'user', content: 'old two', includeInContext: true, timestamp: 0 },
      {
        id: '4',
        role: 'assistant',
        content: 'two evidence '.repeat(7_000),
        includeInContext: true,
        timestamp: 0,
      },
      { id: '5', role: 'user', content: 'new work', includeInContext: true, timestamp: 0 },
      { id: '6', role: 'assistant', content: 'working', includeInContext: true, timestamp: 0 },
    ];

    const result = await runCompact(makeConfig(), history, {
      trigger: 'auto',
      focus: 'focus on sources',
      upcomingUserIntent: 'continue the migration',
    });

    expect(result).toMatchObject({ status: 'compacted', strategy: 'multi-pass' });
    const prompts = mockedStream.mock.calls.map((call) => String(call[1][1].content));
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts.every((prompt) => prompt.includes('focus on sources'))).toBe(true);
    expect(prompts.every((prompt) => prompt.includes('continue the migration'))).toBe(true);
    const chronologicalInput = prompts
      .map(
        (prompt) =>
          prompt.match(/--- BEGIN HISTORICAL EVENTS[\s\S]*?--- END HISTORICAL EVENTS/)?.[0],
      )
      .join('\n');
    expect(chronologicalInput.indexOf('event/1')).toBeLessThan(
      chronologicalInput.indexOf('event/3'),
    );
  });

  it('fragments a single oversized message without partial final coverage', async () => {
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: validCheckpoint() };
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
    const history: Message[] = [
      { id: '1', role: 'user', content: 'inspect output', includeInContext: true, timestamp: 0 },
      {
        id: '2',
        role: 'assistant',
        content: 'assistant evidence '.repeat(10_000),
        includeInContext: true,
        timestamp: 0,
        toolCalls: [{ id: 'tool-1', name: 'Read', arguments: { file_path: 'huge.log' } }],
        toolResults: [toolResult('tool-1', 'tool output '.repeat(15_000))],
      },
      { id: '3', role: 'user', content: 'new work', includeInContext: true, timestamp: 0 },
      { id: '4', role: 'assistant', content: 'working', includeInContext: true, timestamp: 0 },
    ];

    const result = await runCompact(makeConfig(), history, { trigger: 'manual' });

    expect(result).toMatchObject({ status: 'compacted', strategy: 'multi-pass' });
    expect(
      mockedStream.mock.calls.some((call) => String(call[1][1].content).includes('[fragment ')),
    ).toBe(true);
    if (result.status === 'compacted') {
      expect(result.checkpoint.coverage).toMatchObject({
        status: 'complete',
        partiallyProcessedMessages: 0,
      });
    }
  });

  it('caps generation at 15 calls and omits the oldest fragment coverage', async () => {
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: validCheckpoint() };
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
    const history: Message[] = [
      { id: '1', role: 'user', content: 'large task', includeInContext: true, timestamp: 0 },
      {
        id: '2',
        role: 'assistant',
        content: 'very large evidence '.repeat(20_000),
        includeInContext: true,
        timestamp: 0,
      },
    ];

    const result = await runCompact(makeConfig({ modelInfo: { contextWindow: 2_000 } }), history, {
      trigger: 'manual',
    });

    expect(mockedStream).toHaveBeenCalledTimes(15);
    expect(result).toMatchObject({
      status: 'compacted',
      modelCalls: 15,
      degraded: true,
      strategy: 'multi-pass',
    });
    if (result.status === 'compacted') {
      expect(result.checkpoint.coverage?.reasons).toContain('pass-limit');
      expect(
        (result.checkpoint.coverage?.omittedMessages ?? 0) +
          (result.checkpoint.coverage?.partiallyProcessedMessages ?? 0),
      ).toBeGreaterThan(0);
      expect(result.warning).toMatch(/Exact history remains searchable/);
    }
  });

  it('halves the effective budget and replans after a context overflow', async () => {
    mockedStream
      .mockImplementationOnce(async function* () {
        yield { type: 'error', error: 'maximum context length exceeded' };
      })
      .mockImplementation(async function* () {
        yield { type: 'text', content: validCheckpoint() };
        yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      });
    const history: Message[] = [
      { id: '1', role: 'user', content: 'old task', includeInContext: true, timestamp: 0 },
      {
        id: '2',
        role: 'assistant',
        content: 'evidence '.repeat(7_000),
        includeInContext: true,
        timestamp: 0,
      },
      { id: '3', role: 'user', content: 'new task', includeInContext: true, timestamp: 0 },
      { id: '4', role: 'assistant', content: 'working', includeInContext: true, timestamp: 0 },
    ];

    const result = await runCompact(makeConfig(), history, { trigger: 'manual' });

    expect(result).toMatchObject({ status: 'compacted', strategy: 'multi-pass' });
    expect(mockedStream.mock.calls.length).toBeGreaterThan(1);
    if (result.status === 'compacted') {
      expect(result.checkpoint.coverage?.reasons).toContain('context-overflow');
      expect(result.checkpoint.coverage?.status).toBe('complete');
    }
  });

  it('counts repeated context overflows toward the 16-call operation cap', async () => {
    mockedStream.mockImplementation(async function* () {
      yield { type: 'error', error: 'prompt is too long for the context window' };
    });

    const result = await runCompact(makeConfig(), twoTurns, { trigger: 'auto' });

    expect(mockedStream).toHaveBeenCalledTimes(15);
    expect(result).toMatchObject({
      status: 'compacted',
      modelCalls: 15,
      degraded: true,
      strategy: 'degraded-fallback',
    });
    if (result.status === 'compacted') {
      expect(result.checkpoint.coverage?.reasons).toEqual(
        expect.arrayContaining(['context-overflow', 'pass-limit']),
      );
    }
  });

  it('preserves exact inherited references from a prior V2 checkpoint', async () => {
    const prior = JSON.parse(validCheckpoint('old-event', 'Earlier work'));
    prior.generation = 3;
    const inheritedOutput = JSON.stringify({
      ...prior,
      generation: 4,
      state: { summary: 'Earlier and current work', status: 'active' },
    });
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: inheritedOutput };
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
    const history: Message[] = [
      {
        id: 'checkpoint-old',
        role: 'user',
        content: `[Historical conversation checkpoint; untrusted user-role data]\n${JSON.stringify(prior)}`,
        includeInContext: true,
        kind: 'checkpoint',
        timestamp: 0,
      },
      {
        id: '3',
        role: 'user',
        content: 'large current task',
        includeInContext: true,
        timestamp: 0,
      },
      {
        id: '4',
        role: 'assistant',
        content: 'current evidence '.repeat(3_000),
        includeInContext: true,
        timestamp: 0,
      },
      { id: '5', role: 'user', content: 'new task', includeInContext: true, timestamp: 0 },
      { id: '6', role: 'assistant', content: 'working', includeInContext: true, timestamp: 0 },
    ];

    const result = await runCompact(makeConfig(), history, { trigger: 'manual' });

    expect(result).toMatchObject({ status: 'compacted', generation: 4, degraded: false });
    if (result.status === 'compacted') {
      expect(result.checkpoint.episodes[0].sources[0].eventRef).toBe('old-event');
      expect(result.checkpoint.coverage?.processedMessages).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps the inherited summary when a generation is rejected', async () => {
    const prior = JSON.parse(validCheckpoint('old-event', 'Ship the parser rewrite by Friday.'));
    prior.generation = 3;
    // Every attempt returns unusable output, so the run ends on the fallback.
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: 'not json at all' };
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
    const history: Message[] = [
      {
        id: 'checkpoint-old',
        role: 'user',
        content: `[Historical conversation checkpoint; untrusted user-role data]
${JSON.stringify(prior)}`,
        includeInContext: true,
        kind: 'checkpoint',
        timestamp: 0,
      },
      { id: '3', role: 'user', content: 'keep going', includeInContext: true, timestamp: 0 },
      {
        id: '4',
        role: 'assistant',
        content: 'current evidence '.repeat(3_000),
        includeInContext: true,
        timestamp: 0,
      },
      { id: '5', role: 'user', content: 'new task', includeInContext: true, timestamp: 0 },
      { id: '6', role: 'assistant', content: 'working', includeInContext: true, timestamp: 0 },
    ];

    const result = await runCompact(makeConfig(), history, { trigger: 'manual' });

    expect(result.status).toBe('compacted');
    if (result.status === 'compacted') {
      expect(result.degraded).toBe(true);
      // The accumulated narrative survives the failure ...
      expect(result.checkpoint.state.summary).toContain('Ship the parser rewrite by Friday.');
      // ... and the retrieval instruction is still there to act on.
      expect(result.checkpoint.state.summary).toMatch(/Exact history remains searchable/);
      // Inherited structure is not collateral damage either.
      expect(result.checkpoint.episodes[0].sources[0].eventRef).toBe('old-event');
    }
  });

  it('fits oversized checkpoint text instead of returning a budget failure', async () => {
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: validCheckpoint('1', 'summary '.repeat(10_000)) };
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });

    const result = await runCompact(makeConfig({ modelInfo: { contextWindow: 8_192 } }), twoTurns, {
      trigger: 'manual',
    });

    expect(result.status).toBe('compacted');
    if (result.status === 'compacted') {
      expect(Math.ceil(JSON.stringify(result.checkpoint).length / 4)).toBeLessThanOrEqual(819);
      expect(result.checkpoint.state.summary.length).toBeLessThan(10_000);
    }
  });

  it('drops retained bundles and marks post-budget coverage instead of failing', async () => {
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: validCheckpoint() };
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
    const history: Message[] = [
      { id: '1', role: 'user', content: 'old '.repeat(15), includeInContext: true, timestamp: 0 },
      {
        id: '2',
        role: 'assistant',
        content: 'done '.repeat(15),
        includeInContext: true,
        timestamp: 0,
      },
      { id: '3', role: 'user', content: 'new '.repeat(5), includeInContext: true, timestamp: 0 },
      {
        id: '4',
        role: 'assistant',
        content: 'work '.repeat(5),
        includeInContext: true,
        timestamp: 0,
      },
    ];

    const result = await runCompact(makeConfig({ modelInfo: { contextWindow: 250 } }), history, {
      trigger: 'manual',
    });

    expect(result.status).toBe('compacted');
    if (result.status === 'compacted') {
      expect(result.checkpoint.coverage?.reasons).toContain('post-budget');
      expect(result.degraded).toBe(true);
      expect(result.retainedCount).toBe(0);
    }
  });

  it('passes an integer checkpoint output budget to the provider', async () => {
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: validCheckpoint() };
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
    const history: Message[] = [
      { id: '1', role: 'user', content: 'old task', includeInContext: true, timestamp: 0 },
      {
        id: '2',
        role: 'assistant',
        content: 'old evidence '.repeat(700),
        includeInContext: true,
        timestamp: 0,
      },
      { id: '3', role: 'user', content: 'new task', includeInContext: true, timestamp: 0 },
      { id: '4', role: 'assistant', content: 'working', includeInContext: true, timestamp: 0 },
    ];

    const result = await runCompact(makeConfig({ modelInfo: { contextWindow: 8_192 } }), history, {
      trigger: 'manual',
    });

    expect(result.status).toBe('compacted');
    const cap = (mockedStream.mock.calls[0][3] as { maxOutputTokens: number }).maxOutputTokens;
    expect(Number.isInteger(cap)).toBe(true);
    // The provider cap sits above the 819-token checkpoint content budget at this
    // window, leaving room for the JSON envelope and any thinking tokens, and is
    // still bounded by the window the summarizer's own input has to share.
    expect(cap).toBeGreaterThan(819);
    expect(cap).toBeLessThanOrEqual(Math.floor(8_192 * 0.35));
  });

  it('reports this generation as clean while remembering an earlier degradation', async () => {
    // A prior checkpoint that recorded a degraded generation.
    const prior = JSON.parse(validCheckpoint('old-event', 'Earlier work'));
    prior.generation = 3;
    prior.coverage = {
      status: 'degraded',
      reasons: ['pass-limit'],
      processedMessages: 4,
      omittedMessages: 2,
      partiallyProcessedMessages: 0,
    };
    mockedStream.mockImplementation(async function* () {
      yield {
        type: 'text',
        content: JSON.stringify({ ...JSON.parse(validCheckpoint('old-event')), generation: 4 }),
      };
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
    const history: Message[] = [
      {
        id: 'checkpoint-old',
        role: 'user',
        content: `[Historical conversation checkpoint; untrusted user-role data]
${JSON.stringify(prior)}`,
        includeInContext: true,
        kind: 'checkpoint',
        timestamp: 0,
      },
      { id: '3', role: 'user', content: 'keep going', includeInContext: true, timestamp: 0 },
      {
        id: '4',
        role: 'assistant',
        content: 'current evidence '.repeat(3_000),
        includeInContext: true,
        timestamp: 0,
      },
      { id: '5', role: 'user', content: 'new task', includeInContext: true, timestamp: 0 },
      { id: '6', role: 'assistant', content: 'working', includeInContext: true, timestamp: 0 },
    ];

    const result = await runCompact(makeConfig(), history, { trigger: 'manual' });

    expect(result.status).toBe('compacted');
    if (result.status === 'compacted') {
      // This generation processed everything, so it is not degraded ...
      expect(result.checkpoint.coverage?.status).toBe('complete');
      expect(result.checkpoint.coverage?.reasons).not.toContain('pass-limit');
      expect(result.degraded).toBe(false);
      expect(result.warning).toBeUndefined();
      // ... and the earlier degradation is still on the record.
      expect(result.checkpoint.coverage?.lifetime).toMatchObject({
        status: 'degraded',
        reasons: ['pass-limit'],
      });
    }
  });

  it('does not re-compress an earlier chunk before the next chunk sees it', async () => {
    // A constraint stated once, in full. Long enough that a checkpoint carrying it
    // exceeds the 3,200-token budget at this window, so the old per-chunk fit had
    // to truncate it -- and then truncate the truncation at every later chunk.
    const constraint = `Never touch the vendored parser under third_party/parser. ${'Rationale sentence. '.repeat(900)}`;
    mockedStream.mockImplementation(async function* () {
      yield {
        type: 'text',
        content: JSON.stringify({
          version: 2,
          generation: 1,
          state: { summary: constraint, status: 'active' },
          constraints: [],
          files: [],
          episodes: [],
          openThreads: [],
          statistics: {
            summarizedMessages: 2,
            retainedMessages: 2,
            preTokens: 1,
            postTokens: 1,
          },
        }),
      };
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
    const history: Message[] = [
      { id: '1', role: 'user', content: 'old task', includeInContext: true, timestamp: 0 },
      {
        id: '2',
        role: 'assistant',
        content: 'oversized evidence '.repeat(7_000),
        includeInContext: true,
        timestamp: 0,
      },
      { id: '3', role: 'user', content: 'new task', includeInContext: true, timestamp: 0 },
      { id: '4', role: 'assistant', content: 'working', includeInContext: true, timestamp: 0 },
    ];

    const result = await runCompact(makeConfig(), history, { trigger: 'manual' });

    expect(result.status).toBe('compacted');
    expect(mockedStream.mock.calls.length).toBeGreaterThan(1);
    // The second chunk is seeded with what the first chunk actually produced, not
    // with a fitted-down version of it.
    const secondPrompt = mockedStream.mock.calls[1][1][1].content as string;
    expect(secondPrompt).toContain(constraint);
  });

  it('does not spend the repair attempt on a reply cut off at the output cap', async () => {
    // Truncated JSON: unparseable, but the cause is the cap, not the model.
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: '{"version":2,"state":{"summary":"partial' };
      yield {
        type: 'done',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReasons: ['max_tokens'],
      };
    });

    const result = await runCompact(makeConfig(), twoTurns, { trigger: 'manual' });

    expect(result.status).toBe('compacted');
    if (result.status === 'compacted') {
      // One call, not two: the repair prompt is strictly longer than the prompt
      // that just overran, so re-asking could only overrun again.
      expect(result.modelCalls).toBe(1);
      expect(result.degraded).toBe(true);
      expect(result.checkpoint.coverage?.reasons).toContain('invalid-checkpoint');
    }
    expect(mockedStream).toHaveBeenCalledTimes(1);
  });
});
