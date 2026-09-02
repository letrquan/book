import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { ThemePicker } from './ThemePicker.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function renderPicker(overrides: Partial<React.ComponentProps<typeof ThemePicker>> = {}) {
  const onSelect = vi.fn(() => ({ ok: true }));
  const onCancel = vi.fn();
  const view = render(
    <ThemeContext.Provider value={DEFAULT_THEME}>
      <ThemePicker current="dark" onSelect={onSelect} onCancel={onCancel} {...overrides} />
    </ThemeContext.Provider>,
  );
  return { view, onSelect, onCancel };
}

/**
 * No settle delay: this suite has no async work, so the only thing a sleep here
 * ever bought was a React flush between keypresses — and depending on that is
 * what made these tests flake on a loaded CI runner (#148). At zero, a cursor
 * read back from state fails immediately and deterministically instead.
 */
async function write(view: ReturnType<typeof render>, value: string) {
  view.stdin.write(value);
  await wait(0);
}

afterEach(cleanup);

describe('ThemePicker', () => {
  it('shows built-in and custom themes with the current selection', () => {
    const { view } = renderPicker({ customThemes: ['paper-ink'] });
    const frame = stripAnsi(view.lastFrame());

    expect(frame).toContain('Choose theme');
    expect(frame).toContain('dark');
    expect(frame).toContain('catppuccin');
    expect(frame).toContain('nord');
    expect(frame).toContain('gruvbox');
    expect(frame).toContain('solarized-dark');
    expect(frame).toContain('(current)');
    expect(frame).toContain('paper-ink');
    expect(frame).toContain('Project theme');
  });

  it('navigates and selects a theme', async () => {
    const { view, onSelect } = renderPicker();

    await write(view, '\x1b[B');
    expect(stripAnsi(view.lastFrame())).toContain('› light');
    await write(view, '\r');

    expect(onSelect).toHaveBeenCalledWith('light');
  });

  it('selects the row the arrow reached when both keys arrive in one chunk', async () => {
    // Ink hands a whole stdin chunk to its handlers in one go, so a paste or a
    // fast repeat delivers both keys inside one React batch. Enter used to read
    // the cursor back from state and act on where it was before the arrow.
    const { view, onSelect } = renderPicker();

    await write(view, '\x1b[B\r');

    expect(onSelect).toHaveBeenCalledWith('light');
  });

  it('cancels with Esc', async () => {
    const { view, onCancel } = renderPicker();
    await write(view, '\x1b');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('keeps the picker open and reports save failures', async () => {
    const { view } = renderPicker({
      onSelect: () => ({ ok: false, error: 'settings.local.json is read-only' }),
    });

    await write(view, '\r');
    const frame = stripAnsi(view.lastFrame());
    expect(frame).toContain('Choose theme');
    expect(frame).toContain('settings.local.json is read-only');
  });
});
