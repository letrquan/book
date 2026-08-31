import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULT_SETTINGS, type BookSettings } from '../settings.js';
import { selectAuthProfile } from './selection.js';
import { writeCredential } from './store.js';

let home: string;
const NO_ENV = {} as NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'book-auth-selection-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function settings(auth: Partial<BookSettings['auth']> = {}): Pick<BookSettings, 'auth'> {
  return { auth: { profiles: {}, ...auth } as BookSettings['auth'] };
}

function login(profile: string): void {
  writeCredential(profile, { kind: 'oauth', tokens: { accessToken: 'at' } }, { home });
}

describe('inference', () => {
  it('uses the only stored credential when no API key resolved', () => {
    login('anthropic');
    const selection = selectAuthProfile({
      settings: settings(),
      hasApiKey: false,
      env: NO_ENV,
      store: { home },
    });
    expect(selection).toMatchObject({
      explicit: false,
      credentialPresent: true,
      profile: { id: 'anthropic' },
    });
  });

  /**
   * The point of the narrow rule: someone who logs in to look around must not
   * find their working API-key workspace quietly spending subscription quota.
   */
  it('leaves a workspace that already has an API key on the API key', () => {
    login('anthropic');
    expect(
      selectAuthProfile({ settings: settings(), hasApiKey: true, env: NO_ENV, store: { home } }),
    ).toBeUndefined();
  });

  it('declines to guess between two logins', () => {
    login('anthropic');
    login('codex');
    expect(
      selectAuthProfile({ settings: settings(), hasApiKey: false, env: NO_ENV, store: { home } }),
    ).toBeUndefined();
  });

  it('disambiguates two logins once the provider is pinned', () => {
    login('anthropic');
    login('codex');
    const selection = selectAuthProfile({
      settings: settings(),
      providerType: 'openai',
      hasApiKey: false,
      env: NO_ENV,
      store: { home },
    });
    expect(selection?.profile.id).toBe('codex');
  });

  it('selects nothing when nothing is stored', () => {
    expect(
      selectAuthProfile({ settings: settings(), hasApiKey: false, env: NO_ENV, store: { home } }),
    ).toBeUndefined();
  });
});

describe('explicit selection', () => {
  it('honours auth.profile even when an API key is present', () => {
    login('codex');
    const selection = selectAuthProfile({
      settings: settings({ profile: 'codex' }),
      hasApiKey: true,
      env: NO_ENV,
      store: { home },
    });
    expect(selection).toMatchObject({ explicit: true, profile: { id: 'codex' } });
  });

  it('lets BOOK_AUTH_PROFILE outrank settings', () => {
    login('anthropic');
    const selection = selectAuthProfile({
      settings: settings({ profile: 'codex' }),
      hasApiKey: false,
      env: { BOOK_AUTH_PROFILE: 'anthropic' } as NodeJS.ProcessEnv,
      store: { home },
    });
    expect(selection?.profile.id).toBe('anthropic');
  });

  it('reports a selected profile with nothing logged in, rather than hiding it', () => {
    const selection = selectAuthProfile({
      settings: settings({ profile: 'anthropic' }),
      hasApiKey: false,
      env: NO_ENV,
      store: { home },
    });
    expect(selection).toMatchObject({ explicit: true, credentialPresent: false });
  });

  it('turns subscription auth off for the "api-key" sentinel', () => {
    login('anthropic');
    expect(
      selectAuthProfile({
        settings: settings({ profile: 'api-key' }),
        hasApiKey: false,
        env: NO_ENV,
        store: { home },
      }),
    ).toBeUndefined();
  });

  it('throws on an unknown profile instead of falling back to a key', () => {
    expect(() =>
      selectAuthProfile({
        settings: settings({ profile: 'nope' }),
        hasApiKey: false,
        env: NO_ENV,
        store: { home },
      }),
    ).toThrow(/Unknown auth profile "nope"/);
  });

  it('ignores a credential whose profile is no longer configured', () => {
    writeCredential('retired', { kind: 'oauth', tokens: { accessToken: 'at' } }, { home });
    expect(
      selectAuthProfile({
        settings: { auth: DEFAULT_SETTINGS.auth },
        hasApiKey: false,
        env: NO_ENV,
        store: { home },
      }),
    ).toBeUndefined();
  });
});
