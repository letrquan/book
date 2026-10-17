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

async function write(view: ReturnType<typeof render>, value: string, delayMs = 20) {
  view.stdin.write(value);
  await wait(delayMs);
}

afterEach(cleanup);

describe('ModelPicker', () => {
  it('renders custom models and the add-BYOK action', () => {
    const { view } = renderPicker();
    expect(view.lastFrame()).toContain('§ Models');
    expect(view.lastFrame()).toContain('Custom  gateway  BYOK');
    expect(view.lastFrame()).toContain('Add BYOK provider');
    expect(view.lastFrame()).toContain('Alt+A add');
    expect(view.lastFrame()).toContain('Alt+D remove BYOK');
    // Nine, not eight: the footer became two lines so that no chord has to be
    // dropped to make room. Alt+E was advertised nowhere at all, and Alt+S
    // vanished whenever a removable provider existed.
    expect(view.lastFrame()?.split('\n').length).toBeLessThanOrEqual(9);
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

    // A fixed wait here is a race with the next frame, not a wait for it: on a
    // loaded runner the keystroke can still be in flight when the sleep ends.
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain('> gateway');
      expect(view.lastFrame()).toContain('Custom  gateway  BYOK');
      expect(view.lastFrame()).not.toContain('Built In');
    });

    await write(view, '\r');
    await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith('gateway/custom', true));
  });

  it('opens the BYOK wizard with Alt+A', async () => {
    const { view } = renderPicker();
    await write(view, '\x1ba');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Add BYOK provider'));
    expect(view.lastFrame()).toContain('Provider ID');
  });

  it('refreshes a custom provider with r', async () => {
    const discover = vi.fn(async () => [{ id: 'custom' }, { id: 'new-model' }]);
    const { view, onSaveProvider } = renderPicker({ discover });
    await write(view, '\x1b[B');
    await write(view, '\x1br');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('gateway: 2 models listed.'));
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

  it('reports an endpoint that lists nothing instead of saving an empty catalog', async () => {
    const discover = vi.fn(async () => []);
    const { view, onSaveProvider } = renderPicker({ discover });
    await write(view, '\x1b[B');
    await write(view, '\x1br');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('gateway did not return any models.'),
    );

    expect(onSaveProvider).not.toHaveBeenCalled();
  });

  it('announces the catalog actions on a provider row', async () => {
    const { view } = renderPicker();
    expect(view.lastFrame()).not.toContain('Alt+R refresh');

    await write(view, '\x1b[B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Alt+R refresh gateway'));
    expect(view.lastFrame()).toContain('Alt+M add model');
  });

  it('adds hand-typed models to a provider with Alt+M', async () => {
    const { view, onSaveProvider, onPick } = renderPicker();
    await write(view, '\x1b[B');
    await write(view, '\x1bm');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Add models to gateway'));

    await write(view, 'hidden-a, hidden-b');
    await write(view, '\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Added 2 models to gateway.'));

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
  });

  it('keeps the manual form open with an inline error on a bad entry', async () => {
    const { view, onSaveProvider } = renderPicker();
    await write(view, '\x1b[B');
    await write(view, '\x1bm');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Add models to gateway'));
    await write(view, '   ');
    await write(view, '\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Enter at least one model ID.'));

    expect(onSaveProvider).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain('Add models to gateway');
  });

  it('cancels manual entry with Escape and keeps the list untouched', async () => {
    const { view, onSaveProvider } = renderPicker();
    await write(view, '\x1b[B');
    await write(view, '\x1bm');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Add models to gateway'));
    await write(view, 'hidden-a');
    // Ink 7 flushes a lone Esc only after 20 ms, so a 20 ms wait is a coin flip.
    await write(view, '\x1b', 60);
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain('Add models to gateway'));

    expect(onSaveProvider).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain('§ Models');
    expect(view.lastFrame()).not.toContain('> hidden-a');
  });

  it('refuses manual entry on a built-in model row', async () => {
    const { view, onSaveProvider } = renderPicker();
    await write(view, '\x1bm');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Only custom providers can take extra models.'),
    );

    expect(onSaveProvider).not.toHaveBeenCalled();
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
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Only BYOK providers you added can be changed.'),
    );
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
    await vi.waitFor(() => expect(onSaveProvider).toHaveBeenCalled());

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
    await vi.waitFor(() => expect(view.lastFrame()).toContain('› Zeta  gateway'));

    await write(view, '\r');
    await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith('gateway/zeta', true));
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
    await vi.waitFor(() => expect(view.lastFrame()).toContain('← → adjust'));
    await write(view, '\x1b[C');

    await vi.waitFor(() => expect(onPickEffort).toHaveBeenCalledWith('high'));
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

    // The picker opens on the current model, which is already the BYOK row.
    await write(view, '\x1bd');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Remove BYOK provider?'));

    const frame = view.lastFrame();
    expect(frame).toContain('Provider: gateway');
    expect(frame).toContain('Models: 3');
    expect(frame).toContain('.book/settings.local.json');
    expect(frame).toContain('Removes credentials and all saved models.');
    expect(frame).toContain('Active provider: switches to next configured default.');
    expect(frame).not.toMatch(/^> /m);
  });

  it.each(['\x1b', 'n'])('cancels confirmation with %j without removing', async (key) => {
    const { view, onRemoveProvider } = renderPicker();
    await write(view, '\x1b[B');
    await write(view, '\x1bd');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Remove BYOK provider?'));
    await write(view, key, key === '\x1b' ? 60 : 20);
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain('Remove BYOK provider?'));

    expect(onRemoveProvider).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain('§ Models');
    expect(view.lastFrame()).toContain('Custom  gateway  BYOK');
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

  it('confirms a removal that arrives in the same chunk as the key that opened it', async () => {
    // Alt+D opens the confirmation by setting state; the `y` that answers it was
    // dispatched by whichever branch was live at the last render. In one chunk
    // that is still the list branch, so the confirmation was never answered and
    // nothing was removed.
    const { view, onRemoveProvider } = renderPicker();
    await write(view, '\x1b[B');
    await write(view, '\x1bdy');

    expect(onRemoveProvider).toHaveBeenCalledTimes(1);
    expect(onRemoveProvider).toHaveBeenCalledWith('gateway');
  });

  it('keeps confirmation open with an inline error after removal fails', async () => {
    const onRemoveProvider = vi.fn(() => ({ ok: false as const, error: 'settings are read-only' }));
    const { view } = renderPicker({ onRemoveProvider });
    await write(view, '\x1b[B');
    await write(view, '\x1bd');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Remove BYOK provider?'));
    await write(view, '\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('settings are read-only'));
  });

  it('does nothing destructive on a built-in model', async () => {
    const { view, onRemoveProvider } = renderPicker();
    await write(view, '\x1bd');

    expect(onRemoveProvider).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain('> type to filter');
    expect(view.lastFrame()).not.toContain('Remove BYOK provider?');
  });

  it('explains that inherited custom providers are read-only', async () => {
    const { view, onRemoveProvider } = renderPicker({ removableProviderIds: new Set() });
    await write(view, '\x1b[B');
    await write(view, '\x1bd');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Only BYOK providers you added can be removed.'),
    );

    expect(onRemoveProvider).not.toHaveBeenCalled();
  });

  it('restores the same filter and selected row after cancellation', async () => {
    const { view } = renderPicker();
    await write(view, 'gateway');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('> gateway'));
    await write(view, '\x1bd');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Remove BYOK provider?'));
    await write(view, 'n');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('› Custom  gateway'));

    const frame = view.lastFrame();
    expect(frame).toContain('> gateway');
  });

  it('shows wide and compact removal shortcuts before selecting a provider row', () => {
    const wide = renderPicker();
    expect(wide.view.lastFrame()).toContain('Alt+D remove BYOK');
    cleanup();

    const compact = renderPicker({ compact: true });
    expect(compact.view.lastFrame()).toContain('Alt+D remove BYOK');
  });

  describe('initial cursor', () => {
    it('opens on the current model when it is not the first option', async () => {
      const { view, onPick } = renderPicker({ currentModel: 'gateway/custom' });
      expect(view.lastFrame()).toContain('› Custom');

      await write(view, '\r');
      await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith('gateway/custom', true));
    });

    it('scrolls the current model into the window when it is the last of many', () => {
      const options = Array.from({ length: 25 }, (_, i) => ({
        id: `model-${i}`,
        label: `Model ${i}`,
        custom: false,
        effort: false,
      }));
      const { view } = renderPicker({ options, currentModel: 'model-24', maxVisibleModels: 10 });

      expect(view.lastFrame()).toContain('› Model 24  ✓ current');
      expect(view.lastFrame()).not.toContain('Model 0 ');
    });

    it('falls back to the first row when the current model matches nothing', async () => {
      const { view, onPick } = renderPicker({ currentModel: 'not-listed' });
      expect(view.lastFrame()).toContain('› Built In');

      await write(view, '\r');
      await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith('built-in', true));
    });
  });

  describe('with an off row', () => {
    const offOption = { label: 'Off — no advisor' };

    /** The advisor picker's shape: no catalog management, nothing selected yet. */
    function renderOffPicker(overrides: Partial<React.ComponentProps<typeof ModelPicker>> = {}) {
      const rendered = renderPicker({
        title: 'Choose advisor model',
        allowProviderManagement: false,
        allowSessionOnly: false,
        currentModel: '',
        effortLevels: [],
        currentEffort: undefined,
        offOption,
        onPickOff: vi.fn(() => ({ ok: true })),
        ...overrides,
      });
      return { ...rendered, onPickOff: rendered.props.onPickOff };
    }

    it('renders the off row after every model, and no add-provider row', () => {
      const { view } = renderOffPicker();
      const frame = view.lastFrame() ?? '';

      expect(frame).toContain('§ Choose advisor model');
      expect(frame).toContain('Off — no advisor');
      expect(frame).not.toContain('Add BYOK provider');
      expect(frame.indexOf('Built In')).toBeLessThan(frame.indexOf('Custom'));
      expect(frame.indexOf('Custom')).toBeLessThan(frame.indexOf('Off — no advisor'));
      // The row is a choice, not a model: the meta line keeps counting models.
      expect(frame).toContain('2 models');
    });

    it('picks off with Enter, once, and never as a model', async () => {
      const { view, onPick, onPickOff } = renderOffPicker({ currentModel: 'built-in' });
      await write(view, '\x1b[B');
      await write(view, '\x1b[B');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('› Off — no advisor'));

      await write(view, '\r');
      await write(view, '\r');

      expect(onPickOff).toHaveBeenCalledTimes(1);
      expect(onPick).not.toHaveBeenCalled();
    });

    it('still picks the model rows above it', async () => {
      const { view, onPick, onPickOff } = renderOffPicker({ currentModel: 'built-in' });
      await write(view, '\x1b[B');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('› Custom'));
      await write(view, '\r');

      await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith('gateway/custom', true));
      expect(onPickOff).not.toHaveBeenCalled();
    });

    it('shows why turning it off failed and lets Enter try again', async () => {
      const onPickOff = vi
        .fn<() => { ok: boolean; error?: string }>()
        .mockReturnValueOnce({ ok: false, error: 'settings are read-only' })
        .mockReturnValue({ ok: true });
      const { view } = renderOffPicker({ onPickOff, currentModel: 'built-in' });
      await write(view, '\x1b[A');
      await write(view, '\r');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('✕ settings are read-only'));
      expect(onPickOff).toHaveBeenCalledTimes(1);

      // A failed pick must not latch: the picker is still open to be retried.
      await write(view, '\r');
      await vi.waitFor(() => expect(onPickOff).toHaveBeenCalledTimes(2));
    });

    it('marks the off row current when the setting is off, and a model otherwise', () => {
      const off = renderOffPicker({ currentModel: '' });
      const offFrame = off.view.lastFrame() ?? '';
      expect(offFrame).toMatch(/Off — no advisor {2}✓ current/);
      expect(offFrame.match(/✓ current/g)).toHaveLength(1);
      cleanup();

      const on = renderOffPicker({ currentModel: 'built-in' });
      const onFrame = on.view.lastFrame() ?? '';
      expect(onFrame).toMatch(/Built In {2}✓ current/);
      expect(onFrame).not.toMatch(/Off — no advisor {2}✓ current/);
      expect(onFrame.match(/✓ current/g)).toHaveLength(1);
    });

    it('opens with the cursor on the off row when the setting is off', async () => {
      const { view, onPick, onPickOff } = renderOffPicker({ currentModel: '' });
      expect(view.lastFrame()).toContain('› Off — no advisor');

      await write(view, '\r');
      await vi.waitFor(() => expect(onPickOff).toHaveBeenCalledTimes(1));
      expect(onPick).not.toHaveBeenCalled();
    });

    it('renders the off row on open even when the list is longer than the window', () => {
      const options = Array.from({ length: 12 }, (_, i) => ({
        id: `model-${i}`,
        label: `Model ${i}`,
        custom: false,
        effort: false,
      }));
      const { view } = renderOffPicker({ options, currentModel: '', maxVisibleModels: 10 });
      const frame = view.lastFrame() ?? '';

      expect(frame).toContain('› Off — no advisor  ✓ current');
      expect(frame).not.toContain('Model 0');
      expect(frame).toContain('Model 11');
    });

    it('keeps the off row out of the cursor logic when provider management is on', () => {
      const { view } = renderPicker({ currentModel: '', offOption });
      expect(view.lastFrame()).toContain('› Built In');
    });

    it('keeps the off row when typing filters the models away', async () => {
      const { view, onPickOff } = renderOffPicker();
      await write(view, 'gateway');
      await vi.waitFor(() => {
        expect(view.lastFrame()).toContain('> gateway');
        expect(view.lastFrame()).not.toContain('Built In');
      });
      expect(view.lastFrame()).toContain('Custom');
      expect(view.lastFrame()).toContain('Off — no advisor');
      expect(view.lastFrame()).toContain('1 model');

      await write(view, '-nothing-matches');
      await vi.waitFor(() => {
        expect(view.lastFrame()).not.toContain('Custom');
        expect(view.lastFrame()).toContain('0 models');
      });
      // With no model left it is the only row, and the cursor is on it.
      expect(view.lastFrame()).toContain('› Off — no advisor');

      await write(view, '\r');
      await vi.waitFor(() => expect(onPickOff).toHaveBeenCalledTimes(1));
    });

    it('wraps the arrow keys through the off row', async () => {
      const { view } = renderOffPicker({ currentModel: 'built-in' });
      expect(view.lastFrame()).toContain('› Built In');

      await write(view, '\x1b[A');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('› Off — no advisor'));

      await write(view, '\x1b[B');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('› Built In'));

      await write(view, '\x1b[B');
      await write(view, '\x1b[B');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('› Off — no advisor'));
    });

    it('leaves the Alt chords inert on the off row', async () => {
      const discover = vi.fn(async () => [{ id: 'custom' }]);
      const { view, onPick, onPickOff, onSaveProvider, onRemoveProvider } = renderOffPicker({
        // Alt+S and Alt+E are live elsewhere in this picker; only the row differs.
        allowSessionOnly: true,
        effortLevels: ['low', 'high'],
        currentEffort: 'low',
        currentModel: 'built-in',
        discover,
      });
      await write(view, '\x1b[A');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('› Off — no advisor'));

      for (const chord of ['\x1bs', '\x1be', '\x1br', '\x1bm', '\x1bd']) await write(view, chord);

      expect(view.lastFrame()).not.toContain('Effort [');
      expect(view.lastFrame()).not.toContain('✕');
      expect(view.lastFrame()).toContain('> type to filter');
      expect(discover).not.toHaveBeenCalled();
      expect(onPick).not.toHaveBeenCalled();
      expect(onSaveProvider).not.toHaveBeenCalled();
      expect(onRemoveProvider).not.toHaveBeenCalled();
      expect(onPickOff).not.toHaveBeenCalled();

      // The row is still selected and still works afterwards.
      await write(view, '\r');
      await vi.waitFor(() => expect(onPickOff).toHaveBeenCalledTimes(1));
    });

    it('offers provider management and no off row when asked for both', async () => {
      const onPickOff = vi.fn(() => ({ ok: true }));
      const { view } = renderPicker({ offOption, onPickOff });
      const frame = view.lastFrame() ?? '';
      expect(frame).toContain('Add BYOK provider');
      expect(frame).not.toContain('Off — no advisor');

      // Down past the last model lands on the add row, not on a hidden off row.
      await write(view, '\x1b[B');
      await write(view, '\x1b[B');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('› + Add BYOK provider'));
      await write(view, '\x1b[B');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('› Built In'));
      expect(onPickOff).not.toHaveBeenCalled();
    });

    it('does nothing on Enter when no handler was given for the off row', async () => {
      const { view, onPick } = renderOffPicker({ onPickOff: undefined, currentModel: 'built-in' });
      await write(view, '\x1b[A');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('› Off — no advisor'));
      await write(view, '\r');

      expect(onPick).not.toHaveBeenCalled();
      expect(view.lastFrame()).not.toContain('✕');
    });
  });

  describe('allowSessionOnly', () => {
    it('is on by default: Alt+S is advertised and picks for this session', () => {
      const { view, onPick } = renderPicker();
      expect(view.lastFrame()).toContain('Alt+S session');

      view.stdin.write('\x1bs');
      expect(onPick).toHaveBeenCalledWith('built-in', false);
    });

    it('ignores Alt+S and hides the hint when off', async () => {
      const { view, onPick } = renderPicker({
        allowProviderManagement: false,
        allowSessionOnly: false,
      });
      expect(view.lastFrame()).not.toContain('Alt+S');
      expect(view.lastFrame()).toContain('Enter save');

      await write(view, '\x1bs');
      // Alt+S is not typed into the filter either.
      expect(view.lastFrame()).toContain('> type to filter');

      // Had Alt+S picked, the latch would have swallowed this Enter's `true`.
      await write(view, '\r');
      await vi.waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
      expect(onPick).toHaveBeenCalledWith('built-in', true);
    });
  });
});
