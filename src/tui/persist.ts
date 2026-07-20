/**
 * Persist settings to the project-local layer (.book/settings.local.json).
 *
 * Mirrors the write path of cli/config-cmd.ts but is safe to call from inside
 * the Ink TUI: it returns {ok, error?} instead of calling console.log /
 * process.exit() (which would kill the app). Settings are layered user →
 * project → local; we write to the local (highest-priority, gitignored) layer.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { deleteNestedValue, setNestedValue } from '../cli/utils.js';

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
  if (!existsSync(localPath)) return {};
  try {
    const raw = readFileSync(localPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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
  try {
    const localDir = join(workspace, LOCAL_DIR);
    const localPath = join(localDir, LOCAL_FILE);
    mkdirSync(localDir, { recursive: true });
    const existing = readSettingsLocal(workspace);
    for (const [key, value] of Object.entries(values)) setNestedValue(existing, key, value);
    writeFileSync(localPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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
  let existing: Record<string, unknown>;
  try {
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
    const parsed: unknown = JSON.parse(readFileSync(localPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Local settings must contain a JSON object.');
    }
    existing = parsed as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      providerId,
      removedModelCount: 0,
      localDefaultCleared: false,
      localProviderExisted: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

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

  deleteNestedValue(existing, ['provider', providerId]);
  if (localDefaultCleared) delete existing.model;

  try {
    writeFileSync(localPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
    return {
      ok: true,
      providerId,
      removedModelCount,
      localDefaultCleared,
      localProviderExisted: true,
    };
  } catch (error) {
    return {
      ok: false,
      providerId,
      removedModelCount,
      localDefaultCleared: false,
      localProviderExisted: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
