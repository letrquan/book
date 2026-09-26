import { describe, expect, it } from 'vitest';
import { isCiEnvironment, resolveTuiRendererMode } from './tui-renderer-mode.js';

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

  it('falls back to safe rendering when the renderer fix is unavailable', () => {
    expect(resolveTuiRendererMode('incremental', { incrementalRendererFixed: false })).toBe('safe');
    expect(resolveTuiRendererMode('experimental-scroll', { incrementalRendererFixed: false })).toBe(
      'safe',
    );
  });

  it('detects CI the way Ink does', () => {
    expect(isCiEnvironment({})).toBe(false);
    expect(isCiEnvironment({ CI: 'true' })).toBe(true);
    expect(isCiEnvironment({ CI: '1' })).toBe(true);
    expect(isCiEnvironment({ CI: '' })).toBe(true);
    expect(isCiEnvironment({ CI: 'false' })).toBe(false);
    expect(isCiEnvironment({ CI: '0' })).toBe(false);
    expect(isCiEnvironment({ CONTINUOUS_INTEGRATION: 'yes' })).toBe(true);
  });
});
