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

/** Project/local settings cannot opt a session into the most permissive mode. */
function sanitizeUntrustedPermissionSettings(
  settings: Partial<BookSettings>,
): Partial<BookSettings> {
  const sanitized = structuredClone(settings);
  if (sanitized.defaultMode === 'bypassPermissions') delete sanitized.defaultMode;
  return sanitized;
}

function mergeLayer(
  resolved: ResolvedSettings,
  layer: Partial<BookSettings>,
  trusted: boolean,
): ResolvedSettings {
  const candidate = trusted ? layer : sanitizeUntrustedPermissionSettings(layer);
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
  if (user) resolved = mergeLayer(resolved, user, true);

  // Layer 2: Project settings (<workspace>/.book/settings.json)
  const projectPath = paths.projectSettingsPath ?? join(workspace, '.book', 'settings.json');
  const project = loadSettingsFile(projectPath);
  if (project) resolved = mergeLayer(resolved, project, false);

  // Layer 3: Local settings (<workspace>/.book/settings.local.json)
  const localPath = paths.localSettingsPath ?? join(workspace, '.book', 'settings.local.json');
  const local = loadSettingsFile(localPath);
  if (local) resolved = mergeLayer(resolved, local, false);

  // Layer 4 (optional): Ad-hoc override (--settings flag)
  if (overridePath) {
    const override = loadSettingsFile(overridePath);
    if (override) resolved = mergeLayer(resolved, override, true);
  }

  return bookSettingsSchema.parse(resolved) as ResolvedSettings;
}

export { loadSettingsFile };

/**
 * Migrate rules from the legacy ~/.book/permissions.json into the local
 * settings file (<workspace>/.book/settings.local.json). Runs once on first
 * load when the legacy file exists and the local settings don't have rules yet.
 *
 * @param home - User home directory; injectable for isolated migration tests
 * @returns true if migration occurred, false otherwise
 */
export function migrateLegacyPermissions(workspace: string, home?: string): boolean {
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
