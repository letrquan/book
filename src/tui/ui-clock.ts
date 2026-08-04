import { useCallback, useSyncExternalStore } from 'react';
import { isTranscriptScrollActive } from './scroll-activity.js';

export type UiClockRate = 'cinematic' | 'fast' | 'slow';

interface ClockState {
  revision: number;
  timer: ReturnType<typeof setInterval> | null;
  listeners: Set<() => void>;
}

const CLOCK_INTERVAL_MS: Record<UiClockRate, number> = {
  cinematic: 50,
  fast: 100,
  slow: 1000,
};

const clocks: Record<UiClockRate, ClockState> = {
  cinematic: { revision: 0, timer: null, listeners: new Set() },
  fast: { revision: 0, timer: null, listeners: new Set() },
  slow: { revision: 0, timer: null, listeners: new Set() },
};

function startClock(rate: UiClockRate): void {
  const clock = clocks[rate];
  if (clock.timer !== null) return;
  clock.timer = setInterval(() => {
    if (rate !== 'slow' && isTranscriptScrollActive()) return;
    clock.revision++;
    for (const listener of clock.listeners) listener();
  }, CLOCK_INTERVAL_MS[rate]);
}

export function subscribeUiClock(rate: UiClockRate, listener: () => void): () => void {
  const clock = clocks[rate];
  clock.listeners.add(listener);
  startClock(rate);
  return () => {
    clock.listeners.delete(listener);
    if (clock.listeners.size === 0 && clock.timer !== null) {
      clearInterval(clock.timer);
      clock.timer = null;
    }
  };
}

function subscribeNoop(): () => void {
  return () => {};
}

export function useUiClock(rate: UiClockRate, enabled = true): number {
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? subscribeUiClock(rate, listener) : subscribeNoop()),
    [enabled, rate],
  );
  const getSnapshot = useCallback(() => clocks[rate].revision, [rate]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
