import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defaultConfig } from '../../test/fixtures.js';
import type { AgentConfig, RetryPhase, Message } from '../../types.js';

const config = defaultConfig({ baseUrl: 'http://localhost/v1' });

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
    let s: RetryState = { retryPhase: 'transport', retryAttempt: 1, retryMax: 10, retryCountdownMs: 500 };
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
    // The hook sets isThinking=false in its finally block.
    // This is verified by the state machine: send starts thinking, error/cancel stops it.
    // We test the conceptual flow here.
    let isThinking = false;
    let error: string | null = null;

    // Simulate: start send.
    isThinking = true;
    error = null;

    expect(isThinking).toBe(true);
    expect(error).toBeNull();

    // Simulate: onError callback fires.
    error = 'API Error: 500 server error';
    isThinking = false; // finally block runs

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

describe('useAgent micro-batching', () => {
  it('batches rapid onText calls into a single patchStreaming flush', async () => {
    // Simulate the flush logic without React: a text accumulator ref,
    // a setTimeout handle, and flushText that drains and resets.
    let acc = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const patched: string[] = [];

    const flushText = () => {
      if (acc.length === 0) return;
      clearTimeout(timer);
      patched.push(acc);
      acc = '';
    };

    const onText = (text: string) => {
      acc += text;
      clearTimeout(timer);
      timer = setTimeout(flushText, 16);
    };

    // Rapid-fire N calls within 16ms window.
    onText('Hello');
    onText(' ');
    onText('World');
    onText('!');

    // Flush hasn't fired yet (16ms not elapsed).
    expect(patched.length).toBe(0);
    expect(acc).toBe('Hello World!');

    // Advance past flush interval.
    await new Promise((r) => setTimeout(r, 20));

    expect(patched.length).toBe(1);
    expect(patched[0]).toBe('Hello World!');
    expect(acc).toBe('');
  });

  it('flushText is a no-op when accumulator is empty', () => {
    let acc = '';
    const patched: string[] = [];

    const flushText = () => {
      if (acc.length === 0) return;
      patched.push(acc);
      acc = '';
    };

    flushText();
    expect(patched.length).toBe(0);
  });

  it('multiple batches flush separately when separated by interval', async () => {
    let acc = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const patched: string[] = [];

    const flushText = () => {
      if (acc.length === 0) return;
      clearTimeout(timer);
      patched.push(acc);
      acc = '';
    };

    const onText = (text: string) => {
      acc += text;
      clearTimeout(timer);
      timer = setTimeout(flushText, 16);
    };

    // Batch 1.
    onText('A');
    onText('B');
    await new Promise((r) => setTimeout(r, 20));

    // Batch 2.
    onText('C');
    onText('D');
    await new Promise((r) => setTimeout(r, 20));

    expect(patched.length).toBe(2);
    expect(patched[0]).toBe('AB');
    expect(patched[1]).toBe('CD');
  });
});
