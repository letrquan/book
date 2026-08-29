import { readFileSync, existsSync } from 'fs';
import { join, normalize } from 'path';
import {
  bookSettingsSchema,
  DEFAULT_SETTINGS,
  HOOK_EVENTS,
  type BookSettings,
  type HookEntry,
  type HookEvent,
  type ResolvedSettings,
} from './settings.js';
import { SettingsRepository, writeFileAtomic } from './settings-repository.js';
import { resolveBookHome } from './book-home.js';
import { partitionProjectAllowRules } from './permission-approvals.js';
import { collectDeclaredHooks, partitionProjectHooks } from './hook-approvals.js';
import { assertHarnessModeAvailable } from './harness/coordinator.js';
import { defaultTrustStorePath, loadWorkspaceTrust } from './workspace-trust.js';

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
 * - `local` — `<workspace>/.book/settings.local.json`: gitignored and normally
 *   written by the user, or by Book on their behalf.
 * - `repository` — `<workspace>/.book/settings.json`: checked in and controlled
 *   by whoever wrote the repository. It may never grant itself trust.
 */
export type SettingsLayerTrust = 'trusted' | 'local' | 'repository';

/**
 * Settings paths that a workspace file may not supply for itself. Most record
 * a decision the user made *about* repository-controlled input; honouring one
 * from the workspace would let a clone approve itself. Experimental capability
 * flags are included because merely opening a clone must not opt the user into
 * unstable runtime behavior.
 *
 * The local layer is no safer than the checked-in one here. `.gitignore` does
 * not stop a *tracked* file from reaching a clone, so a repository that
 * force-adds `.book/settings.local.json` ships its own approvals with it. Both
 * workspace layers are therefore stripped. Trust decisions come from the
 * user-global store; experimental flags come from a trusted user-global or
 * explicit settings document (or from a process environment opt-in).
 */
const WORKSPACE_FORBIDDEN_PATHS: ReadonlyArray<readonly [string, string]> = [
  ['mcp', 'projectServers'],
  ['permissions', 'projectAllowRules'],
  ['hooks', 'projectEntries'],
  ['commands', 'projectCommands'],
  // Experimental capabilities require an explicit user-global setting, an
  // explicit --settings document, or a process environment opt-in. A clone
  // and even a force-added settings.local.json must not enable them.
  ['experimental', 'zeroMem'],
  // The whole `auth` block - both of its keys. A subscription token is an
  // account-wide bearer credential, and every field here decides where one is
  // obtained or sent: `profiles.<id>.baseUrl` is the host that receives the
  // Authorization header on every inference request, `tokenUrl` receives the
  // authorization code, `headers` rides along with the token, and `profile`
  // picks which credential is spent at all. A clone that could set any of them
  // could harvest the user's subscription token by opening the workspace.
  ['auth', 'profile'],
  ['auth', 'profiles'],
];

function stripPaths(
  settings: Partial<BookSettings>,
  paths: ReadonlyArray<readonly [string, string]>,
): void {
  for (const [parent, key] of paths) {
    const container = (settings as Record<string, unknown>)[parent];
    if (container && typeof container === 'object' && !Array.isArray(container)) {
      delete (container as Record<string, unknown>)[key];
    }
  }
}

function sanitizeLayer(
  settings: Partial<BookSettings>,
  trust: SettingsLayerTrust,
): Partial<BookSettings> {
  if (trust === 'trusted') return settings;
  const sanitized = structuredClone(settings);
  // Project/local settings cannot opt a session into the most permissive mode.
  if (sanitized.defaultMode === 'bypassPermissions') delete sanitized.defaultMode;
  stripPaths(sanitized, WORKSPACE_FORBIDDEN_PATHS);
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
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    typeof (parsed as Record<string, unknown>).compactStrategy === 'string' &&
    ((parsed as Record<string, unknown>).compactStrategy as string).trim().toLowerCase() ===
      'zero-mem'
  ) {
    throw new Error(
      `Invalid settings in ${path}:\n` +
        'compactStrategy "zero-mem" is no longer supported. Enable the experiment with ' +
        'experimental.zeroMem=true in ~/.book/settings.json or set ' +
        'BOOK_EXPERIMENTAL_ZERO_MEM=true.',
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
  trustStorePath?: string;
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
  // Project-declared hook entries are held back the same way: each one is a
  // shell command the repository would otherwise get Book to run.
  const declaredProjectHooks = collectDeclaredHooks(project);
  // Released hooks belong between the user and local layers, matching the
  // relative merge order ungated layers still produce.
  const userHookCounts = Object.fromEntries(
    HOOK_EVENTS.map((event) => [event, resolved.hooks[event].length]),
  ) as Record<HookEvent, number>;
  if (project) {
    let withheld: BookSettings = project;
    if (declaredProjectAllow.length > 0) {
      withheld = { ...withheld, permissions: { ...withheld.permissions, allow: [] } };
    }
    if (declaredProjectHooks.length > 0) {
      withheld = { ...withheld, hooks: structuredClone(DEFAULT_SETTINGS.hooks) };
    }
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

  // Trust decisions come from outside the workspace, so a repository cannot
  // ship its own. Layers the user controls may still carry them — the global
  // file and an explicit `--settings` path are trusted for everything else —
  // but the store has the final say on any key it records.
  const trust = loadWorkspaceTrust(
    workspace,
    paths.trustStorePath ?? defaultTrustStorePath(paths.home),
  );
  resolved.permissions.projectAllowRules = {
    ...resolved.permissions.projectAllowRules,
    ...trust.permissionAllowRules,
  };
  resolved.mcp.projectServers = { ...resolved.mcp.projectServers, ...trust.mcpServers };
  resolved.hooks.projectEntries = { ...resolved.hooks.projectEntries, ...trust.hookEntries };
  resolved.commands.projectCommands = {
    ...resolved.commands.projectCommands,
    ...trust.projectCommands,
  };

  // Every decision source is in place now, so the withheld repository rules can
  // be released — approved ones only.
  if (declaredProjectAllow.length > 0) {
    const { approved } = partitionProjectAllowRules(
      declaredProjectAllow,
      resolved.permissions?.projectAllowRules,
    );
    if (approved.length > 0) {
      resolved.permissions.allow = [...(resolved.permissions.allow ?? []), ...approved];
    }
  }

  if (declaredProjectHooks.length > 0) {
    const { approved } = partitionProjectHooks(
      declaredProjectHooks,
      resolved.hooks?.projectEntries,
    );
    const approvedByEvent = new Map<HookEvent, HookEntry[]>();
    for (const { event, entry } of approved) {
      const entries = approvedByEvent.get(event) ?? [];
      entries.push(entry);
      approvedByEvent.set(event, entries);
    }
    for (const [event, entries] of approvedByEvent) {
      resolved.hooks[event].splice(userHookCounts[event], 0, ...entries);
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
