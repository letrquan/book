/**
 * Replace the API key of a provider the user configured (#592), for `/model`'s `Alt+K` sheet and
 * `book config provider-key` alike. It lives outside `tui/` because the CLI must not import the
 * TUI, which is a leaf of the import graph.
 *
 * Three rules hold for both surfaces:
 *
 * - **Only the user file's providers.** `<BOOK_HOME>/settings.json` is the user's own; a provider
 *   only a repository declares stays the repository's, on the ownership rule `Alt+D`, `Alt+R` and
 *   `Alt+M` use.
 * - **Only `apiKey` changes.** The entry is edited as raw JSON, so the catalog (discovered and
 *   `"manual": true` models), the active model and every per-model override stay byte for byte,
 *   and a hand-written entry gains no schema defaults. The local half follows the `/model` save
 *   rule: a same-named entry in `.book/settings.local.json` loses its connection keys, so a stale
 *   local key cannot look live, and no local entry is ever created.
 * - **The key goes nowhere but the provider's own endpoint.** The check calls the configured base
 *   URL's model-list API, never a default host or `BOOK_BASE_URL`, and no error this module returns
 *   contains the key.
 */
import { existsSync } from 'fs';
import { resolveSecret } from './config.js';
import { deleteNestedValue } from './cli/utils.js';
import { PROVIDER_CONNECTION_KEYS } from './provider-approvals.js';
import {
  discoverModels,
  type DiscoveredModel,
  type ModelDiscoveryOptions,
} from './provider/model-discovery.js';
import { parseSecretReference } from './secret-reference.js';
import { providerConfigSchema, type ProviderConfig } from './settings.js';
import {
  formatSettingsDiagnostics,
  readSettingsDocument,
  SettingsRepository,
} from './settings-repository.js';
import { settingsScopePath } from './settings-scope.js';
import type { RetryConfig } from './types/runtime.js';

/** What the add-provider wizard's key step accepts: a literal key, `{env:VAR}` or `{file:path}`. */
export function validateApiKey(raw: string): string {
  if (!raw.trim()) throw new Error('API key is required.');
  if (/[\r\n\x00]/.test(raw)) throw new Error('API key cannot contain line breaks.');
  return raw;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The entry `document.provider[providerId]`, own properties only. */
function providerEntryOf(
  document: Record<string, unknown>,
  providerId: string,
): Record<string, unknown> | undefined {
  const registry = document.provider;
  if (!isPlainObject(registry) || !Object.hasOwn(registry, providerId)) return undefined;
  const entry = registry[providerId];
  return isPlainObject(entry) ? entry : undefined;
}

/** Every message that leaves this module goes through here, whatever produced it. */
function withoutSecrets(message: string, secrets: ReadonlyArray<string | undefined>): string {
  let scrubbed = message;
  for (const secret of secrets) {
    if (secret) scrubbed = scrubbed.split(secret).join('[redacted]');
  }
  return scrubbed;
}

export type ProviderKeyTarget =
  /** The user file defines it: its key may be replaced. */
  | { kind: 'owned'; providerId: string; path: string; provider: ProviderConfig }
  /** Only a workspace layer declares it. `declaredIn` is the first file that does. */
  | { kind: 'workspace-only'; providerId: string; path: string; declaredIn: string }
  /** Nothing declares it. `configured` lists the user file's provider ids. */
  | { kind: 'unknown'; providerId: string; path: string; configured: string[] }
  /** The user file, or its entry for this id, cannot be read as settings. */
  | { kind: 'unreadable'; providerId: string; path: string; error: string };

/**
 * Whose provider `providerId` is. Reads the layers as documents rather than resolving them, so a
 * malformed workspace layer or a missing credential does not stop a key update: that is the state
 * a user reaching for one is often in.
 */
export function providerKeyTarget(workspace: string, providerId: string): ProviderKeyTarget {
  const path = settingsScopePath('user', workspace);
  const user = readSettingsDocument(path);
  if (user.status === 'malformed' || user.status === 'non-object') {
    return { kind: 'unreadable', providerId, path, error: user.error };
  }
  const document = user.status === 'valid' ? user.document : {};
  if (isPlainObject(document.provider) && Object.hasOwn(document.provider, providerId)) {
    const parsed = providerConfigSchema.safeParse(document.provider[providerId]);
    if (!parsed.success) {
      return {
        kind: 'unreadable',
        providerId,
        path,
        error: `Provider "${providerId}" is not a valid provider entry: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(entry)'}: ${issue.message}`)
          .join('; ')}`,
      };
    }
    return { kind: 'owned', providerId, path, provider: parsed.data };
  }
  for (const scope of ['project', 'local'] as const) {
    const workspacePath = settingsScopePath(scope, workspace);
    const layer = readSettingsDocument(workspacePath);
    if (layer.status === 'valid' && providerEntryOf(layer.document, providerId)) {
      return { kind: 'workspace-only', providerId, path, declaredIn: workspacePath };
    }
  }
  const configured = isPlainObject(document.provider) ? Object.keys(document.provider).sort() : [];
  return { kind: 'unknown', providerId, path, configured };
}

/**
 * Drop a provider entry's connection keys (`PROVIDER_CONNECTION_KEYS`) from a settings document,
 * on key paths so an id with a dot in it stays one segment. The local half of the `/model` save
 * rule: the workspace gate ignores these keys for a provider the user defines, so a copy left in
 * the local file would only look live.
 */
export function deleteProviderConnectionKeys(
  document: Record<string, unknown>,
  providerId: string,
): void {
  for (const key of PROVIDER_CONNECTION_KEYS) {
    deleteNestedValue(document, ['provider', providerId, key]);
  }
}

export type ProviderKeyWriteResult =
  | {
      ok: true;
      /** The user file the key was written to. */
      path: string;
      /** The local file whose same-named entry lost its connection keys, when one did. */
      localCleared?: string;
      /** Why that local entry could not be cleared. The key itself is saved. */
      localError?: string;
    }
  | { ok: false; error: string };

/**
 * Write `apiKey`, exactly as typed (a literal or a reference), to the user file's entry for
 * `providerId`. Refuses an id the user file does not define rather than creating one, and edits
 * nothing else in either file. The write is atomic and validates the whole document, as every
 * settings write does.
 */
export function writeProviderKey(
  workspace: string,
  providerId: string,
  apiKey: string,
): ProviderKeyWriteResult {
  const path = settingsScopePath('user', workspace);
  const written = new SettingsRepository(path).update((candidate) => {
    const entry = providerEntryOf(candidate, providerId);
    if (!entry) throw new Error(`Provider "${providerId}" is not configured in ${path}.`);
    entry.apiKey = apiKey;
  });
  if (!written.ok) {
    return {
      ok: false,
      error: withoutSecrets(formatSettingsDiagnostics(written.diagnostics), [apiKey]),
    };
  }

  const localPath = settingsScopePath('local', workspace);
  if (!existsSync(localPath)) return { ok: true, path };
  const local = readSettingsDocument(localPath);
  const localEntry = local.status === 'valid' ? providerEntryOf(local.document, providerId) : null;
  if (!localEntry || !PROVIDER_CONNECTION_KEYS.some((key) => localEntry[key] !== undefined)) {
    return { ok: true, path };
  }
  const cleared = new SettingsRepository(localPath).update((candidate) =>
    deleteProviderConnectionKeys(candidate, providerId),
  );
  return cleared.ok
    ? { ok: true, path, localCleared: localPath }
    : {
        ok: true,
        path,
        localError: withoutSecrets(formatSettingsDiagnostics(cleared.diagnostics), [apiKey]),
      };
}

/** Attempts and per-request time for the check: a wrong host must fail in seconds, not minutes. */
const CHECK_MAX_RETRIES = 1;
const CHECK_REQUEST_TIMEOUT_MS = 30_000;

export interface ProviderKeyCheckOptions {
  /** The provider whose endpoint is asked. Its own `apiKey` is not used. */
  provider: Pick<ProviderConfig, 'type' | 'baseURL' | 'baseUrl'>;
  /** The new key as typed: a literal, `{env:VAR}` or `{file:path}`. */
  apiKey: string;
  /** Where a relative `{file:…}` reference is rooted. */
  workspace: string;
  retry: RetryConfig;
  discover?: (options: ModelDiscoveryOptions) => Promise<DiscoveredModel[]>;
  signal?: AbortSignal;
}

export type ProviderKeyCheckResult =
  { ok: true; modelCount: number } | { ok: false; error: string };

/**
 * Ask the provider's configured endpoint for its model list with the new key. The list itself is
 * discarded: a key update changes the key and nothing else. A provider without a base URL is not
 * asked at all, since anything else would send the key to a host the entry does not name.
 */
export async function checkProviderKey(
  options: ProviderKeyCheckOptions,
): Promise<ProviderKeyCheckResult> {
  const baseUrl = options.provider.baseURL ?? options.provider.baseUrl;
  if (!baseUrl) {
    return {
      ok: false,
      error: 'This provider has no base URL configured, so the key cannot be tested.',
    };
  }
  const resolved = resolveSecret(options.apiKey, options.workspace);
  if (!resolved) {
    const reference = parseSecretReference(options.apiKey);
    return {
      ok: false,
      error:
        reference.kind === 'env'
          ? `Environment variable ${reference.name} is not set.`
          : reference.kind === 'file'
            ? `Could not read a key from ${reference.path}.`
            : 'API key is required.',
    };
  }
  const discover = options.discover ?? discoverModels;
  try {
    const models = await discover({
      type: options.provider.type,
      baseUrl,
      apiKey: resolved,
      retry: {
        ...options.retry,
        maxAttempts: Math.min(options.retry.maxAttempts, CHECK_MAX_RETRIES),
        requestTimeoutMs: Math.min(options.retry.requestTimeoutMs, CHECK_REQUEST_TIMEOUT_MS),
      },
      signal: options.signal,
    });
    if (models.length === 0) {
      return { ok: false, error: 'The endpoint did not return any models.' };
    }
    return { ok: true, modelCount: models.length };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'The key check failed.';
    return { ok: false, error: withoutSecrets(message, [options.apiKey, resolved]) };
  }
}
