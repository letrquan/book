import { useState, useEffect, useRef } from 'react';
import { createRenderDebugLogger } from '../../debug-log.js';
import { isTranscriptScrollActive } from '../scroll-activity.js';
import { useUiClock } from '../ui-clock.js';
import { shimmerColor } from '../shimmer.js';
import { useTheme } from '../theme.js';

const animLog = createRenderDebugLogger('tui:animation');

const BRAILLE_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];

/**
 * Ten frames at the 100ms clock: one revolution per second, and one shimmer
 * breath per revolution.
 */
const DOT_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * The spinner.
 *
 * Colour comes from the active theme's `shimmerPair` and eases across it over
 * a full revolution. It used to be a hardcoded `cyan`/`#5cf` pair swapped every
 * frame, which put an off-palette 5Hz strobe in front of the user on every turn
 * regardless of theme.
 *
 * When reducedMotion is true, returns a static frame in a static colour.
 */
export function useGradientSpinner(
  active: boolean,
  style: 'braille' | 'dots' = 'dots',
  reducedMotion = false,
): { frame: string; color: string } {
  const theme = useTheme();
  const frames = style === 'braille' ? BRAILLE_FRAMES : DOT_FRAMES;
  const tick = useUiClock('fast', active && !reducedMotion);
  const animating = active && !reducedMotion;

  return {
    frame: frames[animating ? tick % frames.length : 0],
    color: animating ? shimmerColor(theme.shimmerPair, tick) : theme.shimmerPair[0],
  };
}

export function useStaggeredReveal(
  count: number,
  active: boolean,
  intervalMs = 120,
  reducedMotion = false,
): number {
  const [visibleCount, setVisibleCount] = useState(reducedMotion ? count : 0);

  useEffect(() => {
    if (!active || reducedMotion) {
      setVisibleCount(count);
      return;
    }
    setVisibleCount(0);
    let current = 0;
    const interval = setInterval(() => {
      if (isTranscriptScrollActive()) return;
      current++;
      setVisibleCount(Math.min(count, current));
      if (current >= count) {
        clearInterval(interval);
      }
    }, intervalMs);
    return () => clearInterval(interval);
  }, [active, count, intervalMs, reducedMotion]);

  return visibleCount;
}

export function useTimedFlash(triggerValue: unknown, durationMs = 220, disabled = false): boolean {
  const [on, setOn] = useState(false);
  const firstRun = useRef(true);

  useEffect(() => {
    if (disabled) {
      setOn(false);
      firstRun.current = false;
      return;
    }
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setOn(true);
    const timer = setTimeout(() => setOn(false), durationMs);
    return () => clearTimeout(timer);
  }, [triggerValue, durationMs, disabled]);

  return on;
}

export function usePulse(active: boolean, interval = 500): boolean {
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!active) {
      setOn(false);
      return;
    }
    animLog.event('pulse:start', { interval });
    const timer = setInterval(() => {
      if (isTranscriptScrollActive()) return;
      setOn((o) => !o);
    }, interval);
    return () => {
      clearInterval(timer);
      animLog.event('pulse:stop', { interval });
    };
  }, [active, interval]);

  return on;
}

/** Time-based pending progress; callers must render 100% from a real completion signal. */
export function useAnimatedProgress(
  active: boolean,
  durationMs = 2_400,
  reducedMotion = false,
  maximum = 95,
): number {
  const [progress, setProgress] = useState(0);
  const safeMaximum = Math.max(0, Math.min(99, maximum));
  const startedAtRef = useRef(Date.now());
  const tick = useUiClock('fast', active && !reducedMotion && progress < safeMaximum);

  useEffect(() => {
    startedAtRef.current = Date.now();
    setProgress(0);
  }, [active, durationMs, reducedMotion, safeMaximum]);

  useEffect(() => {
    if (!active || reducedMotion) return;
    const safeDuration = Math.max(1, durationMs);
    setProgress(
      Math.min(safeMaximum, Math.floor(((Date.now() - startedAtRef.current) / safeDuration) * 100)),
    );
  }, [active, durationMs, reducedMotion, safeMaximum, tick]);

  return progress;
}
