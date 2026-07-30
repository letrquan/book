import { describe, expect, it } from 'vitest';
import { RunAccounting } from './run-accounting.js';
import type { AgentRunContext } from '../types/runs.js';

function context(runId: string, rootRunId = 'root'): AgentRunContext {
  return {
    runId,
    rootRunId,
    sessionId: 'session',
    source: 'headless',
    startedAt: 1,
  };
}

const usage = (promptTokens: number, completionTokens: number) => ({
  promptTokens,
  completionTokens,
  totalTokens: promptTokens + completionTokens,
});

describe('RunAccounting', () => {
  it('keeps direct execution usage separate from root-inclusive usage', () => {
    const accounting = new RunAccounting();
    const root = context('root');
    const child = context('child', root.rootRunId);
    accounting.startRoot(root, 0.001);

    accounting.record(root, usage(10, 5), {
      provider: 'openai-compatible',
      requestedModel: 'gpt-5',
      responseModel: 'gpt-5',
      responseId: 'response-root',
    });
    accounting.record(child, usage(4, 2), {
      provider: 'openai-compatible',
      requestedModel: 'gpt-5',
      responseModel: 'gpt-5',
      responseId: 'response-child',
    });

    expect(accounting.snapshotRun(child.runId)).toMatchObject({
      directUsage: usage(4, 2),
      inclusiveUsage: usage(4, 2),
      costStatus: 'known',
    });
    expect(accounting.snapshotRoot(root.rootRunId)).toMatchObject({
      directUsage: usage(10, 5),
      inclusiveUsage: usage(14, 7),
      runIds: ['root', 'child'],
      budgetStatus: 'within',
    });
  });

  it('marks requested-only identity as estimated rather than verified', () => {
    const accounting = new RunAccounting();
    const root = context('root');
    accounting.record(root, usage(10, 5), {
      provider: 'openai-compatible',
      requestedModel: 'gpt-5',
    });

    expect(accounting.snapshotRoot(root.rootRunId)).toMatchObject({
      costStatus: 'estimated',
      modelIdentities: [{ status: 'requested_only' }],
    });
  });

  it('uses requested alias pricing for a versioned response model', () => {
    const accounting = new RunAccounting();
    const root = context('root');
    accounting.startRoot(root, 1);

    accounting.record(root, usage(10, 5), {
      provider: 'openai-compatible',
      requestedModel: 'gpt-4o',
      responseModel: 'gpt-4o-2024-08-06',
      responseId: 'response-versioned',
    });

    expect(accounting.snapshotRoot(root.rootRunId)).toMatchObject({
      costStatus: 'known',
      unknownModels: [],
      budgetStatus: 'within',
      modelIdentities: [
        {
          status: 'verified',
          requestedModel: 'gpt-4o',
          responseModel: 'gpt-4o-2024-08-06',
        },
      ],
    });
    expect(accounting.checkBeforeModelCall(root.rootRunId, 'gpt-4o')).toMatchObject({
      allowed: true,
      status: 'within',
    });
  });

  it('fails closed before a budgeted call when pricing is unknown', () => {
    const accounting = new RunAccounting();
    const root = context('root');
    accounting.startRoot(root, 1);

    expect(accounting.checkBeforeModelCall(root.rootRunId, 'vendor/unknown')).toEqual({
      allowed: false,
      status: 'unknown',
      message: expect.stringContaining('pricing is unknown'),
    });
  });

  it('stops the next call after inclusive spend reaches the budget', () => {
    const accounting = new RunAccounting();
    const root = context('root');
    accounting.startRoot(root, 0.0001);
    accounting.record(root, usage(10, 5), {
      provider: 'openai-compatible',
      requestedModel: 'gpt-5',
      responseModel: 'gpt-5',
      responseId: 'response-root',
    });

    expect(accounting.checkBeforeModelCall(root.rootRunId, 'gpt-5')).toMatchObject({
      allowed: false,
      status: 'exceeded',
    });
  });
});
