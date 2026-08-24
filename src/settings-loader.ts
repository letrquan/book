import { readFileSync, existsSync } from 'fs';
import { join, normalize } from 'path';
import {
  bookSettingsSchema,
  DEFAULT_SETTINGS,
  type BookSettings,
  type ResolvedSettings,
} from './settings.js';
import { SettingsRepository, writeFileAtomic } from './settings-repository.js';
import { resolveBookHome } from './book-home.js';
import { partitionProjectAllowRules } from './permission-approvals.js';
import { assertHarnessModeAvailable } from './harness/coordinator.js';

const LEGACY_PERMISSIONS_MIGRATION_VERSION = 1;

/**
 * Deep-merge two settings objects. For arrays, concatenate (used for
 * permission rules and additionalDirectories). For objects, merge recursively.
 * For scalars, the override wins.
 */
const CONCATENATED_ARRAY_PATHS = new Set([
  'permissions.allow',
  'permissions.ask',
  'permissions.deny',
  ...[
    'SessionStart',
    'SessionEnd',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'Stop',
    'PreCompact',
    'PostCompact',
    'SubagentStart',
    'SubagentStop',
  ].map((event) => `hooks.${event}`),
]);

function mergeObject(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
  prefix = '',
): Record<string, unknown> {
  const result = structuredClone(base);

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const existing = result[key];

    if (Array.isArray(value)) {
      if (path === 'additionalDirectories') {
        const combined = [...(Array.isArray(existing) ? existing : []), ...value].map((entry) =>
          normalize(String(entry)),
        );
        result[key] = [...new Set(combined)];
      } else if (CONCATENATED_ARRAY_PATHS.has(path)) {
        result[key] = [...(Array.isArray(existing) ? existing : []), ...value];
      } else {
        result[key] = structuredClone(value);
      }
    } else if (
      typeof value === 'object' &&
      value !== null &&
      typeof existing === 'object' &&
      existing !== null &&
      !Array.isArray(existing)
    ) {
      result[key] = mergeObject(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
        path,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * How much authority a settings layer carries.
 *
 * - `trusted` — the user's own global file, or a path they passed on the CLI.
 * - `local` — `<workspace>/.book/settings.local.json`: gitignored and written by
 *   the user, or by Book on their behalf, so it may record trust decisions.
 * - `repository` — `<workspace>/.book/settings.json`: checked in and controlled
 *   by whoever wrote the repository. It may never grant itself trust.
 */
export type SettingsLayerTrust = 'trusted' | 'local' | 'repository';

/**
 * Settings paths that record a decision the user made *about*
 * repository-controlled input. Honouring one of these from the repository layer
 * would let a clone approve itself, defeating the approval it is subject to: the
 * fingerprints they carry are digests of configuration the repository already
 * controls, so a malicious project can compute a matching one at will.
 */
const REPOSITORY_FORBIDDEN_PATHS: ReadonlyArray<readonly [string, string]> = [
  ['mcp', 'projectServers'],
  ['permissions', 'projectAllowRules'],
  ['commands', 'projectCommands'],
];

function sanitizeLayer(
  settings: Partial<BookSettings>,
  trust: SettingsLayerTrust,
): Partial<BookSettings> {
  if (trust === 'trusted') return settings;
  const sanitized = structuredClone(settings);
  // Project/local settings cannot opt a session into the most permissive mode.
  if (sanitized.defaultMode === 'bypassPermissions') delete sanitized.defaultMode;
  if (trust !== 'repository') return sanitized;
  for (const [parent, key] of REPOSITORY_FORBIDDEN_PATHS) {
    const container = (sanitized as Record<string, unknown>)[parent];
    if (container && typeof container === 'object' && !Array.isArray(container)) {
      delete (container as Record<string, unknown>)[key];
    }
  }
  return sanitized;
}

function mergeLayer(
  resolved: ResolvedSettings,
  layer: Partial<BookSettings>,
  trust: SettingsLayerTrust,
): ResolvedSettings {
  const candidate = sanitizeLayer(layer, trust);
  // A trusted global safety ceiling cannot be disabled by a lower-trust layer.
  if (
    resolved.disableBypassPermissionsMode === true &&
    candidate.disableBypassPermissionsMode === false
  ) {
    candidate.disableBypassPermissionsMode = true;
  }
  return mergeSettings(resolved, candidate);
}

export function mergeSettings(
  base: ResolvedSettings,
  override: Partial<BookSettings>,
): ResolvedSettings {
  return mergeObject(
    base as unknown as Record<string, unknown>,
    override as Record<string, unknown>,
  ) as unknown as ResolvedSettings;
}

/**
 * Load and validate a single settings.json file. Returns null if the file
 * doesn't exist. Throws on parse/validation errors.
 */
function loadSettingsFile(path: string): BookSettings | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Invalid JSON in settings file: ${path}\n${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const result = bookSettingsSchema.safeParse(parsed);
  if (!result.success) throw new Error(`Invalid settings in ${path}:\n${result.error.message}`);
  // Resolution owns defaults. Returning the source document preserves the distinction
  // between an omitted field and a field explicitly set to an empty collection.
  return parsed as BookSettings;
}

/**
 * Resolve settings from all scopes: user → project → local.
 * Priority: Local > Project > User.
 *
 * @param workspace - Project root directory
 * @param overridePath - Optional path to an ad-hoc settings file (--settings flag)
 * @returns Fully resolved settings with all defaults filled
 */
export interface SettingsResolutionPaths {
  home?: string;
  userSettingsPath?: string;
  projectSettingsPath?: string;
  localSettingsPath?: string;
}

export function resolveSettings(
  workspace: string,
  overridePath?: string,
  paths: SettingsResolutionPaths = {},
): ResolvedSettings {
  let resolved = structuredClone(DEFAULT_SETTINGS);

  // Layer 1: User settings (~/.book/settings.json)
  const userPath =
    paths.userSettingsPath ??
    (paths.home
      ? join(paths.home, '.book', 'settings.json')
      : join(resolveBookHome(), 'settings.json'));
  const user = loadSettingsFile(userPath);
  if (user) resolved = mergeLayer(resolved, user, 'trusted');

  // Layer 2: Project settings (<workspace>/.book/settings.json)
  const projectPath = paths.projectSettingsPath ?? join(workspace, '.book', 'settings.json');
  const project = loadSettingsFile(projectPath);
  // `allow` rules from the repository layer are held back rather than merged:
  // they only widen authority, and the decisions that release them live in the
  // local layer, which has not been merged yet.
  const declaredProjectAllow = project?.permissions?.allow ?? [];
  if (project) {
    const withheld =
      declaredProjectAllow.length > 0
        ? { ...project, permissions: { ...project.permissions, allow: [] } }
        : project;
    resolved = mergeLayer(resolved, withheld, 'repository');
  }

  // Layer 3: Local settings (<workspace>/.book/settings.local.json)
  const localPath = paths.localSettingsPath ?? join(workspace, '.book', 'settings.local.json');
  const local = loadSettingsFile(localPath);
  if (local) resolved = mergeLayer(resolved, local, 'local');

  // Layer 4 (optional): Ad-hoc override (--settings flag)
  if (overridePath) {
    const override = loadSettingsFile(overridePath);
    if (override) resolved = mergeLayer(resolved, override, 'trusted');
  }

  // Every layer that can record a decision is merged now, so the withheld
  // repository rules can be released — approved ones only.
  if (declaredProjectAllow.length > 0) {
    const { approved } = partitionProjectAllowRules(
      declaredProjectAllow,
      resolved.permissions?.projectAllowRules,
    );
    if (approved.length > 0) {
      resolved.permissions.allow = [...(resolved.permissions.allow ?? []), ...approved];
    }
  }

  const settings = bookSettingsSchema.parse(resolved) as ResolvedSettings;
  assertHarnessModeAvailable(settings.harness.mode);
  return settings;
}

export { loadSettingsFile };

/**
 * Migrate rules from the legacy ~/.book/permissions.json into the local
 * settings file (<workspace>/.book/settings.local.json). Runs once on first
 * load when the legacy file exists and the local settings don't have rules yet.
 *
 * @param home - User home directory; injectable for isolated migration tests
 * @param validatedSettings - Already-resolved settings from the startup preflight
 * @returns true if migration occurred, false otherwise
 */
export function migrateLegacyPermissions(
  workspace: string,
  home?: string,
  validatedSettings?: ResolvedSettings,
): boolean {
  // Direct callers must observe the same fail-before-storage boundary as the
  // normal startup path. Internal callers pass already-resolved settings to
  // avoid reading the layers twice on the common off path.
  const settings =
    validatedSettings ?? resolveSettings(workspace, undefined, home ? { home } : undefined);
  assertHarnessModeAvailable(settings.harness.mode);

  const legacyPath = join(home ? join(home, '.book') : resolveBookHome(), 'permissions.json');
  if (!existsSync(legacyPath)) return false;
  const markerPath = join(workspace, '.book', 'migrations.json');
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8')) as {
      legacyPermissions?: number;
    };
    if ((marker.legacyPermissions ?? 0) >= LEGACY_PERMISSIONS_MIGRATION_VERSION) return false;
  } catch {
    // Missing or malformed markers are safely rebuilt after a successful migration.
  }

  let legacyRules: Array<{ toolName: string; pattern?: string; effect: string }> = [];
  try {
    const raw = readFileSync(legacyPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      rules: Array<{ toolName: string; pattern?: string; effect: string }>;
    };
    legacyRules = parsed.rules ?? [];
  } catch {
    return false; // corrupt — leave the legacy file alone
  }

  if (legacyRules.length === 0) return false;

  const localDir = join(workspace, '.book');
  const localPath = join(localDir, 'settings.local.json');
  const result = new SettingsRepository(localPath).update((existing) => {
    const permissions = (existing.permissions ?? {}) as {
      allow?: string[];
      ask?: string[];
      deny?: string[];
    };
    for (const key of ['allow', 'ask', 'deny'] as const) {
      if (!Array.isArray(permissions[key])) permissions[key] = [];
    }

    for (const rule of legacyRules) {
      const specifier = rule.pattern ? `${rule.toolName}(${rule.pattern})` : rule.toolName;
      const effect = rule.effect as 'allow' | 'ask' | 'deny';
      if (!permissions[effect]!.includes(specifier)) permissions[effect]!.push(specifier);
    }
    existing.permissions = permissions;
  });
  if (!result.ok) return false;

  writeFileAtomic(
    markerPath,
    `${JSON.stringify({ legacyPermissions: LEGACY_PERMISSIONS_MIGRATION_VERSION }, null, 2)}\n`,
  );
  if (!result.changed) return false;

  console.warn(
    `⚠  Migrated ${legacyRules.length} permission rule(s) from ~/.book/permissions.json to ${localPath}. ` +
      'Delete the legacy file after verifying the migration.',
  );
  return true;
}
