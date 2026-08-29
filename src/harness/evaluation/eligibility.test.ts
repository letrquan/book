import { describe, expect, it } from 'vitest';
import type { AgentRunResult } from '../../types/runs.js';
import { evaluateComparisonEligibility, evaluateRunEligibility } from './eligibility.js';

function eligibleRun(): AgentRunResult {
  return {
    context: {
      runId: 'root-run',
      rootRunId: 'root-run',
      sessionId: 'session',
      source: 'sdk',
      startedAt: 1,
    },
    outcome: { status: 'completed', reason: 'normal_completion', partialOutput: false },
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    accounting: {
      rootRunIds: ['root-run'],
      runIds: ['root-run'],
      directUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      inclusiveUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      costUsd: 0.001,
      inclusiveCostUsd: 0.001,
      costStatus: 'known',
      pricingVersion: 'pricing-v1',
      unknownModels: [],
      budgetStatus: 'not_configured',
      modelIdentities: [
        {
          provider: 'openai-compatible',
          requestedModel: 'gpt-5',
          responseModel: 'gpt-5',
          responseId: 'response-1',
          status: 'verified',
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
        requestedModel: 'gpt-5',
        endpointFingerprint: 'endpoint',
        maxTokens: 100,
        modelInfoFingerprint: 'model-info',
      },
      settings: { fingerprint: 'settings', agentsMode: 'off' },
      tools: { fingerprint: 'tools', count: 1, names: ['Read'], activationState: 'fresh' },
      commands: { fingerprint: 'commands', count: 0, names: [] },
      skills: {
        fingerprint: 'skills',
        count: 0,
        names: [],
        activationState: 'disabled',
      },
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

describe('evaluateRunEligibility', () => {
  it('accepts one complete, isolated, verified single-agent run', () => {
    expect(evaluateRunEligibility([eligibleRun()])).toEqual({
      eligible: true,
      reasons: [],
      rootRunId: 'root-run',
      ambientFingerprint: 'ambient-fingerprint',
      pricingVersion: 'pricing-v1',
      budgetUsd: undefined,
      modelIdentityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('rejects partial evidence and child-run confounding', () => {
    const base = eligibleRun();
    const root = {
      ...base,
      accounting: {
        ...base.accounting!,
        completeness: 'partial' as const,
        missingSources: ['provider_usage'],
      },
      ambient: {
        ...base.ambient!,
        completeness: 'partial' as const,
        missingSources: ['random_seed'],
        agents: { ...base.ambient!.agents, mode: 'adaptive' as const },
      },
    };
    const child = {
      ...eligibleRun(),
      context: {
        ...eligibleRun().context,
        runId: 'child-run',
        rootRunId: 'root-run',
        parentRunId: 'root-run',
      },
    };

    expect(evaluateRunEligibility([root, child])).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining([
        'child_runs_present',
        'agents_mode_not_off',
        'ambient_partial:random_seed',
        'accounting_partial:provider_usage',
      ]),
    });
  });

  it('rejects unknown cost and requested-only model identity', () => {
    const base = eligibleRun();
    const run = {
      ...base,
      accounting: {
        ...base.accounting!,
        costStatus: 'unknown' as const,
        costUsd: null,
        inclusiveCostUsd: null,
        modelIdentities: [
          {
            ...base.accounting!.modelIdentities[0],
            responseModel: undefined,
            status: 'requested_only' as const,
          },
        ],
      },
    };

    expect(evaluateRunEligibility([run])).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(['cost_unknown', 'model_identity_unverified']),
    });
  });

  it('rejects non-completed terminal outcomes', () => {
    const run = {
      ...eligibleRun(),
      outcome: {
        status: 'interrupted' as const,
        reason: 'transport_interrupted' as const,
        partialOutput: true,
      },
    };

    expect(evaluateRunEligibility([run])).toMatchObject({
      eligible: false,
      reasons: ['outcome_interrupted:transport_interrupted'],
    });
  });

  it('rejects hidden child accounting and inconsistent known-cost evidence', () => {
    const base = eligibleRun();
    const run = {
      ...base,
      accounting: {
        ...base.accounting!,
        runIds: ['root-run', 'hidden-child'],
        costUsd: null,
        inclusiveCostUsd: null,
      },
    };

    expect(evaluateRunEligibility([run])).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(['accounting_child_runs_present', 'cost_missing']),
    });
  });

  it('accepts only paired arms with matching runtime and provider identities', () => {
    const first = evaluateRunEligibility([eligibleRun()]);
    const second = evaluateRunEligibility([
      {
        ...eligibleRun(),
        context: {
          ...eligibleRun().context,
          runId: 'second-run',
          rootRunId: 'second-run',
        },
        accounting: {
          ...eligibleRun().accounting!,
          rootRunIds: ['second-run'],
          runIds: ['second-run'],
        },
      },
    ]);

    expect(evaluateComparisonEligibility([first, second])).toMatchObject({
      eligible: true,
      reasons: [],
      ambientFingerprint: 'ambient-fingerprint',
      pricingVersion: 'pricing-v1',
    });

    expect(
      evaluateComparisonEligibility([
        first,
        {
          ...second,
          ambientFingerprint: 'different-ambient',
          modelIdentityFingerprint: 'different-model',
          budgetUsd: 1,
        },
      ]),
    ).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining([
        'comparison_ambient_mismatch',
        'comparison_model_identity_mismatch',
        'comparison_budget_mismatch',
      ]),
    });
  });
});
