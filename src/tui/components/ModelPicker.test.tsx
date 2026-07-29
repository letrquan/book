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
  const onRemoveProvider = vi.fn((providerId: string) => ({
    ok: true as const,
    providerId,
    removedModelCount: 1,
    activeModel: 'built-in',
    switched: false,
    inheritedProviderRevealed: false,
  }));
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
        removableProviderIds={new Set(['gateway'])}
        onRemoveProvider={onRemoveProvider}
        onCancel={vi.fn()}
        {...overrides}
      />,
    ),
  );
  return { view, onPick, onSaveProvider, onRemoveProvider };
}

async function write(view: ReturnType<typeof render>, value: string) {
  view.stdin.write(value);
  await wait(20);
}

afterEach(cleanup);

describe('ModelPicker', () => {
  it('renders custom models and the add-BYOK action', () => {
    const { view } = renderPicker();
    expect(view.lastFrame()).toContain('Models & BYOK providers');
    expect(view.lastFrame()).toContain('Custom  gateway  [BYOK]');
    expect(view.lastFrame()).toContain('Add BYOK provider');
    expect(view.lastFrame()).toContain('Alt+A add');
    expect(view.lastFrame()).toContain('Alt+D remove BYOK');
    expect(view.lastFrame()?.split('\n').length).toBeLessThanOrEqual(8);
  });

  it('hides provider-management actions while choosing a subagent model', async () => {
    const { view, onSaveProvider, onRemoveProvider } = renderPicker({
      allowProviderManagement: false,
    });

    expect(view.lastFrame()).toContain('Choose subagent model');
    expect(view.lastFrame()).not.toContain('Add BYOK provider');
    expect(view.lastFrame()).not.toContain('Alt+A');
    expect(view.lastFrame()).not.toContain('Alt+D');

    await write(view, '\x1ba');
    await write(view, '\x1bd');
    expect(onSaveProvider).not.toHaveBeenCalled();
    expect(onRemoveProvider).not.toHaveBeenCalled();
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
    expect(view.lastFrame()).toContain('Custom  gateway  [BYOK]');
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

  it('opens provider-level confirmation for a removable BYOK row', async () => {
    const { view } = renderPicker({
      currentModel: 'gateway/custom',
      removableProviderModelCounts: new Map([['gateway', 3]]),
      providers: {
        gateway: {
          type: 'openai',
          models: { custom: {}, second: {}, third: {}, inherited: {} },
        },
      },
    });

    await write(view, '\x1b[B');
    await write(view, '\x1bd');

    const frame = view.lastFrame();
    expect(frame).toContain('Remove BYOK provider?');
    expect(frame).toContain('Provider: gateway');
    expect(frame).toContain('Models: 3');
    expect(frame).toContain('.book/settings.local.json');
    expect(frame).toContain('Removes credentials and all saved models.');
    expect(frame).toContain('Active provider: switches to next configured default.');
    expect(frame).not.toContain('Filter:');
  });

  it.each(['\x1b', 'n'])('cancels confirmation with %j without removing', async (key) => {
    const { view, onRemoveProvider } = renderPicker();
    await write(view, '\x1b[B');
    await write(view, '\x1bd');
    await write(view, key);

    expect(onRemoveProvider).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain('Models & BYOK providers');
    expect(view.lastFrame()).toContain('Custom  gateway  [BYOK]');
  });

  it.each(['\r', 'y'])('confirms removal exactly once with %j', async (key) => {
    const { view, onRemoveProvider } = renderPicker();
    await write(view, '\x1b[B');
    await write(view, '\x1bd');
    await write(view, key);
    await write(view, key);

    expect(onRemoveProvider).toHaveBeenCalledTimes(1);
    expect(onRemoveProvider).toHaveBeenCalledWith('gateway');
  });

  it('keeps confirmation open with an inline error after removal fails', async () => {
    const onRemoveProvider = vi.fn(() => ({ ok: false as const, error: 'settings are read-only' }));
    const { view } = renderPicker({ onRemoveProvider });
    await write(view, '\x1b[B');
    await write(view, '\x1bd');
    await write(view, '\r');

    expect(view.lastFrame()).toContain('Remove BYOK provider?');
    expect(view.lastFrame()).toContain('settings are read-only');
  });

  it('does nothing destructive on a built-in model', async () => {
    const { view, onRemoveProvider } = renderPicker();
    await write(view, '\x1bd');

    expect(onRemoveProvider).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain('Filter: (type to filter)');
    expect(view.lastFrame()).not.toContain('Remove BYOK provider?');
  });

  it('explains that inherited custom providers are read-only', async () => {
    const { view, onRemoveProvider } = renderPicker({ removableProviderIds: new Set() });
    await write(view, '\x1b[B');
    await write(view, '\x1bd');

    expect(onRemoveProvider).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain('Only BYOK providers you added can be removed.');
  });

  it('restores the same filter and selected row after cancellation', async () => {
    const { view } = renderPicker();
    await write(view, 'gateway');
    await write(view, '\x1bd');
    await write(view, 'n');

    const frame = view.lastFrame();
    expect(frame).toContain('Filter: gateway');
    expect(frame).toContain('❯ Custom  gateway');
  });

  it('shows wide and compact removal shortcuts before selecting a provider row', () => {
    const wide = renderPicker();
    expect(wide.view.lastFrame()).toContain('Alt+D remove BYOK');
    cleanup();

    const compact = renderPicker({ compact: true });
    expect(compact.view.lastFrame()).toContain('Alt+D remove BYOK');
  });
});
