import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { EffortPicker } from './EffortPicker.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function renderPicker(overrides: Partial<React.ComponentProps<typeof EffortPicker>> = {}) {
  const onSelect = vi.fn(() => ({ ok: true }));
  const onCancel = vi.fn();
  const view = render(
    <ThemeContext.Provider value={DEFAULT_THEME}>
      <EffortPicker
        current="high"
        availableLevels={['low', 'medium', 'high', 'xhigh', 'max']}
        onSelect={onSelect}
        onCancel={onCancel}
        {...overrides}
      />
    </ThemeContext.Provider>,
  );
  return { view, onSelect, onCancel };
}

async function write(view: ReturnType<typeof render>, value: string) {
  view.stdin.write(value);
  await wait(20);
}

afterEach(cleanup);

describe('EffortPicker', () => {
  it('highlights the current level and renders level descriptions', () => {
    const { view } = renderPicker();
    const frame = stripAnsi(view.lastFrame());

    expect(frame).toContain('Set effort level');
    expect(frame).toContain('› high');
    expect(frame).toContain('(current)');
    expect(frame).toContain('Maximum reasoning depth');
  });

  it('navigates with arrow keys and selects with Enter', async () => {
    const { view, onSelect } = renderPicker();

    await write(view, '\x1b[B');
    expect(stripAnsi(view.lastFrame())).toContain('› xhigh');
    await write(view, '\r');

    expect(onSelect).toHaveBeenCalledWith('xhigh');
  });

  it('selects the latest level when Enter immediately follows navigation', async () => {
    const { view, onSelect } = renderPicker();

    view.stdin.write('\x1b[B');
    view.stdin.write('\r');
    await wait(75);

    expect(onSelect).toHaveBeenCalledWith('xhigh');
  });

  it('wraps within a restricted level list', async () => {
    const { view, onSelect } = renderPicker({
      current: 'high',
      availableLevels: ['low', 'high'],
    });

    expect(stripAnsi(view.lastFrame())).not.toContain('medium');
    await write(view, '\x1b[B');
    expect(stripAnsi(view.lastFrame())).toContain('› low');
    await write(view, '\r');

    expect(onSelect).toHaveBeenCalledWith('low');
  });

  it('cancels with Esc', async () => {
    const { view, onCancel } = renderPicker();
    await write(view, '\x1b');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('keeps the picker open and reports selection failures', async () => {
    const { view } = renderPicker({
      onSelect: () => ({ ok: false, error: 'settings.local.json is read-only' }),
    });

    await write(view, '\r');
    const frame = stripAnsi(view.lastFrame());
    expect(frame).toContain('Set effort level');
    expect(frame).toContain('settings.local.json is read-only');
  });
});
