import { readFileSync, existsSync } from 'fs';
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
      result[key] = mergeSettings(
        existing as ResolvedSettings,
        value as Partial<BookSettings>,
      );
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
export function resolveSettings(
  workspace: string,
  overridePath?: string,
): ResolvedSettings {
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
