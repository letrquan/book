import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../src/sdk.js';
import type { AgentRunResult } from '../src/types/runs.js';
import type { EvalTask } from './edit-eval-fixtures.js';
import { runEditEvalWorker, taskCost } from './edit-eval-worker.js';
import { evaluateRunEligibility } from './eval-eligibility.js';

// Only the SDK is replaced. Eligibility stays real: this file is about what it says of a run whose
// model has no price, which `edit-eval-worker.test.ts` cannot show with the check mocked out.
vi.mock('../src/sdk.js', () => ({ query: vi.fn() }));

const ROUTER_MODEL = 'cmc/deepseek/deepseek-v4.1-flash';

/**
 * One complete, isolated, single-agent run on a verified model, which is everything the
 * eligibility check asks of a run but a price. `cost` is the part under test.
 */
function run(
  cost: { costUsd: number | null; costStatus: 'known' | 'estimated' | 'unknown' },
  options: { runId?: string; identity?: 'verified' | 'requested_only' } = {},
): AgentRunResult {
  const runId = options.runId ?? 'root-run';
  const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
  return {
    context: { runId, rootRunId: 'root-run', sessionId: 'session', source: 'sdk', startedAt: 1 },
    outcome: { status: 'completed', reason: 'normal_completion', partialOutput: false },
    usage,
    accounting: {
      rootRunIds: ['root-run'],
      runIds: [runId],
      directUsage: usage,
      inclusiveUsage: usage,
      costUsd: cost.costUsd,
      inclusiveCostUsd: cost.costUsd,
      costStatus: cost.costStatus,
      pricingVersion: 'pricing-v1',
      unknownModels: cost.costStatus === 'unknown' ? [ROUTER_MODEL] : [],
      budgetStatus: 'not_configured',
      modelIdentities: [
        {
          provider: 'openai-compatible',
          requestedModel: ROUTER_MODEL,
          responseModel: options.identity === 'requested_only' ? undefined : ROUTER_MODEL,
          responseId: 'response-1',
          status: options.identity ?? 'verified',
        },
      ],
      completeness: 'complete',
      missingSources: [],
    },
    ambient: {
      schemaVersion: 2,
      fingerprint: 'ambient-fingerprint',
      capturedAt: 1,
      model: {
        provider: 'openai-compatible',
        requestedModel: ROUTER_MODEL,
        endpointFingerprint: 'endpoint',
        maxTokens: 100,
        modelInfoFingerprint: 'model-info',
      },
      settings: { fingerprint: 'settings', agentsMode: 'off' },
      tools: { fingerprint: 'tools', count: 1, names: ['Read'], activationState: 'fresh' },
      commands: { fingerprint: 'commands', count: 0, names: [] },
      skills: { fingerprint: 'skills', count: 0, names: [], activationState: 'disabled' },
      mcp: { fingerprint: 'mcp', count: 0, names: [] },
      agents: { fingerprint: 'agents', count: 3, names: [], mode: 'off' },
      prompt: {
        fingerprint: 'prompt',
        systemPromptVersion: 'prompt-v1',
        date: '2030-02-03',
        projectInstructionCount: 0,
      },
      memory: { fingerprint: 'memory', enabled: false, indexLoaded: false },
      policies: {
        permissionMode: 'bypassPermissions',
        hooksFingerprint: 'hooks',
        contextFingerprint: 'context',
        networkFingerprint: 'network',
        delegationFingerprint: 'delegation',
      },
      runtime: {
        packageVersion: '1.0.0',
        runtimeRevision: 'runtime-1',
        fixtureRevision: 'fixture-1',
        randomSeed: 'seed-1',
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        timezone: 'UTC',
        environmentFingerprint: 'environment',
        workspaceFingerprint: 'workspace',
      },
      bookHome: {
        pathFingerprint: 'book-home',
        isolation: 'isolated',
        contentsStatus: 'captured',
      },
      completeness: 'complete',
      missingSources: [],
    },
  };
}

const UNPRICED = { costUsd: null, costStatus: 'unknown' } as const;

describe('runEditEvalWorker on a model with no price (#663)', () => {
  let workspace: string;
  let previousWorkspace: string;
  const task: EvalTask = {
    name: 'worker-unpriced',
    category: 'test',
    files: { 'value.txt': 'before' },
    instruction: 'Change value.txt.',
    verify: (read) => read('value.txt') === 'after',
  };

  /** A run in which the model makes the edit, then reports `runs` on its result event. */
  function modelEdits(runs: AgentRunResult[], edit = 'after'): void {
    vi.mocked(query).mockImplementation(() =>
      (async function* () {
        await writeFile(join(workspace, 'value.txt'), edit, 'utf8');
        yield { type: 'tool_use', toolCall: { name: 'Edit' } } as never;
        yield {
          type: 'result',
          usage: { totalTokens: 15 },
          outcome: { status: 'completed', reason: 'normal_completion' },
          runs,
        } as never;
      })(),
    );
  }

  beforeEach(async () => {
    previousWorkspace = process.cwd();
    workspace = await mkdtemp(join(tmpdir(), 'book-edit-worker-cost-'));
    process.chdir(workspace);
    await writeFile(join(workspace, 'value.txt'), 'before', 'utf8');
    vi.mocked(query).mockReset();
  });

  afterEach(async () => {
    process.chdir(previousWorkspace);
    await rm(workspace, { recursive: true, force: true });
  });

  it('is what the default check refused: cost_unknown on an otherwise clean run', () => {
    expect(evaluateRunEligibility([run(UNPRICED)])).toMatchObject({
      eligible: false,
      reasons: ['cost_unknown'],
    });
  });

  it('scores the task by verification, and records the cost as unknown', async () => {
    modelEdits([run(UNPRICED)]);

    const outcome = await runEditEvalWorker(task, ROUTER_MODEL);

    expect(outcome).toMatchObject({
      success: true,
      verified: true,
      costUsd: null,
      costStatus: 'unknown',
      totalTokens: 15,
      attribution: { eligible: true, reasons: [] },
    });
    expect(outcome.runError).toBeUndefined();
  });

  it('still fails a task whose edit did not verify, price or no price', async () => {
    modelEdits([run(UNPRICED)], 'wrong');

    await expect(runEditEvalWorker(task, ROUTER_MODEL)).resolves.toMatchObject({
      success: false,
      verified: false,
      costStatus: 'unknown',
    });
  });

  it('does not relax the other checks: an unverified model identity still fails the task', async () => {
    modelEdits([run(UNPRICED, { identity: 'requested_only' })]);

    await expect(runEditEvalWorker(task, ROUTER_MODEL)).resolves.toMatchObject({
      success: false,
      verified: true,
      runError: expect.stringContaining('model_identity_unverified'),
    });
  });

  it('records the dollars when the model is priced', async () => {
    modelEdits([run({ costUsd: 0.0012, costStatus: 'known' })]);

    await expect(runEditEvalWorker(task, ROUTER_MODEL)).resolves.toMatchObject({
      success: true,
      costUsd: 0.0012,
      costStatus: 'known',
    });
  });
});

describe('taskCost', () => {
  it('sums the dollars over the run records, as the tokens are summed', () => {
    expect(
      taskCost([
        run({ costUsd: 0.001, costStatus: 'known' }),
        run({ costUsd: 0.002, costStatus: 'known' }, { runId: 'child-run' }),
      ]),
    ).toEqual({ costUsd: expect.closeTo(0.003, 10), costStatus: 'known' });
  });

  it('takes the least certain status, and keeps the dollars of an estimate', () => {
    expect(
      taskCost([
        run({ costUsd: 0.001, costStatus: 'known' }),
        run({ costUsd: 0.002, costStatus: 'estimated' }, { runId: 'child-run' }),
      ]),
    ).toEqual({ costUsd: expect.closeTo(0.003, 10), costStatus: 'estimated' });
  });

  it('is unknown, not low, when any record has no price', () => {
    expect(taskCost([run({ costUsd: 0.001, costStatus: 'known' }), run(UNPRICED)])).toEqual({
      costUsd: null,
      costStatus: 'unknown',
    });
  });

  it('is unknown for a record without accounting, and absent without records', () => {
    const unaccounted = { ...run(UNPRICED), accounting: undefined };
    expect(taskCost([run({ costUsd: 0.001, costStatus: 'known' }), unaccounted])).toEqual({
      costUsd: null,
      costStatus: 'unknown',
    });
    expect(taskCost(undefined)).toBeUndefined();
    expect(taskCost([])).toBeUndefined();
  });
});
