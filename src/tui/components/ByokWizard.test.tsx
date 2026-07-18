import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { DensityContext, type TuiDensity } from '../density.js';
import { defaultConfig } from '../../test/fixtures.js';
import { ByokWizard } from './ByokWizard.js';

function withTheme(children: React.ReactElement): React.ReactElement {
  return <ThemeContext.Provider value={DEFAULT_THEME}>{children}</ThemeContext.Provider>;
}

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function createWizard(
  overrides: Partial<React.ComponentProps<typeof ByokWizard>> = {},
  density: TuiDensity = 'compact',
) {
  const onSave = vi.fn(() => ({ ok: true }));
  const onCancel = vi.fn();
  const discover = vi.fn(async () => [{ id: 'model-a', label: 'Model A' }, { id: 'model-b' }]);
  const view = render(
    withTheme(
      <DensityContext.Provider value={density}>
        <ByokWizard
          retry={defaultConfig().retry}
          onSave={onSave}
          onCancel={onCancel}
          discover={discover}
          {...overrides}
        />
      </DensityContext.Provider>,
    ),
  );
  return { view, onSave, onCancel, discover };
}

async function write(view: ReturnType<typeof render>, value: string) {
  view.stdin.write(value);
  await wait(20);
}

async function waitForText(view: ReturnType<typeof render>, text: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (stripAnsi(view.lastFrame()).includes(text)) return;
    await wait(10);
  }
  throw new Error(`Timed out waiting for "${text}" in:\n${stripAnsi(view.lastFrame())}`);
}

async function advanceToApiKey(view: ReturnType<typeof render>) {
  await write(view, 'gateway');
  await write(view, '\r');
  await waitForText(view, 'Protocol');
  await write(view, '\r');
  await waitForText(view, 'Base URL');
  await write(view, '\r');
  await waitForText(view, 'API key');
}

async function advanceToModelChoice(view: ReturnType<typeof render>, key = 'super-secret-key') {
  await advanceToApiKey(view);
  await write(view, key);
  await write(view, '\r');
  await waitForText(view, 'Choose models');
}

afterEach(cleanup);

describe('ByokWizard', () => {
  it('removes optional guidance in tight terminals', () => {
    const { view } = createWizard({}, 'tight');
    const output = stripAnsi(view.lastFrame());

    expect(output).toContain('Provider ID');
    expect(output).not.toContain('Example: openrouter');
    expect(output).not.toContain('Ctrl+C cancel');
  });

  it('masks an API key and never renders its raw value', async () => {
    const { view } = createWizard();
    await advanceToApiKey(view);
    await write(view, 'super-secret-key');
    const output = stripAnsi(view.lastFrame());
    expect(output).not.toContain('super-secret-key');
    expect(output).toContain('••••');
  });

  it('discovers models, supports multi-select, and saves a redacted draft', async () => {
    const { view, onSave, discover } = createWizard();
    await advanceToModelChoice(view);
    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'super-secret-key',
      }),
    );
    expect(stripAnsi(view.lastFrame())).toContain('Model A');

    expect(stripAnsi(view.lastFrame())).toContain('2 selected');
    await write(view, '\r');
    await write(view, 'Gateway model');
    await write(view, '\r');
    expect(stripAnsi(view.lastFrame())).toContain('2 selected');
    expect(stripAnsi(view.lastFrame())).not.toContain('super-secret-key');

    await write(view, '\r');
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'gateway',
        activeModelId: 'model-a',
        activeLabel: 'Gateway model',
        models: [{ id: 'model-a', label: 'Model A' }, { id: 'model-b' }],
      }),
    );
  });

  it('offers retry and manual fallback after discovery fails', async () => {
    const discover = vi.fn(async () => {
      throw new Error('This endpoint does not expose a supported model-list API.');
    });
    const { view } = createWizard({ discover });
    await advanceToApiKey(view);
    await write(view, 'super-secret-key');
    await write(view, '\r');
    await waitForText(view, 'm enter model manually');
    expect(stripAnsi(view.lastFrame())).toContain('m enter model manually');
    await write(view, 'm');
    await write(view, 'manual-model');
    await write(view, '\r');
    await write(view, '\r');
    expect(stripAnsi(view.lastFrame())).toContain('manual-model');
  });

  it('shows save errors and remains on review', async () => {
    const onSave = vi.fn(() => ({ ok: false, error: 'disk full' }));
    const { view } = createWizard({ onSave });
    await advanceToModelChoice(view);
    await write(view, '\r');
    await write(view, '\r');
    await write(view, '\r');
    await wait(10);
    expect(stripAnsi(view.lastFrame())).toContain('disk full');
    expect(stripAnsi(view.lastFrame())).toContain('Review');
  });

  it('cancels from the first step with Escape', async () => {
    const { view, onCancel } = createWizard();
    await write(view, '\x1b');
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
