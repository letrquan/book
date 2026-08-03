/**
 * Persist settings from inside the Ink TUI without killing the app.
 *
 * Mirrors the write path of cli/config-cmd.ts but returns {ok, error?} instead
 * of calling console.log / process.exit(). Settings are layered user (global) →
 * project → local. Two write targets are exposed:
 *  - `*Local`  → <workspace>/.book/settings.local.json (per-project, gitignored)
 *  - `*Global` → ~/.book/settings.json (shared across every project)
 * Provider registries, API keys, and the active model are persisted globally so
 * they follow the user across folders rather than being re-entered per project.
 */
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  formatSettingsDiagnostics,
  readSettingsDocument,
  SettingsRepository,
} from '../settings-repository.js';
import type { SkillActivation, SkillExecution } from '../settings.js';

const LOCAL_DIR = '.book';
const LOCAL_FILE = 'settings.local.json';
const GLOBAL_FILE = 'settings.json';

/** Absolute path to the per-project local settings file. */
function localSettingsPath(workspace: string): string {
  return join(workspace, LOCAL_DIR, LOCAL_FILE);
}

/** Absolute path to the user-global settings file (~/.book/settings.json). */
function globalSettingsPath(): string {
  return join(homedir(), LOCAL_DIR, GLOBAL_FILE);
}

/** Human-readable labels used in provider-removal diagnostics. */
const LOCAL_LABEL = `${LOCAL_DIR}/${LOCAL_FILE}`;
const GLOBAL_LABEL = `~/${LOCAL_DIR}/${GLOBAL_FILE}`;

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

/** Read a settings document at `path` as a plain object ({} if absent/invalid). */
function readSettingsAt(path: string): Record<string, unknown> {
  const result = readSettingsDocument(path);
  return result.status === 'valid' ? result.document : {};
}

/** Read the project-local settings.local.json as a plain object. */
export function readSettingsLocal(workspace: string): Record<string, unknown> {
  return readSettingsAt(localSettingsPath(workspace));
}

/** Read the user-global ~/.book/settings.json as a plain object. */
export function readSettingsGlobal(): Record<string, unknown> {
  return readSettingsAt(globalSettingsPath());
}

/**
 * Set one or more dot-path keys in the settings file at `path` and persist it.
 * Returns {ok:false, error} on a filesystem or write failure (never throws).
 * Values are stored verbatim — number/bool/object callers should pre-serialize,
 * but a non-string is also stored as-is.
 */
function persistSettingsAt(
  path: string,
  values: Record<string, unknown>,
): { ok: boolean; error?: string } {
  const result = new SettingsRepository(path).set(values);
  return result.ok
    ? { ok: true }
    : { ok: false, error: formatSettingsDiagnostics(result.diagnostics) };
}

/** Persist keys to the project-local layer (.book/settings.local.json). */
export function persistSettingsLocal(
  workspace: string,
  values: Record<string, unknown>,
): { ok: boolean; error?: string } {
  return persistSettingsAt(localSettingsPath(workspace), values);
}

/** Persist keys to the user-global layer (~/.book/settings.json). */
export function persistSettingsGlobal(values: Record<string, unknown>): {
  ok: boolean;
  error?: string;
} {
  return persistSettingsAt(globalSettingsPath(), values);
}

export function persistSettingLocal(
  workspace: string,
  key: string,
  value: unknown,
): { ok: boolean; error?: string } {
  return persistSettingsLocal(workspace, { [key]: value });
}

export function persistSettingGlobal(key: string, value: unknown): { ok: boolean; error?: string } {
  return persistSettingsGlobal({ [key]: value });
}

/** Persist a profile model without treating dots in the profile name as path separators. */
export function persistAgentProfileModel(
  workspace: string,
  profile: string,
  model?: string,
): { ok: boolean; error?: string } {
  const result = new SettingsRepository(localSettingsPath(workspace)).update((candidate) => {
    const agents =
      candidate.agents && typeof candidate.agents === 'object' && !Array.isArray(candidate.agents)
        ? (candidate.agents as Record<string, unknown>)
        : {};
    const profiles =
      agents.profiles && typeof agents.profiles === 'object' && !Array.isArray(agents.profiles)
        ? (agents.profiles as Record<string, Record<string, unknown>>)
        : {};
    const existing =
      profiles[profile] && typeof profiles[profile] === 'object' ? { ...profiles[profile] } : {};

    // "inherit" must be explicit so it can override project/global settings and frontmatter.
    existing.model = model ?? 'inherit';
    profiles[profile] = existing;
    candidate.agents = { ...agents, profiles };
  });
  return result.ok
    ? { ok: true }
    : { ok: false, error: formatSettingsDiagnostics(result.diagnostics) };
}

/** Persist a skill override without treating dots in a skill name as path separators. */
export function persistSkillActivationLocal(
  workspace: string,
  skillName: string,
  activation: SkillActivation,
): { ok: boolean; error?: string } {
  const result = new SettingsRepository(localSettingsPath(workspace)).update((candidate) => {
    const skills =
      candidate.skills && typeof candidate.skills === 'object' && !Array.isArray(candidate.skills)
        ? (candidate.skills as Record<string, unknown>)
        : {};
    const overrides =
      skills.overrides && typeof skills.overrides === 'object' && !Array.isArray(skills.overrides)
        ? (skills.overrides as Record<string, unknown>)
        : {};
    overrides[skillName] = activation;
    candidate.skills = { ...skills, overrides };
  });
  return result.ok
    ? { ok: true }
    : { ok: false, error: formatSettingsDiagnostics(result.diagnostics) };
}

/** Persist a per-skill consent policy without splitting dotted names into paths. */
export function persistSkillExecutionLocal(
  workspace: string,
  skillName: string,
  execution: SkillExecution,
): { ok: boolean; error?: string } {
  const result = new SettingsRepository(localSettingsPath(workspace)).update((candidate) => {
    const skills =
      candidate.skills && typeof candidate.skills === 'object' && !Array.isArray(candidate.skills)
        ? (candidate.skills as Record<string, unknown>)
        : {};
    const policies =
      skills.execution && typeof skills.execution === 'object' && !Array.isArray(skills.execution)
        ? (skills.execution as Record<string, unknown>)
        : {};
    policies[skillName] = execution;
    candidate.skills = { ...skills, execution: policies };
  });
  return result.ok
    ? { ok: true }
    : { ok: false, error: formatSettingsDiagnostics(result.diagnostics) };
}

export function persistSkillsEnabledLocal(
  workspace: string,
  enabled: boolean,
): { ok: boolean; error?: string } {
  return persistSettingLocal(workspace, 'skills.enabled', enabled);
}

/**
 * Remove dot-path keys from the project-local layer if present. Used after a
 * value has been written to the global layer to clear a stale per-project
 * override that would otherwise shadow the new global value (local wins for
 * scalars during resolution). A no-op when the local file is absent; never
 * throws. Empty parent objects (e.g. an emptied provider registry) are pruned.
 */
export function clearLocalSettings(
  workspace: string,
  paths: string[],
): { ok: boolean; error?: string } {
  const path = localSettingsPath(workspace);
  if (!existsSync(path)) return { ok: true };
  const result = new SettingsRepository(path).remove(paths);
  return result.ok
    ? { ok: true }
    : { ok: false, error: formatSettingsDiagnostics(result.diagnostics) };
}

/** Remove one provider from the settings file at `path` and any default targeting it. */
function removeProviderAt(
  path: string,
  label: string,
  providerId: string,
): RemoveLocalProviderResult {
  if (!existsSync(path)) {
    return {
      ok: false,
      providerId,
      removedModelCount: 0,
      localDefaultCleared: false,
      localProviderExisted: false,
      error: `Provider "${providerId}" is not configured in ${label}.`,
    };
  }
  const source = readSettingsDocument(path);
  if (source.status !== 'valid') {
    return {
      ok: false,
      providerId,
      removedModelCount: 0,
      localDefaultCleared: false,
      localProviderExisted: false,
      error: source.status === 'absent' ? `${label} settings are absent.` : source.error,
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
      error: `Provider "${providerId}" is not configured in ${label}.`,
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

  const result = new SettingsRepository(path).update((candidate) => {
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

/** Remove one workspace-local provider and any local default that targets it. */
export function removeProviderLocal(
  workspace: string,
  providerId: string,
): RemoveLocalProviderResult {
  return removeProviderAt(localSettingsPath(workspace), LOCAL_LABEL, providerId);
}

/** Remove one user-global provider and any global default that targets it. */
export function removeProviderGlobal(providerId: string): RemoveLocalProviderResult {
  return removeProviderAt(globalSettingsPath(), GLOBAL_LABEL, providerId);
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
