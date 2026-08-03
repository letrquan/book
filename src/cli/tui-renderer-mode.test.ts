import { describe, expect, it } from 'vitest';
import { resolveTuiRendererMode } from './tui-renderer-mode.js';

describe('TUI renderer mode', () => {
  it('defaults to safe rendering on Windows and incremental rendering elsewhere', () => {
    expect(resolveTuiRendererMode(undefined, { platform: 'win32' })).toBe('safe');
    expect(resolveTuiRendererMode(undefined, { platform: 'linux' })).toBe('incremental');
    expect(resolveTuiRendererMode(undefined, { platform: 'darwin' })).toBe('incremental');
    expect(resolveTuiRendererMode('')).toBe('safe');
    expect(resolveTuiRendererMode('unknown')).toBe('safe');
  });

  it('accepts explicit incremental and experimental modes on Windows', () => {
    expect(resolveTuiRendererMode('incremental', { platform: 'win32' })).toBe('incremental');
    expect(resolveTuiRendererMode('experimental-scroll', { platform: 'win32' })).toBe(
      'experimental-scroll',
    );
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
