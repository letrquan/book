import { useState, useEffect, useRef } from 'react';
import { createRenderDebugLogger } from '../../debug-log.js';

const animLog = createRenderDebugLogger('tui:animation');

const BRAILLE_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];
const DOT_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function useSpinner(
  active: boolean,
  style: 'braille' | 'dots' = 'braille',
): { frame: string; colorIndex: number } {
  const [frame, setFrame] = useState(0);
  const frames = style === 'braille' ? BRAILLE_FRAMES : DOT_FRAMES;

  useEffect(() => {
    if (!active) {
      setFrame(0);
      return;
    }
    animLog.event('spinner:start', { style });
    const interval = setInterval(() => {
      setFrame((f) => (f + 1) % frames.length);
    }, 80);
    return () => {
      clearInterval(interval);
      animLog.event('spinner:stop', { style });
    };
  }, [active, frames.length, style]);

  const colorIndex = frame;
  return { frame: frames[frame], colorIndex };
}

/**
 * Gradient spinner — alternates between brand (cyan) and brandShimmer (#5cf) on each frame tick.
 * When reducedMotion is true, returns a static frame with no animation.
 */
export function useGradientSpinner(
  active: boolean,
  style: 'braille' | 'dots' = 'braille',
  reducedMotion = false,
): { frame: string; color: string } {
  const [tick, setTick] = useState(0);
  const frames = style === 'braille' ? BRAILLE_FRAMES : DOT_FRAMES;

  useEffect(() => {
    if (!active || reducedMotion) {
      setTick(0);
      return;
    }
    const interval = setInterval(() => {
      setTick((f) => (f + 1) % frames.length);
    }, 80);
    return () => clearInterval(interval);
  }, [active, frames.length, reducedMotion]);

  // Shimmer gradient: alternate between cyan and a lighter cyan
  const colors = ['cyan', '#5cf'];
  const frame = frames[reducedMotion ? 0 : tick];
  const color = colors[tick % colors.length];

  return { frame, color };
}

export function useTypewriter(
  text: string,
  speed: number,
  active: boolean,
  reducedMotion = false,
): string {
  const [displayed, setDisplayed] = useState('');
  const prevTextRef = useRef(text);

  useEffect(() => {
    if (!active || !text || reducedMotion) {
      setDisplayed(text);
      prevTextRef.current = text;
      return;
    }
    if (text !== prevTextRef.current) {
      setDisplayed('');
      prevTextRef.current = text;
    }
    let i = 0;
    const interval = setInterval(() => {
      i++;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(interval);
      }
    }, speed);
    return () => clearInterval(interval);
  }, [text, active, speed, reducedMotion]);

  return active && !reducedMotion ? displayed : text;
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

  useEffect(() => {
    setProgress(0);
    if (!active || reducedMotion) return;

    const startedAt = Date.now();
    const safeDuration = Math.max(1, durationMs);
    const safeMaximum = Math.max(0, Math.min(99, maximum));
    const timer = setInterval(() => {
      const next = Math.min(
        safeMaximum,
        Math.floor(((Date.now() - startedAt) / safeDuration) * 100),
      );
      setProgress(next);
      if (next >= safeMaximum) clearInterval(timer);
    }, 80);

    return () => clearInterval(timer);
  }, [active, durationMs, maximum, reducedMotion]);

  return progress;
}
