import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { STARTUP_ASSEMBLE_TOTAL_TICKS } from '../startup-assemble.js';
import { StartupAssemble } from './StartupAssemble.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('StartupAssemble', () => {
  it('completes on the cinematic clock and releases its timer', async () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <StartupAssemble width={48} height={16} onComplete={onComplete} />
      </ThemeContext.Provider>,
    );

    for (let tick = 0; tick < STARTUP_ASSEMBLE_TOTAL_TICKS; tick++) {
      await act(async () => vi.advanceTimersByTime(50));
    }

    expect(onComplete).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
