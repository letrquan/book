import { useState, useEffect, useRef } from 'react';

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
    const interval = setInterval(() => {
      setFrame((f) => (f + 1) % frames.length);
    }, 80);
    return () => clearInterval(interval);
  }, [active, frames.length]);

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
): string {
  const [displayed, setDisplayed] = useState('');
  const prevTextRef = useRef(text);

  useEffect(() => {
    if (!active || !text) {
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
  }, [text, active, speed]);

  return active ? displayed : text;
}

export function usePulse(active: boolean, interval = 500): boolean {
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!active) {
      setOn(false);
      return;
    }
    const timer = setInterval(() => {
      setOn((o) => !o);
    }, interval);
    return () => clearInterval(timer);
  }, [active, interval]);

  return on;
}
