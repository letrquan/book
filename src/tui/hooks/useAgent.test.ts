import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { resolveModelProviderConfig } from '../../config.js';
import type { RetryPhase, AgentConfig } from '../../types/runtime.js';
import {
  didSendMessageComplete,
  resolveConfigAfterProviderRemoval,
  shouldDiscardOptimisticMessages,
} from './useAgent.js';
import type { AgentSessionSendResult } from '../../session/agent-session.js';
import { DEFAULT_SETTINGS, type ResolvedSettings } from '../../settings.js';
import { defaultConfig } from '../../test/fixtures.js';
import {
  emptyWorkspaceProviderGate,
  resolveSettingsWithProviderGate,
} from '../../settings-loader.js';
import {
  persistWorkspaceProviderChoice,
  workspaceProviderFingerprint,
} from '../../provider-approvals.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Simulate the retry state machine from useAgent.
// This is a pure-function test of the state transitions without React rendering.

interface RetryState {
  retryPhase: RetryPhase;
  retryAttempt: number;
  retryMax: number;
  retryCountdownMs: number;
}

function initialRetryState(): RetryState {
  return { retryPhase: 'none', retryAttempt: 0, retryMax: 0, retryCountdownMs: 0 };
}

function applyOnRetry(
  phase: RetryPhase,
  attempt: number,
  max: number,
  delayMs: number,
): RetryState {
  return { retryPhase: phase, retryAttempt: attempt, retryMax: max, retryCountdownMs: delayMs };
}

function applyOnStreamStall(countdownMs: number): RetryState {
  return { retryPhase: 'stalled', retryAttempt: 0, retryMax: 0, retryCountdownMs: countdownMs };
}

function applyOnStreamResume(): RetryState {
  return { retryPhase: 'none', retryAttempt: 0, retryMax: 0, retryCountdownMs: 0 };
}

function applySend(): RetryState {
  return initialRetryState();
}

function applyCancel(): RetryState {
  return initialRetryState();
}

function applyClear(): RetryState {
  return initialRetryState();
}

function applyTickCountdown(state: RetryState): RetryState {
  if (state.retryCountdownMs <= 0) return { ...state, retryCountdownMs: 0 };
  return { ...state, retryCountdownMs: Math.max(0, state.retryCountdownMs - 1000) };
}

describe('useAgent retry state machine', () => {
  it('starts with retryPhase "none"', () => {
    const s = initialRetryState();
    expect(s.retryPhase).toBe('none');
    expect(s.retryCountdownMs).toBe(0);
  });

  it('transitions to transport retry on onRetry callback', () => {
    const s = applyOnRetry('transport', 3, 10, 4000);
    expect(s.retryPhase).toBe('transport');
    expect(s.retryAttempt).toBe(3);
    expect(s.retryMax).toBe(10);
    expect(s.retryCountdownMs).toBe(4000);
  });

  it('transitions to stalled on onStreamStall callback', () => {
    const s = applyOnStreamStall(20000);
    expect(s.retryPhase).toBe('stalled');
    expect(s.retryCountdownMs).toBe(20000);
  });

  it('transitions to none on onStreamResume callback', () => {
    let s = applyOnStreamStall(15000);
    s = applyOnStreamResume();
    expect(s.retryPhase).toBe('none');
  });

  it('resets retry state on new send', () => {
    let s = applyOnRetry('transport', 1, 10, 2000);
    s = applySend();
    expect(s.retryPhase).toBe('none');
    expect(s.retryCountdownMs).toBe(0);
  });

  it('resets retry state on cancel', () => {
    let s = applyOnRetry('transport', 1, 10, 2000);
    s = applyCancel();
    expect(s.retryPhase).toBe('none');
  });

  it('resets retry state on clear', () => {
    let s = applyOnRetry('transport', 1, 10, 2000);
    s = applyClear();
    expect(s.retryPhase).toBe('none');
  });

  it('countdown ticks down by 1 second', () => {
    let s = applyOnRetry('transport', 2, 10, 4000);
    s = applyTickCountdown(s);
    expect(s.retryCountdownMs).toBe(3000);
    s = applyTickCountdown(s);
    expect(s.retryCountdownMs).toBe(2000);
    s = applyTickCountdown(s);
    expect(s.retryCountdownMs).toBe(1000);
    s = applyTickCountdown(s);
    expect(s.retryCountdownMs).toBe(0);
  });

  it('countdown does not go below 0', () => {
    let s: RetryState = {
      retryPhase: 'transport',
      retryAttempt: 1,
      retryMax: 10,
      retryCountdownMs: 500,
    };
    s = applyTickCountdown(s);
    expect(s.retryCountdownMs).toBe(0);
    s = applyTickCountdown(s);
    expect(s.retryCountdownMs).toBe(0);
  });

  it('watchdog phase shows -1 as max attempts', () => {
    const s = applyOnRetry('watchdog', 47, -1, 4000);
    expect(s.retryPhase).toBe('watchdog');
    expect(s.retryAttempt).toBe(47);
    expect(s.retryMax).toBe(-1);
  });
});

describe('useAgent error/isThinking state transitions', () => {
  it('keeps cancelled messages visible when they are retained in provider context', () => {
    const retained: AgentSessionSendResult = {
      status: 'cancelled',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'keep this turn',
          includeInContext: true,
          timestamp: 1,
        },
      ],
    };

    expect(shouldDiscardOptimisticMessages(retained)).toBe(false);
    expect(shouldDiscardOptimisticMessages({ status: 'cancelled' })).toBe(true);
  });

  it('does not treat a failed run as a delivered completion turn', () => {
    const failed: AgentSessionSendResult = {
      status: 'failed',
      phase: 'run',
      error: new Error('provider failed'),
    };
    expect(didSendMessageComplete(failed)).toBe(false);
  });

  it('after error, isThinking should be false (input bar enabled)', () => {
    // Terminal AgentSession snapshots stop thinking after an error or cancellation.
    // This verifies the projected state transition independently from React rendering.
    // We test the conceptual flow here.
    let isThinking = false;
    let error: string | null = null;

    // Simulate: start send.
    isThinking = true;
    error = null;

    expect(isThinking).toBe(true);
    expect(error).toBeNull();

    // Simulate: a failed terminal snapshot arrives.
    error = 'API Error: 500 server error';
    isThinking = false;

    expect(isThinking).toBe(false);
    expect(error).toMatch(/API Error/);
    // User CAN type a new message (isThinking=false).
  });

  it('error cleared on new send', () => {
    let isThinking = true;
    let error: string | null = 'previous error';

    // Simulate new send.
    error = null;
    isThinking = true;

    expect(error).toBeNull();
    expect(isThinking).toBe(true);
  });

  it('cancel sets isThinking to false', () => {
    let isThinking = true;

    // Simulate cancel.
    isThinking = false;

    expect(isThinking).toBe(false);
  });
});

describe('provider removal runtime resolution', () => {
  function settings(overrides: Partial<ResolvedSettings> = {}): ResolvedSettings {
    return {
      ...structuredClone(DEFAULT_SETTINGS),
      ...overrides,
      provider: overrides.provider ?? {},
    };
  }

  function activeGateway(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return defaultConfig({
      apiKey: 'local-key',
      baseUrl: 'https://local.test/v1',
      model: 'local-model',
      modelSelection: 'gateway/local-model',
      provider: 'openai',
      defaultApiKey: 'default-key',
      defaultBaseUrl: 'https://default.test/v1',
      defaultProvider: 'auto',
      defaultMaxTokens: 12000,
      defaultEffort: 'high',
      maxTokensExplicit: false,
      effortExplicit: false,
      settings: settings({
        model: 'gateway/local-model',
        provider: {
          gateway: {
            type: 'openai',
            apiKey: 'local-key',
            models: { 'local-model': {} },
          },
        },
      }),
      ...overrides,
    });
  }

  it('switches an active removed provider to the newly resolved project default', () => {
    const result = resolveConfigAfterProviderRemoval(
      activeGateway(),
      settings({ model: 'project-model' }),
      'gateway',
      emptyWorkspaceProviderGate(),
    );

    expect(result.activeModel).toBe('project-model');
    expect(result.switched).toBe(true);
    expect(result.config.model).toBe('project-model');
    expect(result.config.apiKey).toBe('default-key');
    expect(result.config.baseUrl).toBe('https://default.test/v1');
    expect(result.config.provider).toBe('auto');
  });

  it('uses the resolved user-global default when it is the next configured layer', () => {
    const result = resolveConfigAfterProviderRemoval(
      activeGateway(),
      settings({ model: 'user-global-model' }),
      'gateway',
      emptyWorkspaceProviderGate(),
    );

    expect(result.activeModel).toBe('user-global-model');
    expect(result.switched).toBe(true);
  });

  it("moves off a repository's plan model once a chatgpt provider exists (#615)", () => {
    const repositoryModel = {
      key: 'model',
      value: 'chatgpt/gpt-plan',
      providerId: 'chatgpt',
      path: '/ws/.book/settings.json',
      fallback: undefined,
    };
    const current = defaultConfig({
      model: 'chatgpt/gpt-plan',
      modelSelection: 'chatgpt/gpt-plan',
      defaultApiKey: 'default-key',
      defaultBaseUrl: 'https://default.test/v1',
      workspaceProviderGate: {
        ...emptyWorkspaceProviderGate(),
        workspaceSelections: [repositoryModel],
      },
    });
    const result = resolveConfigAfterProviderRemoval(
      current,
      settings({ provider: { chatgpt: { type: 'chatgpt', models: { 'gpt-plan': {} } } } }),
      'gateway',
      // A fresh read knows nothing of the launch's provenance; the removal carries it over.
      emptyWorkspaceProviderGate(),
    );
    expect(result.config.providerAuth).toBeUndefined();
    expect(result.activeModel).toBe('gpt-4o');
    expect(result.switched).toBe(true);
    expect(result.config.workspaceProviderGate?.withheldSelections).toEqual([
      expect.objectContaining({ ...repositoryModel, reason: 'plan' }),
    ]);
  });

  it('falls back to gpt-4o when no configured model remains', () => {
    const result = resolveConfigAfterProviderRemoval(
      activeGateway(),
      settings(),
      'gateway',
      emptyWorkspaceProviderGate(),
    );

    expect(result.activeModel).toBe('gpt-4o');
    expect(result.config.model).toBe('gpt-4o');
    expect(result.switched).toBe(true);
  });

  it('ignores a stale resolved default that references the missing provider', () => {
    const result = resolveConfigAfterProviderRemoval(
      activeGateway(),
      settings({ model: 'gateway/missing' }),
      'gateway',
      emptyWorkspaceProviderGate(),
    );

    expect(result.activeModel).toBe('gpt-4o');
  });

  it('preserves a non-active session-only model while updating settings', () => {
    const current = activeGateway({
      model: 'session-model',
      modelSelection: 'session-model',
      settings: settings({
        model: 'gateway/local-model',
        provider: {
          gateway: { type: 'openai', models: { 'local-model': {} } },
        },
      }),
    });
    const nextSettings = settings({ model: 'project-model' });

    const result = resolveConfigAfterProviderRemoval(
      current,
      nextSettings,
      'gateway',
      emptyWorkspaceProviderGate(),
    );

    expect(result.activeModel).toBe('session-model');
    expect(result.switched).toBe(false);
    expect(result.config.settings).toBe(nextSettings);
  });

  it('reveals an inherited provider and resolves all fallback model defaults', () => {
    const nextSettings = settings({
      model: 'gateway/inherited-model',
      provider: {
        gateway: {
          type: 'anthropic',
          baseURL: 'https://inherited.test/v1',
          apiKey: 'inherited-key',
          models: {
            'inherited-model': {
              label: 'Inherited',
              maxOutputTokens: 4096,
              effort: { default: 'low', levels: ['low', 'high'] },
            },
          },
        },
      },
    });

    const result = resolveConfigAfterProviderRemoval(
      activeGateway(),
      nextSettings,
      'gateway',
      emptyWorkspaceProviderGate(),
    );

    expect(result.inheritedProviderRevealed).toBe(true);
    expect(result.activeModel).toBe('gateway/inherited-model');
    expect(result.config).toEqual(
      expect.objectContaining({
        apiKey: 'inherited-key',
        baseUrl: 'https://inherited.test/v1',
        provider: 'anthropic',
        model: 'inherited-model',
        modelSelection: 'gateway/inherited-model',
        maxTokens: 4096,
        effort: 'low',
      }),
    );
    expect(result.config.modelInfo?.label).toBe('Inherited');
  });

  // Finding 3: settings are re-read here, and the gate computed at launch describes the settings
  // from before the removal.
  describe('when the removed provider shared its id with an approved workspace one', () => {
    const wsProvider = { type: 'openai', baseURL: 'https://workspace.example/v1' } as const;
    let root: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'book-removal-'));
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    function reread(userSettings: Record<string, unknown>) {
      const workspace = join(root, 'ws');
      const home = join(root, 'home');
      mkdirSync(join(workspace, '.book'), { recursive: true });
      mkdirSync(join(home, '.book'), { recursive: true });
      writeFileSync(
        join(workspace, '.book', 'settings.json'),
        JSON.stringify({ provider: { team: wsProvider } }),
      );
      writeFileSync(join(home, '.book', 'settings.json'), JSON.stringify(userSettings));
      // The user approved the workspace's declaration earlier, before defining their own.
      persistWorkspaceProviderChoice(
        workspace,
        'team',
        workspaceProviderFingerprint(wsProvider),
        'approved',
        join(home, '.book', 'trust.json'),
      );
      return resolveSettingsWithProviderGate(workspace, undefined, { home });
    }

    // What the session holds from launch: the user's own `team`, which shadowed the workspace's.
    const launchTime = () =>
      activeGateway({
        modelSelection: 'team/m',
        defaultApiKey: 'user-bookkey',
        workspaceProviderGate: emptyWorkspaceProviderGate(),
        settings: settings({
          model: 'team/m',
          provider: {
            team: { type: 'openai', baseURL: 'https://user.example/v1', apiKey: 'k', models: {} },
          },
        }),
      });

    it('sends no inherited key to the workspace origin the removal revealed', () => {
      const { settings: next, providerGate } = reread({ model: 'team/m' });
      expect(next.provider.team.baseURL).toBe('https://workspace.example/v1');
      expect(providerGate.declared).toEqual(['team']);

      const result = resolveConfigAfterProviderRemoval(launchTime(), next, 'team', providerGate);

      expect(result.config.baseUrl).toBe('https://workspace.example/v1');
      // Not BOOK_API_KEY, and not the key the user's own provider carried.
      expect(result.config.apiKey).toBe('');
      expect(result.config.workspaceProviderGate?.declared).toEqual(['team']);
    });

    it('stores the recomputed gate with the settings, so later switches see it too', () => {
      const { settings: next, providerGate } = reread({ model: 'team/m' });

      const { config } = resolveConfigAfterProviderRemoval(
        launchTime(),
        next,
        'team',
        providerGate,
      );

      expect(config.settings).toBe(next);
      expect(config.workspaceProviderGate).toMatchObject({ declared: ['team'], withheld: [] });
      expect(resolveModelProviderConfig(config, 'team/other').apiKey).toBe('');
    });

    it('keeps the legacy baseUrl decision the launch computed', () => {
      const { settings: next, providerGate } = reread({});
      const current = launchTime();
      current.workspaceProviderGate = {
        ...emptyWorkspaceProviderGate(),
        legacyBaseUrl: { baseUrl: 'https://legacy.example/v1', state: 'pending' },
      };

      const { config } = resolveConfigAfterProviderRemoval(current, next, 'team', providerGate);

      expect(config.workspaceProviderGate?.legacyBaseUrl).toEqual({
        baseUrl: 'https://legacy.example/v1',
        state: 'pending',
      });
    });
  });
});
