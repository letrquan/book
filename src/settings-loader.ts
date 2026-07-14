import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  bookSettingsSchema,
  DEFAULT_SETTINGS,
  type BookSettings,
  type ResolvedSettings,
} from './settings.js';

/**
 * Deep-merge two settings objects. For arrays, concatenate (used for
 * permission rules and additionalDirectories). For objects, merge recursively.
 * For scalars, the override wins.
 */
function mergeSettings(base: ResolvedSettings, override: Partial<BookSettings>): ResolvedSettings {
  const result = structuredClone(base) as Record<string, unknown>;

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;

    const existing = result[key];

    if (Array.isArray(value) && Array.isArray(existing)) {
      // Arrays concatenate (permission rules, additionalDirectories).
      result[key] = [...existing, ...value];
    } else if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof existing === 'object' &&
      existing !== null &&
      !Array.isArray(existing)
    ) {
      // Nested objects merge recursively.
      result[key] = mergeSettings(existing as ResolvedSettings, value as Partial<BookSettings>);
    } else {
      // Scalars override.
      result[key] = value;
    }
  }

  return result as ResolvedSettings;
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
  try {
    return bookSettingsSchema.parse(parsed);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid settings in ${path}:\n${msg}`);
  }
}

/**
 * Resolve settings from all scopes: user → project → local.
 * Priority: Local > Project > User.
 *
 * @param workspace - Project root directory
 * @param overridePath - Optional path to an ad-hoc settings file (--settings flag)
 * @returns Fully resolved settings with all defaults filled
 */
export function resolveSettings(workspace: string, overridePath?: string): ResolvedSettings {
  let resolved = structuredClone(DEFAULT_SETTINGS);

  // Layer 1: User settings (~/.book/settings.json)
  const userPath = join(homedir(), '.book', 'settings.json');
  const user = loadSettingsFile(userPath);
  if (user) resolved = mergeSettings(resolved, user);

  // Layer 2: Project settings (<workspace>/.book/settings.json)
  const projectPath = join(workspace, '.book', 'settings.json');
  const project = loadSettingsFile(projectPath);
  if (project) resolved = mergeSettings(resolved, project);

  // Layer 3: Local settings (<workspace>/.book/settings.local.json)
  const localPath = join(workspace, '.book', 'settings.local.json');
  const local = loadSettingsFile(localPath);
  if (local) resolved = mergeSettings(resolved, local);

  // Layer 4 (optional): Ad-hoc override (--settings flag)
  if (overridePath) {
    const override = loadSettingsFile(overridePath);
    if (override) resolved = mergeSettings(resolved, override);
  }

  return resolved;
}

export { mergeSettings, loadSettingsFile };

/**
 * Migrate rules from the legacy ~/.book/permissions.json into the local
 * settings file (<workspace>/.book/settings.local.json). Runs once on first
 * load when the legacy file exists and the local settings don't have rules yet.
 *
 * @returns true if migration occurred, false otherwise
 */
export function migrateLegacyPermissions(workspace: string): boolean {
  const legacyPath = join(homedir(), '.book', 'permissions.json');
  if (!existsSync(legacyPath)) return false;

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
  mkdirSync(localDir, { recursive: true });

  // Read existing local settings (if any).
  let existing: Record<string, unknown> = {};
  if (existsSync(localPath)) {
    try {
      existing = JSON.parse(readFileSync(localPath, 'utf-8'));
    } catch {
      existing = {};
    }
  }

  const permissions = (existing.permissions ?? {}) as {
    allow?: string[];
    ask?: string[];
    deny?: string[];
  };
  for (const key of ['allow', 'ask', 'deny'] as const) {
    if (!Array.isArray(permissions[key])) permissions[key] = [];
  }

  // Convert each legacy rule to a Tool(specifier) string.
  for (const rule of legacyRules) {
    const specifier = rule.pattern ? `${rule.toolName}(${rule.pattern})` : rule.toolName;
    const effect = rule.effect as 'allow' | 'ask' | 'deny';
    if (!permissions[effect]!.includes(specifier)) {
      permissions[effect]!.push(specifier);
    }
  }

  existing.permissions = permissions;
  writeFileSync(localPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

  console.warn(
    `⚠  Migrated ${legacyRules.length} permission rule(s) from ~/.book/permissions.json to ${localPath}. ` +
      'Delete the legacy file after verifying the migration.',
  );
  return true;
}
