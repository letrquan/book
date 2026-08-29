/**
 * Which credential a run spends — decided once, at config load.
 *
 * Split from `resolve.ts` on purpose. *Selection* is synchronous and cheap (a
 * settings read plus one small JSON file), so `loadConfig` can fold it into the
 * frozen `AgentConfig` and every later consumer — doctor, the model picker, the
 * transports — agrees on the answer. *Redemption* (refreshing an expired token,
 * building headers) is asynchronous and happens per request in `resolve.ts`.
 *
 * The inference rule is deliberately narrow. An explicit selection always wins;
 * otherwise a stored credential is used only when no API key resolved at all
 * and exactly one credential fits the active provider. Adding a login must
 * never silently retarget a workspace that already had a working key — the
 * failure mode there is spending someone's subscription quota without being
 * asked to.
 */
import type { BookSettings } from '../settings.js';
import { API_KEY_PROFILE, resolveAuthProfile, type AuthProfile } from './profiles.js';
import { readAuthStore, type AuthStoreOptions } from './store.js';

export interface AuthSelectionInput {
  settings: Pick<BookSettings, 'auth'>;
  /** Provider override in effect; `auto` means it has not been pinned. */
  providerType?: 'anthropic' | 'openai' | 'auto';
  /** Whether an API key resolved from env or settings. */
  hasApiKey: boolean;
  env?: NodeJS.ProcessEnv;
  store?: AuthStoreOptions;
}

export interface AuthSelection {
  profile: AuthProfile;
  /** True when `auth.profile` or BOOK_AUTH_PROFILE named it. */
  explicit: boolean;
  /** False when the profile is selected but nothing has been logged in yet. */
  credentialPresent: boolean;
}

/** Reserved value that pins a run to API-key auth regardless of what is stored. */
export function isApiKeySelection(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === API_KEY_PROFILE;
}

export function selectAuthProfile(input: AuthSelectionInput): AuthSelection | undefined {
  const env = input.env ?? process.env;
  const requested = env.BOOK_AUTH_PROFILE?.trim() || input.settings.auth?.profile?.trim();

  if (isApiKeySelection(requested)) return undefined;

  const credentials = readAuthStore(input.store).store.credentials;

  if (requested) {
    const profile = resolveAuthProfile(requested, input.settings, env);
    if (!profile) {
      throw new Error(
        `Unknown auth profile "${requested}". Configure it under auth.profiles.${requested} ` +
          'in settings, or set auth.profile to "api-key" to use an API key.',
      );
    }
    return { profile, explicit: true, credentialPresent: Boolean(credentials[requested]) };
  }

  // Inference: only when there is no key to fall back on.
  if (input.hasApiKey) return undefined;

  const candidates = Object.values(credentials)
    .map((credential) => resolveAuthProfile(credential.profile, input.settings, env))
    .filter((profile): profile is AuthProfile => profile !== undefined)
    .filter(
      (profile) =>
        !input.providerType ||
        input.providerType === 'auto' ||
        profile.providerType === input.providerType,
    );

  // Two logins and no stated preference is ambiguous; say nothing and let the
  // missing-credential error name `auth.profile` rather than pick for the user.
  if (candidates.length !== 1) return undefined;
  return { profile: candidates[0], explicit: false, credentialPresent: true };
}
