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

async function advanceToModelSource(view: ReturnType<typeof render>, key = 'super-secret-key') {
  await advanceToApiKey(view);
  await write(view, key);
  await write(view, '\r');
  await waitForText(view, 'Discover models automatically');
}

async function advanceToModelChoice(view: ReturnType<typeof render>, key = 'super-secret-key') {
  await advanceToModelSource(view, key);
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

  it('never types a mouse report into the base URL or API key', async () => {
    const { view, discover } = createWizard();
    await write(view, 'gateway');
    await write(view, '\r');
    await waitForText(view, 'Protocol');
    await write(view, '\r');
    await waitForText(view, 'Base URL');

    // Transcript mouse reports also reach Ink's input listeners; the focused
    // credential field must never accept them as ordinary text.
    await write(view, 'https://api.example.com/v1');
    await write(view, '\x1b[<0;12;4M');
    await write(view, '\x1b[<0;12;4m');
    expect(stripAnsi(view.lastFrame())).toContain('https://api.example.com/v1');
    expect(stripAnsi(view.lastFrame())).not.toContain('[<0;12;4');

    await write(view, '\r');
    await waitForText(view, 'API key');
    await write(view, 'super-secret-key');
    await write(view, '\x1b[<64;12;4M');
    await write(view, '\r');
    await waitForText(view, 'Discover models automatically');
    await write(view, '\r');
    await waitForText(view, 'Model A');

    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'super-secret-key',
      }),
    );
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

  it('asks how to fill the model list before contacting the endpoint', async () => {
    const { view, discover } = createWizard();
    await advanceToModelSource(view);

    const frame = stripAnsi(view.lastFrame());
    expect(frame).toContain('❯ Discover models automatically');
    expect(frame).toContain('Enter model IDs manually');
    expect(discover).not.toHaveBeenCalled();
  });

  it('skips discovery entirely when the manual source is chosen', async () => {
    const { view, onSave, discover } = createWizard();
    await advanceToModelSource(view);
    await write(view, '\x1b[B');
    await write(view, '\r');
    await waitForText(view, 'Model IDs');

    expect(discover).not.toHaveBeenCalled();

    await write(view, 'deepseek-chat, deepseek-reasoner');
    await write(view, '\r');
    await waitForText(view, 'Display label');
    await write(view, '\r');
    expect(stripAnsi(view.lastFrame())).toContain('2 selected (entered manually)');

    await write(view, '\r');
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'gateway',
        activeModelId: 'deepseek-chat',
        manual: true,
        models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
      }),
    );
  });

  it('returns to the source choice from manual entry', async () => {
    const { view } = createWizard();
    await advanceToModelSource(view);
    await write(view, '\x1b[B');
    await write(view, '\r');
    await waitForText(view, 'Model IDs');
    await write(view, '\x1b');
    await waitForText(view, 'Discover models automatically');

    expect(stripAnsi(view.lastFrame())).toContain('Step 5/9');
  });

  it('rejects a manual entry with no usable model ID', async () => {
    const { view, onSave } = createWizard();
    await advanceToModelSource(view);
    await write(view, '\x1b[B');
    await write(view, '\r');
    await waitForText(view, 'Model IDs');
    await write(view, ' , , ');
    await write(view, '\r');

    expect(stripAnsi(view.lastFrame())).toContain('Enter at least one model ID.');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('routes an endpoint that lists nothing to the fallback screen', async () => {
    const discover = vi.fn(async () => []);
    const { view } = createWizard({ discover });
    await advanceToModelSource(view);
    await write(view, '\r');
    await waitForText(view, 'm enter model manually');

    expect(stripAnsi(view.lastFrame())).toContain('The endpoint did not return any models.');
    expect(stripAnsi(view.lastFrame())).not.toContain('Choose models');
  });

  it('offers retry and manual fallback after discovery fails', async () => {
    const discover = vi.fn(async () => {
      throw new Error('This endpoint does not expose a supported model-list API.');
    });
    const { view } = createWizard({ discover });
    await advanceToModelSource(view);
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
