/**
 * Persist settings from inside the Ink TUI without killing the app.
 *
 * Mirrors the write path of cli/config-cmd.ts but returns {ok, error?} instead
 * of calling console.log / process.exit(). Settings are layered user (global) →
 * project → local. Two write targets are exposed:
 *  - `*Local`  → <workspace>/.book/settings.local.json (per-project, gitignored)
 *  - `*Global` → ~/.book/settings.json (shared across every project)
 * The split is by whose choice it is. A preference about how Book behaves for
 * *you* - provider registries, API keys, model, effort, compaction model,
 * permission default mode, thinking display, startup animation, memory
 * auto-save - is global, so it follows you across folders rather than being
 * re-set per project. What stays local is what is genuinely about *this*
 * repository: which skills are on, and the permission rules approved for its
 * tools.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import {
  formatSettingsDiagnostics,
  projectFileWriteRefusal,
  readSettingsDocument,
  SettingsRepository,
} from '../settings-repository.js';
import { resolveBookHome } from '../book-home.js';
import {
  ADVISOR_OFF_VALUE,
  providerConfigSchema,
  type ProviderConfig,
  type SkillActivation,
  type SkillExecution,
} from '../settings.js';
import { PROVIDER_CONNECTION_KEYS } from '../provider-approvals.js';
import { resolveSettings } from '../settings-loader.js';
import { deleteNestedValue } from '../cli/utils.js';
import { blockedWorkspaceSettingWrite } from '../settings-scope.js';
import type { AgentConfig } from '../types/runtime.js';

const LOCAL_DIR = '.book';
const LOCAL_FILE = 'settings.local.json';
const GLOBAL_FILE = 'settings.json';

/** Absolute path to the per-project local settings file. */
function localSettingsPath(workspace: string): string {
  return join(workspace, LOCAL_DIR, LOCAL_FILE);
}

/** Absolute path to the user-global settings file (~/.book/settings.json). */
function globalSettingsPath(): string {
  return join(resolveBookHome(), GLOBAL_FILE);
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

/**
 * The refusal for a write that starts by reading the file at `path` itself, checked before that
 * read. A write through `SettingsRepository` alone needs none: the repository checks first.
 */
function refusedWrite(path: string): { ok: false; error: string } | undefined {
  const reason = projectFileWriteRefusal(path);
  return reason ? { ok: false, error: `${path}: ${reason}` } : undefined;
}

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
 * One provider as the user-global file holds it, or undefined when the file has none (or an
 * invalid one). What a save of that provider builds on: the resolved provider also carries values
 * a workspace layer merged in, which must never be written back into the user's own file.
 */
export function readUserProvider(providerId: string): ProviderConfig | undefined {
  const registry = readSettingsGlobal().provider;
  if (typeof registry !== 'object' || registry === null || Array.isArray(registry))
    return undefined;
  if (!Object.hasOwn(registry, providerId)) return undefined;
  const parsed = providerConfigSchema.safeParse((registry as Record<string, unknown>)[providerId]);
  return parsed.success ? parsed.data : undefined;
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
  for (const [key, value] of Object.entries(values)) {
    // The value decides for the sandbox, so it is passed rather than the path
    // alone: refusing `sandbox.enabled` outright would block the one value a
    // workspace layer may set (#373).
    const blocked = blockedWorkspaceSettingWrite(key, value);
    if (blocked) return { ok: false, error: blocked };
  }
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

/**
 * Write a user-global preference and drop the workspace-local value it would
 * otherwise lose to.
 *
 * The local layer resolves last, so a stale override there survives the global
 * write and silently decides the *next* session — the setting moves in front of
 * the user, then moves back when they restart. `setModel` had carried the
 * `clearLocalSettings` call for exactly this reason and the other six user-layer
 * writes had not, which is how `compactModel` and `effort` came to revert:
 * an earlier version of `/config <key>=<value>` put every typed setting in the
 * local file, so the stale value is one those users are especially likely to
 * have. One helper rather than seven call sites is what keeps that from being
 * true again of the eighth.
 */
export function persistUserSettingClearingLocal(
  workspace: string,
  key: string,
  value: unknown,
): { ok: boolean; error?: string } {
  const result = persistSettingsGlobal({ [key]: value });
  if (!result.ok) return result;
  clearLocalSettings(workspace, [key]);
  return { ok: true };
}

/** Remove a user-global preference, and the workspace-local value that would outrank it. */
export function removeUserSettingClearingLocal(
  workspace: string,
  key: string,
): { ok: boolean; error?: string } {
  const result = new SettingsRepository(globalSettingsPath()).remove([key]);
  if (!result.ok) return { ok: false, error: formatSettingsDiagnostics(result.diagnostics) };
  clearLocalSettings(workspace, [key]);
  return { ok: true };
}

/**
 * `/advisor off`: remove the user layer's advisor and the local layer's, and, when a checked-in
 * `.book/settings.json` still declares one, write an explicit "off" to the local layer, which
 * outranks it. Without that the repository's advisor came back at the next launch, because
 * nothing this command is allowed to edit outranked the file it may not (#418). The checked-in
 * file itself is never touched, and nothing is written to the workspace when none declares one.
 *
 * The `off` is not permanent: the loader honours it only while a checked-in layer still declares
 * an advisor (`withoutStaleAdvisorOff` in `settings-loader.ts`), and `/advisor <model>` clears it
 * along with any other local advisor value.
 */
export function turnOffAdvisorModel(workspace: string): { ok: boolean; error?: string } {
  const removed = removeUserSettingClearingLocal(workspace, 'advisorModel');
  if (!removed.ok) return removed;
  const projectDeclares =
    readSettingsAt(join(workspace, LOCAL_DIR, GLOBAL_FILE)).advisorModel !== undefined;
  return projectDeclares
    ? persistSettingLocal(workspace, 'advisorModel', ADVISOR_OFF_VALUE)
    : removed;
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

/**
 * Save a provider from `/model` to the user-global file, and clear what that save supersedes from
 * the workspace-local layer, which would otherwise shadow it: the entry's connection keys
 * (`PROVIDER_CONNECTION_KEYS`, the ones the workspace gate refuses too), each listed model's
 * `reportedContextWindow` (discovery writes it and every refresh overwrites it, so a stale copy
 * here would outrank the figure just reported), and the local `model` when the save activates
 * (`selection` is the `provider/model` it selects). The user's own per-model fields in the local
 * entry (`contextWindow`, `maxOutputTokens`, `vision`, `editFormat`, `effort`, `label`, `manual`)
 * stay, for a refresh and an activating save alike (#514).
 */
export function persistProviderSave(
  workspace: string,
  providerId: string,
  provider: ProviderConfig,
  selection?: string,
): { ok: boolean; error?: string } {
  const result = persistSettingsGlobal({
    [`provider.${providerId}`]: provider,
    ...(selection !== undefined ? { model: selection } : {}),
  });
  if (!result.ok) return result;
  clearSupersededLocalProviderKeys(workspace, providerId, selection !== undefined);
  return { ok: true };
}

/**
 * The deletions of {@link persistProviderSave}, on key paths rather than dotted strings: a model
 * id such as `vendor/model.v2` has a dot in it. Never throws; a no-op when the local file is absent.
 */
function clearSupersededLocalProviderKeys(
  workspace: string,
  providerId: string,
  activated: boolean,
): void {
  const path = localSettingsPath(workspace);
  if (!existsSync(path)) return;
  new SettingsRepository(path).update((candidate) => {
    const registry = candidate.provider;
    const entry =
      typeof registry === 'object' && registry !== null && !Array.isArray(registry)
        ? (registry as Record<string, unknown>)[providerId]
        : undefined;
    const models =
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? (entry as Record<string, unknown>).models
        : undefined;
    for (const key of PROVIDER_CONNECTION_KEYS) {
      deleteNestedValue(candidate, ['provider', providerId, key]);
    }
    if (typeof models === 'object' && models !== null && !Array.isArray(models)) {
      for (const modelId of Object.keys(models)) {
        deleteNestedValue(candidate, [
          'provider',
          providerId,
          'models',
          modelId,
          'reportedContextWindow',
        ]);
      }
    }
    if (activated) deleteNestedValue(candidate, ['model']);
  });
}

/**
 * The provider entry the live config holds after a save. The user-global entry alone would drop
 * what the workspace layers add to it (a local per-model override, a repository's models), so a
 * session would resolve a different window than the next launch does. Re-resolved from the layers
 * on disk the way a launch does; the saved entry itself when they cannot be read or the session
 * runs without settings layers.
 */
export function liveProviderAfterSave(
  config: Pick<AgentConfig, 'workspace' | 'settingsContext'>,
  providerId: string,
  saved: ProviderConfig,
): ProviderConfig {
  if (config.settingsContext?.noSettings) return saved;
  try {
    const resolved = resolveSettings(config.workspace, config.settingsContext?.overridePath);
    return Object.hasOwn(resolved.provider, providerId) ? resolved.provider[providerId] : saved;
  } catch {
    return saved;
  }
}

/** Remove one provider from the settings file at `path` and any default targeting it. */
function removeProviderAt(
  path: string,
  label: string,
  providerId: string,
): RemoveLocalProviderResult {
  const refused = refusedWrite(path);
  if (refused) {
    return {
      ...refused,
      providerId,
      removedModelCount: 0,
      localDefaultCleared: false,
      localProviderExisted: false,
    };
  }
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
  const refused = refusedWrite(localSettingsPath(workspace));
  if (refused) return refused;
  const existing = readSettingsLocal(workspace);
  const perms = (existing.permissions ?? {}) as Record<string, unknown[]>;
  const arr = Array.isArray(perms[list]) ? [...(perms[list] as unknown[])] : [];
  if (!arr.includes(rule)) arr.push(rule);
  perms[list] = arr;
  return persistSettingLocal(workspace, 'permissions', perms);
}

/**
 * Remove one permission rule from the local layer.
 *
 * The counterpart to {@link persistPermissionRuleLocal}, which had none: a rule
 * went in on one keystroke at a tool prompt and came out only by hand-editing
 * `.book/settings.local.json`, since `book config unset permissions.allow`
 * drops the whole list. A rule the user cannot see themselves removing is a
 * rule they cannot safely grant.
 *
 * Only the local layer is writable here, so a rule inherited from the project
 * or user-global layer reports `notLocal` rather than silently doing nothing.
 */
export function removePermissionRuleLocal(
  workspace: string,
  list: 'allow' | 'ask' | 'deny',
  rule: string,
): { ok: boolean; error?: string; notLocal?: boolean } {
  const refused = refusedWrite(localSettingsPath(workspace));
  if (refused) return refused;
  const existing = readSettingsLocal(workspace);
  const perms = (existing.permissions ?? {}) as Record<string, unknown[]>;
  const arr = Array.isArray(perms[list]) ? [...(perms[list] as unknown[])] : [];
  if (!arr.includes(rule)) return { ok: false, notLocal: true };
  perms[list] = arr.filter((entry) => entry !== rule);
  return persistSettingLocal(workspace, 'permissions', perms);
}
