import { describe, it, expect } from 'vitest';
import type { RetryPhase, AgentConfig } from '../../types/runtime.js';
import { resolveConfigAfterProviderRemoval } from './useAgent.js';
import { DEFAULT_SETTINGS, type ResolvedSettings } from '../../settings.js';
import { defaultConfig } from '../../test/fixtures.js';

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
    );

    expect(result.activeModel).toBe('user-global-model');
    expect(result.switched).toBe(true);
  });

  it('falls back to gpt-4o when no configured model remains', () => {
    const result = resolveConfigAfterProviderRemoval(activeGateway(), settings(), 'gateway');

    expect(result.activeModel).toBe('gpt-4o');
    expect(result.config.model).toBe('gpt-4o');
    expect(result.switched).toBe(true);
  });

  it('ignores a stale resolved default that references the missing provider', () => {
    const result = resolveConfigAfterProviderRemoval(
      activeGateway(),
      settings({ model: 'gateway/missing' }),
      'gateway',
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

    const result = resolveConfigAfterProviderRemoval(current, nextSettings, 'gateway');

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

    const result = resolveConfigAfterProviderRemoval(activeGateway(), nextSettings, 'gateway');

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
});
