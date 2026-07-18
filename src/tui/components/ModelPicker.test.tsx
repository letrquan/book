import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { defaultConfig } from '../../test/fixtures.js';
import { ModelPicker } from './ModelPicker.js';

function withTheme(children: React.ReactElement): React.ReactElement {
  return <ThemeContext.Provider value={DEFAULT_THEME}>{children}</ThemeContext.Provider>;
}

function renderPicker(overrides: Partial<React.ComponentProps<typeof ModelPicker>> = {}) {
  const onPick = vi.fn(() => ({ ok: true }));
  const onSaveProvider = vi.fn(() => ({ ok: true }));
  const view = render(
    withTheme(
      <ModelPicker
        options={[
          { id: 'built-in', label: 'Built In', custom: false, effort: false },
          {
            id: 'gateway/custom',
            label: 'Custom',
            custom: true,
            providerId: 'gateway',
            effort: true,
          },
        ]}
        currentModel="built-in"
        currentEffort="high"
        hasPriorOutput={false}
        providers={{
          gateway: {
            type: 'openai',
            baseURL: 'https://gateway.test/v1',
            apiKey: 'secret',
            models: { custom: {} },
          },
        }}
        workspace="."
        retry={defaultConfig().retry}
        onPick={onPick}
        onPickEffort={vi.fn(() => ({ ok: true }))}
        onSaveProvider={onSaveProvider}
        onCancel={vi.fn()}
        {...overrides}
      />,
    ),
  );
  return { view, onPick, onSaveProvider };
}

async function write(view: ReturnType<typeof render>, value: string) {
  view.stdin.write(value);
  await wait(20);
}

afterEach(cleanup);

describe('ModelPicker', () => {
  it('renders custom models and the add-BYOK action', () => {
    const { view } = renderPicker();
    expect(view.lastFrame()).toContain('Custom  gateway');
    expect(view.lastFrame()).toContain('Add BYOK provider');
    expect(view.lastFrame()).toContain('Alt+A add BYOK');
  });

  it('distinguishes save-default and session-only selections', () => {
    const first = renderPicker();
    first.view.stdin.write('\r');
    expect(first.onPick).toHaveBeenCalledWith('built-in', true);
    cleanup();

    const second = renderPicker();
    second.view.stdin.write('\x1bs');
    expect(second.onPick).toHaveBeenCalledWith('built-in', false);
  });

  it('filters models immediately and selects from the filtered list', async () => {
    const { view, onPick } = renderPicker();
    await write(view, 'gateway');

    expect(view.lastFrame()).toContain('Filter: gateway');
    expect(view.lastFrame()).toContain('Custom  gateway');
    expect(view.lastFrame()).not.toContain('Built In');

    await write(view, '\r');
    expect(onPick).toHaveBeenCalledWith('gateway/custom', true);
  });

  it('opens the BYOK wizard with Alt+A', async () => {
    const { view } = renderPicker();
    await write(view, '\x1ba');
    expect(view.lastFrame()).toContain('Add BYOK provider');
    expect(view.lastFrame()).toContain('Provider ID');
  });

  it('refreshes a custom provider with r', async () => {
    const discover = vi.fn(async () => [{ id: 'custom' }, { id: 'new-model' }]);
    const { view, onSaveProvider } = renderPicker({ discover });
    await write(view, '\x1b[B');
    await write(view, '\x1br');
    await wait(10);
    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'openai',
        baseUrl: 'https://gateway.test/v1',
        apiKey: 'secret',
      }),
    );
    expect(onSaveProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'gateway',
        activeModelId: 'custom',
        replaceModels: true,
      }),
    );
  });

  it('keeps the effort control and respects restricted levels', async () => {
    const onPickEffort = vi.fn(() => ({ ok: true }));
    const { view } = renderPicker({
      currentEffort: 'low',
      effortLevels: ['low', 'high'],
      onPickEffort,
    });

    await write(view, '\x1b[B');
    await write(view, '\x1be');
    await write(view, '\x1b[C');

    expect(onPickEffort).toHaveBeenCalledWith('high');
  });
});
