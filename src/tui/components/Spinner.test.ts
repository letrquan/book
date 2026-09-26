import { describe, expect, it } from 'vitest';
import { SPINNER_TIPS } from './Spinner.js';
import { HEDERA_FRAMES } from '../hooks/useAnimation.js';
import { displayWidth } from './word-wrap.js';

describe('Spinner tips', () => {
  it('advertises supported transcript scrolling keys', () => {
    const tips = SPINNER_TIPS.join('\n');
    expect(tips).toContain('PageUp/PageDown');
    expect(tips).not.toContain('terminal scrollback');
  });
});

describe('the hedera spinner', () => {
  it('swings the fleuron upright, right, upright, left, once a second', () => {
    // Ten frames at the 100ms clock: one swing a second, upright held longest.
    expect(HEDERA_FRAMES).toHaveLength(10);
    expect(HEDERA_FRAMES.filter((frame) => frame === '❦')).toHaveLength(6);
    expect(HEDERA_FRAMES.join('')).toBe('❦❦❦❧❧❦❦❦☙☙');
  });

  it('keeps every frame one terminal cell wide', () => {
    for (const frame of new Set(HEDERA_FRAMES)) expect(displayWidth(frame)).toBe(1);
  });
});
