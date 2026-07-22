/**
 * Persist settings to the project-local layer (.book/settings.local.json).
 *
 * Mirrors the write path of cli/config-cmd.ts but is safe to call from inside
 * the Ink TUI: it returns {ok, error?} instead of calling console.log /
 * process.exit() (which would kill the app). Settings are layered user →
 * project → local; we write to the local (highest-priority, gitignored) layer.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import {
  formatSettingsDiagnostics,
  readSettingsDocument,
  SettingsRepository,
} from '../settings-repository.js';

const LOCAL_DIR = '.book';
const LOCAL_FILE = 'settings.local.json';

export type RemoveLocalProviderResult =
  | {
      ok: true;
      providerId: string;
      removedModelCount: number;
      localDefaultCleared: boolean;
      localProviderExisted: true;
    }
  | {
      ok: false;
      providerId: string;
      removedModelCount: number;
      localDefaultCleared: false;
      localProviderExisted: boolean;
      error: string;
    };

/** Read the local settings.local.json as a plain object ({} if absent/invalid). */
export function readSettingsLocal(workspace: string): Record<string, unknown> {
  const localPath = join(workspace, LOCAL_DIR, LOCAL_FILE);
  const result = readSettingsDocument(localPath);
  return result.status === 'valid' ? result.document : {};
}

/**
 * Set a single dot-path key in the local settings layer and persist it.
 * Returns {ok:false, error} on a filesystem or write failure (never throws).
 * `value` is stored verbatim (string) — number/bool/object callers should
 * pre-serialize, but a non-string is also stored as-is.
 */
export function persistSettingsLocal(
  workspace: string,
  values: Record<string, unknown>,
): { ok: boolean; error?: string } {
  const localPath = join(workspace, LOCAL_DIR, LOCAL_FILE);
  const result = new SettingsRepository(localPath).set(values);
  return result.ok
    ? { ok: true }
    : { ok: false, error: formatSettingsDiagnostics(result.diagnostics) };
}

export function persistSettingLocal(
  workspace: string,
  key: string,
  value: unknown,
): { ok: boolean; error?: string } {
  return persistSettingsLocal(workspace, { [key]: value });
}

/** Remove one workspace-local provider and any local default that targets it. */
export function removeProviderLocal(
  workspace: string,
  providerId: string,
): RemoveLocalProviderResult {
  const localPath = join(workspace, LOCAL_DIR, LOCAL_FILE);
  if (!existsSync(localPath)) {
    return {
      ok: false,
      providerId,
      removedModelCount: 0,
      localDefaultCleared: false,
      localProviderExisted: false,
      error: `Provider "${providerId}" is not configured in ${LOCAL_DIR}/${LOCAL_FILE}.`,
    };
  }
  const source = readSettingsDocument(localPath);
  if (source.status !== 'valid') {
    return {
      ok: false,
      providerId,
      removedModelCount: 0,
      localDefaultCleared: false,
      localProviderExisted: false,
      error: source.status === 'absent' ? 'Local settings are absent.' : source.error,
    };
  }
  const existing = source.document;

  const registry = existing.provider;
  const ownsProvider =
    typeof registry === 'object' &&
    registry !== null &&
    !Array.isArray(registry) &&
    Object.prototype.hasOwnProperty.call(registry, providerId);
  if (!ownsProvider) {
    return {
      ok: false,
      providerId,
      removedModelCount: 0,
      localDefaultCleared: false,
      localProviderExisted: false,
      error: `Provider "${providerId}" is not configured in ${LOCAL_DIR}/${LOCAL_FILE}.`,
    };
  }

  const provider = (registry as Record<string, unknown>)[providerId];
  const models =
    typeof provider === 'object' && provider !== null && !Array.isArray(provider)
      ? (provider as Record<string, unknown>).models
      : undefined;
  const removedModelCount =
    typeof models === 'object' && models !== null && !Array.isArray(models)
      ? Object.keys(models).length
      : 0;
  const localDefaultCleared =
    typeof existing.model === 'string' && existing.model.startsWith(`${providerId}/`);

  const result = new SettingsRepository(localPath).update((candidate) => {
    const candidateProviders = candidate.provider as Record<string, unknown>;
    delete candidateProviders[providerId];
    if (Object.keys(candidateProviders).length === 0) delete candidate.provider;
    if (localDefaultCleared) delete candidate.model;
  });
  if (result.ok) {
    return {
      ok: true,
      providerId,
      removedModelCount,
      localDefaultCleared,
      localProviderExisted: true,
    };
  }
  return {
    ok: false,
    providerId,
    removedModelCount,
    localDefaultCleared: false,
    localProviderExisted: true,
    error: formatSettingsDiagnostics(result.diagnostics),
  };
}

/**
 * Append a permission rule to settings.permissions.<list> in the local layer.
 * Dedupes exact-string matches. Used by the "Always allow" approval flow
 * (the Claude-Code-aligned way rules get added, rather than a /permissions
 * string parser).
 */
export function persistPermissionRuleLocal(
  workspace: string,
  list: 'allow' | 'ask' | 'deny',
  rule: string,
): { ok: boolean; error?: string } {
  const existing = readSettingsLocal(workspace);
  const perms = (existing.permissions ?? {}) as Record<string, unknown[]>;
  const arr = Array.isArray(perms[list]) ? [...(perms[list] as unknown[])] : [];
  if (!arr.includes(rule)) arr.push(rule);
  perms[list] = arr;
  return persistSettingLocal(workspace, 'permissions', perms);
}
