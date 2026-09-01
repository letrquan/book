import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { defaultConfig } from '../../test/fixtures.js';
import { ModelPicker } from './ModelPicker.js';

function withTheme(children: React.ReactElement): React.ReactElement {
  return <ThemeContext.Provider value={DEFAULT_THEME}>{children}</ThemeContext.Provider>;
}

function pickerProps(
  overrides: Partial<React.ComponentProps<typeof ModelPicker>> = {},
): React.ComponentProps<typeof ModelPicker> {
  return {
    options: [
      { id: 'built-in', label: 'Built In', custom: false, effort: false },
      {
        id: 'gateway/custom',
        label: 'Custom',
        custom: true,
        providerId: 'gateway',
        effort: true,
      },
    ],
    currentModel: 'built-in',
    currentEffort: 'high',
    hasPriorOutput: false,
    providers: {
      gateway: {
        type: 'openai',
        baseURL: 'https://gateway.test/v1',
        apiKey: 'secret',
        models: { custom: {} },
      },
    },
    workspace: '.',
    retry: defaultConfig().retry,
    onPick: vi.fn(() => ({ ok: true })),
    onPickEffort: vi.fn(() => ({ ok: true })),
    onSaveProvider: vi.fn(() => ({ ok: true })),
    removableProviderIds: new Set(['gateway']),
    onRemoveProvider: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
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
  const props = pickerProps({ onPick, onSaveProvider, onRemoveProvider, ...overrides });
  const view = render(withTheme(<ModelPicker {...props} />));
  return { view, onPick, onSaveProvider, onRemoveProvider, props };
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
    expect(view.lastFrame()).toContain('gateway: 2 models listed.');
  });

  it('reports an endpoint that lists nothing instead of saving an empty catalog', async () => {
    const discover = vi.fn(async () => []);
    const { view, onSaveProvider } = renderPicker({ discover });
    await write(view, '\x1b[B');
    await write(view, '\x1br');
    await wait(10);

    expect(onSaveProvider).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain('gateway did not return any models.');
  });

  it('announces the catalog actions on a provider row', async () => {
    const { view } = renderPicker();
    expect(view.lastFrame()).not.toContain('Alt+R refresh');

    await write(view, '\x1b[B');
    expect(view.lastFrame()).toContain('Alt+R refresh gateway model list');
    expect(view.lastFrame()).toContain('Alt+M add a model manually');
  });

  it('adds hand-typed models to a provider with Alt+M', async () => {
    const { view, onSaveProvider, onPick } = renderPicker();
    await write(view, '\x1b[B');
    await write(view, '\x1bm');
    expect(view.lastFrame()).toContain('Add models to gateway');

    await write(view, 'hidden-a, hidden-b');
    await write(view, '\r');

    expect(onSaveProvider).toHaveBeenCalledWith({
      providerId: 'gateway',
      type: 'openai',
      baseURL: 'https://gateway.test/v1',
      apiKey: 'secret',
      models: [{ id: 'hidden-a' }, { id: 'hidden-b' }],
      activeModelId: 'hidden-a',
      manual: true,
      activate: false,
    });
    // Curating the catalog must not switch the model out from under the user.
    expect(onPick).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain('Added 2 models to gateway.');
  });

  it('keeps the manual form open with an inline error on a bad entry', async () => {
    const { view, onSaveProvider } = renderPicker();
    await write(view, '\x1b[B');
    await write(view, '\x1bm');
    await write(view, '   ');
    await write(view, '\r');

    expect(onSaveProvider).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain('Enter at least one model ID.');
    expect(view.lastFrame()).toContain('Add models to gateway');
  });

  it('cancels manual entry with Escape and keeps the list untouched', async () => {
    const { view, onSaveProvider } = renderPicker();
    await write(view, '\x1b[B');
    await write(view, '\x1bm');
    await write(view, 'hidden-a');
    await write(view, '\x1b');

    expect(onSaveProvider).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain('Models & BYOK providers');
    expect(view.lastFrame()).not.toContain('Filter: hidden-a');
  });

  it('refuses manual entry on a built-in model row', async () => {
    const { view, onSaveProvider } = renderPicker();
    await write(view, '\x1bm');

    expect(onSaveProvider).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain('Only custom providers can take extra models.');
  });

  it('refuses to edit the catalog of an inherited provider', async () => {
    const discover = vi.fn(async () => [{ id: 'custom' }]);
    const { view, onSaveProvider } = renderPicker({
      discover,
      removableProviderIds: new Set(),
    });
    await write(view, '\x1b[B');
    // The actions are not advertised on a row that cannot accept them.
    expect(view.lastFrame()).not.toContain('Alt+R refresh');

    await write(view, '\x1bm');
    expect(view.lastFrame()).toContain('Only BYOK providers you added can be changed.');
    expect(view.lastFrame()).not.toContain('Add models to gateway');

    await write(view, '\x1br');
    await wait(10);
    expect(discover).not.toHaveBeenCalled();
    expect(onSaveProvider).not.toHaveBeenCalled();
  });

  it('keeps the highlight on the same model when the catalog re-sorts', async () => {
    const options = [
      { id: 'built-in', label: 'Built In', custom: false, effort: false },
      { id: 'gateway/zeta', label: 'Zeta', custom: true, providerId: 'gateway', effort: true },
    ];
    const { view, onPick, onSaveProvider, props } = renderPicker({ options });
    await write(view, '\x1b[B');
    await write(view, '\x1bm');
    await write(view, 'aaa-model');
    await write(view, '\r');
    expect(onSaveProvider).toHaveBeenCalled();

    // The parent rebuilds the catalog sorted, inserting a row above Zeta.
    view.rerender(
      withTheme(
        <ModelPicker
          {...props}
          options={[
            options[0],
            {
              id: 'gateway/aaa-model',
              label: 'aaa-model',
              custom: true,
              providerId: 'gateway',
              effort: true,
            },
            options[1],
          ]}
        />,
      ),
    );
    await wait(20);

    expect(view.lastFrame()).toContain('› Zeta  gateway');
    await write(view, '\r');
    expect(onPick).toHaveBeenCalledWith('gateway/zeta', true);
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
    expect(frame).toContain('› Custom  gateway');
  });

  it('shows wide and compact removal shortcuts before selecting a provider row', () => {
    const wide = renderPicker();
    expect(wide.view.lastFrame()).toContain('Alt+D remove BYOK');
    cleanup();

    const compact = renderPicker({ compact: true });
    expect(compact.view.lastFrame()).toContain('Alt+D remove BYOK');
  });
});
