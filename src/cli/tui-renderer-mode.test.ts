import { describe, expect, it } from 'vitest';
import { resolveTuiRendererMode } from './tui-renderer-mode.js';

describe('TUI renderer mode', () => {
  it('defaults to the patched incremental renderer', () => {
    expect(resolveTuiRendererMode(undefined)).toBe('incremental');
    expect(resolveTuiRendererMode('')).toBe('safe');
    expect(resolveTuiRendererMode('unknown')).toBe('safe');
  });

  it('accepts explicit experimental modes', () => {
    expect(resolveTuiRendererMode('incremental')).toBe('incremental');
    expect(resolveTuiRendererMode('experimental-scroll')).toBe('experimental-scroll');
  });

  it('forces the recovery renderer outside an interactive visual terminal', () => {
    expect(resolveTuiRendererMode('incremental', { isTTY: false })).toBe('safe');
    expect(resolveTuiRendererMode('incremental', { screenReader: true })).toBe('safe');
  });

  it('falls back to safe rendering when the Ink patch is unavailable', () => {
    expect(resolveTuiRendererMode('incremental', { incrementalRendererPatched: false })).toBe(
      'safe',
    );
    expect(
      resolveTuiRendererMode('experimental-scroll', { incrementalRendererPatched: false }),
    ).toBe('safe');
  });
});
