/**
 * The credential store: `<BOOK_HOME>/auth.json`, mode 0600.
 *
 * Two properties this file exists to hold.
 *
 * **It is never inside a workspace.** A subscription token is a bearer
 * credential for the user's whole account, so it lives beside `trust.json` in
 * user-global state for the same reason trust decisions do: `.gitignore` does
 * not stop `git add -f` from shipping a tracked `.book/settings.local.json`
 * into a clone, and nothing a repository can write may reach an account
 * credential — in either direction. A repository cannot plant one, and Book
 * will not write one where `git add` could pick it up.
 *
 * **Reads fail closed.** An unparseable or off-schema store resolves to "no
 * credentials", which produces an honest `book auth login` prompt rather than
 * a half-read token that fails deep inside a provider call. Writes refuse to
 * touch a store that would not parse, so a corrupt or newer-versioned file is
 * reported instead of silently overwritten — losing a refresh token means a
 * browser round trip the user did not ask for.
 */
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { resolveBookHome } from '../book-home.js';
import { writeFileAtomic } from '../settings-repository.js';
import type { RedactedCredential, StoredCredential } from '../types/auth.js';

/** Bumped only for a format change older Book versions cannot read. */
export const AUTH_STORE_VERSION = 1;

const oauthTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().int().nonnegative().optional(),
  scope: z.string().optional(),
  tokenType: z.string().optional(),
  account: z.string().optional(),
});

const storedCredentialSchema = z.object({
  kind: z.enum(['api-key', 'oauth']),
  profile: z.string().min(1),
  apiKey: z.string().min(1).optional(),
  tokens: oauthTokensSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

const authStoreSchema = z.object({
  version: z.literal(AUTH_STORE_VERSION),
  credentials: z.record(storedCredentialSchema).default({}),
});

export type AuthStore = z.infer<typeof authStoreSchema>;

export function defaultAuthStorePath(home?: string): string {
  return home ? join(home, 'auth.json') : join(resolveBookHome(), 'auth.json');
}

export interface AuthStoreOptions {
  /** Explicit BOOK_HOME-equivalent root, used by tests and evaluation runs. */
  home?: string;
  path?: string;
}

function storePath(options?: AuthStoreOptions): string {
  return options?.path ?? defaultAuthStorePath(options?.home);
}

function emptyStore(): AuthStore {
  return { version: AUTH_STORE_VERSION, credentials: {} };
}

/** Read state distinguished from content, so writers can refuse a broken file. */
export type AuthStoreRead =
  | { status: 'missing'; path: string; store: AuthStore }
  | { status: 'valid'; path: string; store: AuthStore }
  | { status: 'unreadable'; path: string; store: AuthStore; error: string };

export function readAuthStore(options?: AuthStoreOptions): AuthStoreRead {
  const path = storePath(options);
  if (!existsSync(path)) return { status: 'missing', path, store: emptyStore() };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    return {
      status: 'unreadable',
      path,
      store: emptyStore(),
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const validated = authStoreSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      status: 'unreadable',
      path,
      store: emptyStore(),
      // Issue paths only: a validation message can quote the offending value,
      // and the offending value here is a token.
      error: validated.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', '),
    };
  }

  return { status: 'valid', path, store: validated.data };
}

/** One credential, or undefined when absent or unreadable. */
export function readCredential(
  profile: string,
  options?: AuthStoreOptions,
): StoredCredential | undefined {
  return credentialFrom(readAuthStore(options).store, profile);
}

/**
 * `Object.hasOwn`, not a bare index: the profile id reaches this from a CLI
 * argument, and `readCredential('constructor')` would otherwise return a
 * prototype member typed as a credential.
 */
function credentialFrom(store: AuthStore, profile: string): StoredCredential | undefined {
  return Object.hasOwn(store.credentials, profile) ? store.credentials[profile] : undefined;
}

function writeStore(store: AuthStore, path: string): void {
  writeFileAtomic(path, `${JSON.stringify(store, null, 2)}\n`);
  // writeFileAtomic creates the temp file 0600, but an existing auth.json keeps
  // its own mode across the rename on some platforms. Re-assert it.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort: a filesystem without POSIX modes is not a reason to fail.
  }
}

/** Refuse to overwrite a store that would not parse. */
function loadForWrite(options?: AuthStoreOptions): { store: AuthStore; path: string } {
  const read = readAuthStore(options);
  if (read.status === 'unreadable') {
    throw new Error(
      `Refusing to write ${read.path}: the existing credential store is unreadable (${read.error}). ` +
        'Move or delete it, then log in again.',
    );
  }
  return { store: read.store, path: read.path };
}

export function writeCredential(
  profile: string,
  credential: Omit<StoredCredential, 'profile' | 'createdAt' | 'updatedAt'>,
  options?: AuthStoreOptions & { now?: number },
): StoredCredential {
  const { store, path } = loadForWrite(options);
  const now = options?.now ?? Date.now();
  const existing = credentialFrom(store, profile);
  const record: StoredCredential = {
    ...credential,
    profile,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const validated = storedCredentialSchema.parse(record);
  writeStore({ ...store, credentials: { ...store.credentials, [profile]: validated } }, path);
  return validated;
}

/** Returns true when a credential was actually removed. */
export function deleteCredential(profile: string, options?: AuthStoreOptions): boolean {
  const { store, path } = loadForWrite(options);
  if (!Object.hasOwn(store.credentials, profile)) return false;
  const remaining = Object.fromEntries(
    Object.entries(store.credentials).filter(([id]) => id !== profile),
  );
  writeStore({ ...store, credentials: remaining }, path);
  return true;
}

/** Remove every credential, leaving an empty store behind. */
export function clearCredentials(options?: AuthStoreOptions): number {
  const { store, path } = loadForWrite(options);
  const count = Object.keys(store.credentials).length;
  if (count > 0) writeStore({ ...store, credentials: {} }, path);
  return count;
}

function redactCredential(credential: StoredCredential): RedactedCredential {
  return {
    profile: credential.profile,
    kind: credential.kind,
    account: credential.tokens?.account,
    scope: credential.tokens?.scope,
    expiresAt: credential.tokens?.expiresAt,
    refreshable: Boolean(credential.tokens?.refreshToken),
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
  };
}

export function listCredentials(options?: AuthStoreOptions): RedactedCredential[] {
  return Object.values(readAuthStore(options).store.credentials)
    .map(redactCredential)
    .sort((a, b) => a.profile.localeCompare(b.profile));
}
