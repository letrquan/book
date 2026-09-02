import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { LoginPicker, type LoginRunner } from './LoginPicker.js';
import type { AuthProfile } from '../../auth/profiles.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function profile(overrides: Partial<AuthProfile> = {}): AuthProfile {
  return {
    id: 'anthropic',
    label: 'Anthropic (Claude subscription)',
    providerType: 'anthropic',
    authorizeUrl: 'https://example.test/oauth/authorize',
    tokenUrl: 'https://example.test/oauth/token',
    scopes: ['user:inference'],
    redirectPort: 54545,
    redirectPath: '/callback',
    baseUrl: 'https://api.example.test/v1',
    headers: {},
    defaultModel: 'claude-sonnet-5',
    clientId: 'client-123',
    ...overrides,
  };
}

/** A runner that reports progress, then blocks until the test resolves it. */
function scriptedRunner() {
  let release: (() => void) | undefined;
  let rejectWith: ((error: Error) => void) | undefined;
  const started: AuthProfile[] = [];
  let aborted = false;

  const runLogin: LoginRunner = (options) => {
    started.push(options.profile as AuthProfile);
    options.signal?.addEventListener('abort', () => {
      aborted = true;
    });
    options.events.onAuthorizeUrl('https://example.test/oauth/authorize?x=1', true);
    options.events.onWaiting?.({ port: 54545, timeoutMs: 300_000 });
    return new Promise((resolve, reject) => {
      release = () => resolve({ credential: { profile: options.profile.id } });
      rejectWith = reject;
    });
  };

  return {
    runLogin,
    started,
    succeed: () => release?.(),
    fail: (message: string) => rejectWith?.(new Error(message)),
    get aborted() {
      return aborted;
    },
  };
}

function renderPicker(overrides: Partial<React.ComponentProps<typeof LoginPicker>> = {}) {
  const onActivate = vi.fn(() => ({ ok: true }));
  const onClose = vi.fn();
  const previewActivation = vi.fn(() => ({
    ok: true as const,
    model: 'claude-sonnet-5',
    baseUrl: 'https://api.example.test/v1',
  }));
  const view = render(
    <ThemeContext.Provider value={DEFAULT_THEME}>
      <LoginPicker
        profiles={[profile(), profile({ id: 'codex', label: 'OpenAI Codex', clientId: 'c-2' })]}
        signedIn={[]}
        onActivate={onActivate}
        previewActivation={previewActivation}
        onClose={onClose}
        {...overrides}
      />
    </ThemeContext.Provider>,
  );
  return { view, onActivate, onClose, previewActivation };
}

async function write(view: ReturnType<typeof render>, value: string) {
  view.stdin.write(value);
  await wait(20);
}

const ENTER = '\r';
const ESC = '\x1B';
const DOWN = '\x1B[B';

afterEach(cleanup);

describe('LoginPicker', () => {
  it('lists profiles with their credential and client-id state', () => {
    const { view } = renderPicker({ signedIn: ['codex'], activeProfile: 'codex' });
    const frame = stripAnsi(view.lastFrame());

    expect(frame).toContain('Sign in with a subscription');
    expect(frame).toContain('anthropic');
    expect(frame).toContain('signed in, active');
  });

  it('preselects the profile named by /login <profile>', () => {
    const { view } = renderPicker({ initialProfileId: 'codex' });
    // `›`, not `❯`. This picker was the last component still spelling the
    // selection marker its own way; moving it onto ListPicker settles it.
    expect(stripAnsi(view.lastFrame())).toContain('› codex');
  });

  it('refuses a profile with no client id without starting a flow', async () => {
    const runner = scriptedRunner();
    const { view } = renderPicker({
      profiles: [profile({ clientId: '' })],
      runLogin: runner.runLogin,
    });

    await write(view, ENTER);

    expect(runner.started).toHaveLength(0);
    expect(stripAnsi(view.lastFrame())).toContain('client id');
  });

  it('shows the authorization URL and the redirect it is waiting on', async () => {
    const runner = scriptedRunner();
    const { view } = renderPicker({ runLogin: runner.runLogin });

    await write(view, ENTER);
    const frame = stripAnsi(view.lastFrame());

    expect(frame).toContain('Opened your browser at:');
    expect(frame).toContain('https://example.test/oauth/authorize?x=1');
    expect(frame).toContain('http://127.0.0.1:54545/callback');
  });

  it('aborts the flow and returns to the list on Esc', async () => {
    const runner = scriptedRunner();
    const { view, onClose } = renderPicker({ runLogin: runner.runLogin });

    await write(view, ENTER);
    await write(view, ESC);

    expect(runner.aborted).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(stripAnsi(view.lastFrame())).toContain('Sign in with a subscription');
  });

  it('aborts the flow when the overlay unmounts mid-login', async () => {
    const runner = scriptedRunner();
    const { view } = renderPicker({ runLogin: runner.runLogin });

    await write(view, ENTER);
    view.unmount();
    await wait(20);

    expect(runner.aborted).toBe(true);
  });

  it('asks before spending the new credential, and activates on Enter', async () => {
    const runner = scriptedRunner();
    const { view, onActivate } = renderPicker({ runLogin: runner.runLogin });

    await write(view, ENTER);
    runner.succeed();
    await wait(20);

    expect(stripAnsi(view.lastFrame())).toContain('Use this subscription for future turns?');
    expect(onActivate).not.toHaveBeenCalled();

    await write(view, ENTER);

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(stripAnsi(view.lastFrame())).toContain('Now spending');
  });

  it('keeps the previous credential when activation is declined', async () => {
    const runner = scriptedRunner();
    const { view, onActivate } = renderPicker({ runLogin: runner.runLogin });

    await write(view, ENTER);
    runner.succeed();
    await wait(20);
    await write(view, 'n');

    expect(onActivate).not.toHaveBeenCalled();
    const frame = stripAnsi(view.lastFrame());
    expect(frame).toContain('still uses its previous');
    expect(frame).toContain('set auth.profile to "anthropic"');
  });

  it('surfaces an activation refusal instead of claiming success', async () => {
    const runner = scriptedRunner();
    const { view } = renderPicker({
      runLogin: runner.runLogin,
      onActivate: () => ({ ok: false, error: 'BOOK_AUTH_PROFILE is set to "codex"' }),
    });

    await write(view, ENTER);
    runner.succeed();
    await wait(20);
    await write(view, ENTER);

    expect(stripAnsi(view.lastFrame())).toContain('BOOK_AUTH_PROFILE is set to "codex"');
  });

  it('reports a failed login and returns to the list', async () => {
    const runner = scriptedRunner();
    const { view } = renderPicker({ runLogin: runner.runLogin });

    await write(view, ENTER);
    runner.fail('Timed out after 300s waiting for the browser redirect');
    await wait(20);

    expect(stripAnsi(view.lastFrame())).toContain('Timed out after 300s');

    await write(view, ENTER);
    expect(stripAnsi(view.lastFrame())).toContain('Sign in with a subscription');
  });

  it('does not re-ask to activate the profile the session already spends', async () => {
    const runner = scriptedRunner();
    const { view } = renderPicker({ runLogin: runner.runLogin, activeProfile: 'anthropic' });

    await write(view, ENTER);
    runner.succeed();
    await wait(20);
    const frame = stripAnsi(view.lastFrame());

    expect(frame).toContain('already spending');
    expect(frame).not.toContain('Use this subscription for future turns?');
  });

  it('starts one flow when Enter is pressed twice', async () => {
    const runner = scriptedRunner();
    const { view } = renderPicker({ runLogin: runner.runLogin });

    await write(view, ENTER);
    await write(view, ENTER);

    expect(runner.started).toHaveLength(1);
  });

  it('starts the profile the arrow keys landed on', async () => {
    const runner = scriptedRunner();
    const { view } = renderPicker({ runLogin: runner.runLogin });

    await write(view, DOWN);
    await write(view, ENTER);

    expect(runner.started).toHaveLength(1);
    expect(runner.started[0].id).toBe('codex');
  });

  it('closes on Esc from the list', async () => {
    const { view, onClose } = renderPicker();
    await write(view, ESC);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('names the model and endpoint activation will really use, not the profile default', async () => {
    const runner = scriptedRunner();
    const { view } = renderPicker({
      runLogin: runner.runLogin,
      // An explicit BOOK_MODEL survives the login, so the profile's own
      // defaultModel is not what the session ends up on.
      previewActivation: () => ({
        ok: true,
        model: 'gpt-4o',
        baseUrl: 'https://api.example.test/v1',
      }),
    });

    await write(view, ENTER);
    runner.succeed();
    await wait(20);
    const frame = stripAnsi(view.lastFrame());

    expect(frame).toContain('switches this session to gpt-4o');
    expect(frame).not.toContain('claude-sonnet-5');
  });

  it('refuses an impossible activation instead of asking the user to consent to it', async () => {
    const runner = scriptedRunner();
    const { view, onActivate } = renderPicker({
      runLogin: runner.runLogin,
      previewActivation: () => ({
        ok: false,
        error: 'A base-URL override points this session at https://proxy.test',
      }),
    });

    await write(view, ENTER);
    runner.succeed();
    await wait(20);
    const frame = stripAnsi(view.lastFrame());

    expect(frame).toContain('cannot spend it');
    expect(frame).toContain('https://proxy.test');
    expect(frame).not.toContain('Use this subscription for future turns?');

    // Consent was never offered, so Enter must not persist anything.
    await write(view, ENTER);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('surfaces a compact-model warning on the consent prompt', async () => {
    const runner = scriptedRunner();
    const { view } = renderPicker({
      runLogin: runner.runLogin,
      previewActivation: () => ({
        ok: true,
        model: 'claude-sonnet-5',
        baseUrl: 'https://api.example.test/v1',
        warning: 'Compaction is set to use "gpt-4o-mini"',
      }),
    });

    await write(view, ENTER);
    runner.succeed();
    await wait(20);

    expect(stripAnsi(view.lastFrame())).toContain('gpt-4o-mini');
  });

  it('accepts an uppercase decline', async () => {
    const runner = scriptedRunner();
    const { view, onActivate } = renderPicker({ runLogin: runner.runLogin });

    await write(view, ENTER);
    runner.succeed();
    await wait(20);
    await write(view, 'N');

    expect(onActivate).not.toHaveBeenCalled();
    expect(stripAnsi(view.lastFrame())).toContain('still uses its previous');
  });

  it('tells the parent to re-read the store once a credential lands', async () => {
    const runner = scriptedRunner();
    const onSignedIn = vi.fn();
    const { view } = renderPicker({ runLogin: runner.runLogin, onSignedIn });

    await write(view, ENTER);
    runner.succeed();
    await wait(20);

    expect(onSignedIn).toHaveBeenCalledWith('anthropic');
  });
});
