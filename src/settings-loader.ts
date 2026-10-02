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
import { collectDeclaredDirectories, partitionProjectDirectories } from './additional-roots.js';
import { partitionProjectAllowRules } from './permission-approvals.js';
import { collectDeclaredHooks, partitionProjectHooks } from './hook-approvals.js';
import { defaultTrustStorePath, loadWorkspaceTrust } from './workspace-trust.js';
import { normalizeRemovedSettings } from './settings-removed.js';
import { parseEnvBoolean } from './env-boolean.js';

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
  // Straight from the list the hooks schema is built from: a hand-written copy of
  // it went stale the moment `Notification` was added, and a later layer's
  // notification hooks then replaced the user layer's instead of appending (#295).
  ...HOOK_EVENTS.map((event) => `hooks.${event}`),
  // The sandbox deny lists are denials, so a later layer can only add to them.
  // Replacing them meant a workspace layer shipping `denyRead: []` erased the
  // user's entries (#373).
  'sandbox.filesystem.denyWrite',
  'sandbox.filesystem.denyRead',
  'sandbox.network.deniedDomains',
]);

/**
 * The concatenated paths whose entries are a set rather than a list, so the
 * same path repeated across layers is stored once.
 */
const DEDUPED_CONCATENATED_ARRAY_PATHS = new Set([
  'sandbox.filesystem.denyWrite',
  'sandbox.filesystem.denyRead',
  'sandbox.network.deniedDomains',
]);

function mergeObject(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
  prefix = '',
): Record<string, unknown> {
  const result = structuredClone(base);

  for (const [key, value] of Object.entries(override)) {
    // JSON.parse keeps `"__proto__"` as an ordinary own key, but `result[key] = …`
    // below would go through the prototype setter: a repository layer could then
    // supply inherited `shell` or `defaultMode` values that sanitizeLayer, which
    // deletes own keys, never sees. No setting has that name, so drop it.
    if (value === undefined || key === '__proto__') continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const existing = result[key];

    if (Array.isArray(value)) {
      if (path === 'additionalDirectories') {
        const combined = [...(Array.isArray(existing) ? existing : []), ...value].map((entry) =>
          normalize(String(entry)),
        );
        result[key] = [...new Set(combined)];
      } else if (CONCATENATED_ARRAY_PATHS.has(path)) {
        const combined = [...(Array.isArray(existing) ? existing : []), ...value];
        result[key] = DEDUPED_CONCATENATED_ARRAY_PATHS.has(path)
          ? [...new Set(combined)]
          : combined;
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
 *
 * An empty `parent` names a key at the document root, which is how the
 * `additionalDirectories` decisions map is expressed: the setting it decides
 * about is itself top-level, so there is no container object to put it in.
 */
const WORKSPACE_FORBIDDEN_PATHS: ReadonlyArray<readonly [string, string]> = [
  ['mcp', 'projectServers'],
  ['permissions', 'projectAllowRules'],
  ['hooks', 'projectEntries'],
  ['commands', 'projectCommands'],
  ['', 'projectDirectories'],
];

function stripPaths(
  settings: Partial<BookSettings>,
  paths: ReadonlyArray<readonly [string, string]>,
): void {
  for (const [parent, key] of paths) {
    if (parent === '') {
      delete (settings as Record<string, unknown>)[key];
      continue;
    }
    const container = (settings as Record<string, unknown>)[parent];
    if (container && typeof container === 'object' && !Array.isArray(container)) {
      delete (container as Record<string, unknown>)[key];
    }
  }
}

/** One `sandbox.*` key a workspace layer supplied that the loader will not honour. */
export interface IgnoredWorkspaceSandboxKey {
  /** Dotted path of the key, e.g. `sandbox.filesystem.allowWrite`. */
  key: string;
  /** The value the layer wrote, so a report can quote what the file actually said. */
  value: unknown;
}

/**
 * `sandbox.*` keys a workspace layer supplies that only loosen, and therefore
 * never survive to the merge. The second element is the one value the layer may
 * set — the tightening direction — or `null` when any value is dropped.
 *
 * The sandbox is the boundary between a command and the host, so a file inside
 * the workspace must not be able to widen it: a checked-in `settings.json`
 * could switch off the sandbox the user enabled, exclude every command
 * (`excludedCommands: ["*"]`), or open a writable root (`allowWrite: ["/"]`)
 * — and because those arrays *replaced* the earlier layer's, even the user's own
 * `denyRead` list could be emptied. Turning the sandbox on, adding deny entries
 * and refusing unsandboxed commands stay available to a workspace layer; they
 * only ever narrow it (#373).
 */
const WORKSPACE_SANDBOX_ONLY_TIGHTENING: ReadonlyArray<readonly [readonly string[], unknown]> = [
  [['sandbox', 'enabled'], true],
  [['sandbox', 'failIfUnavailable'], true],
  [['sandbox', 'allowUnsandboxedCommands'], false],
  [['sandbox', 'autoAllowBashIfSandboxed'], false],
  [['sandbox', 'excludedCommands'], null],
  [['sandbox', 'filesystem', 'allowWrite'], null],
  [['sandbox', 'network', 'allowedDomains'], null],
];

function readPath(settings: Record<string, unknown>, path: readonly string[]): unknown {
  let value: unknown = settings;
  for (const key of path) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
    if (value === undefined) return undefined;
  }
  return value;
}

function deletePath(settings: Record<string, unknown>, path: readonly string[]): void {
  const parent = path.slice(0, -1);
  const key = path[path.length - 1];
  const container = parent.length === 0 ? settings : readContainer(settings, parent);
  if (typeof container === 'object' && container !== null)
    delete (container as Record<string, unknown>)[key];
}

function readContainer(settings: Record<string, unknown>, path: readonly string[]): unknown {
  let value: unknown = settings;
  for (const key of path) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

/**
 * A workspace layer as the file wrote it: parsed, but not required to be
 * complete. The sandbox rule is about what a document *says*, so the reader
 * takes a partial view — a layer that omits `excludedCommands` entirely is
 * describing itself, not supplying an empty list. Every key is optional here,
 * including the nested ones, which is the whole point of the type.
 */
export interface WorkspaceLayerSandboxView {
  sandbox?: Omit<Partial<BookSettings['sandbox']>, 'filesystem' | 'network'> & {
    filesystem?: Partial<BookSettings['sandbox']['filesystem']>;
    network?: Partial<BookSettings['sandbox']['network']>;
  };
}

/**
 * The `sandbox.*` keys `settings` declares that a workspace layer may not
 * supply, with the values it wrote. Pure: `sanitizeLayer` deletes exactly the
 * keys this reports, and `book doctor` prints the same list, so the enforced
 * rule and the reported one cannot drift apart.
 */
export function ignoredWorkspaceSandboxKeys(
  settings: WorkspaceLayerSandboxView,
): IgnoredWorkspaceSandboxKey[] {
  const record = settings as Record<string, unknown>;
  const ignored: IgnoredWorkspaceSandboxKey[] = [];
  for (const [path, tighteningValue] of WORKSPACE_SANDBOX_ONLY_TIGHTENING) {
    const value = readPath(record, path);
    if (value === undefined) continue;
    if (tighteningValue !== null && value === tighteningValue) continue;
    ignored.push({ key: path.join('.'), value });
  }
  return ignored;
}

/** One ignored key as a report line reads it: `sandbox.enabled=false`. */
export function formatIgnoredWorkspaceSandboxKey(entry: IgnoredWorkspaceSandboxKey): string {
  return `${entry.key}=${JSON.stringify(entry.value)}`;
}

/**
 * Drop every loosening `sandbox.*` key from a workspace layer. Deleting rather
 * than overwriting is what makes the key harmless: the merge keeps whatever the
 * earlier, more trusted layer said.
 */
function applyIgnoredWorkspaceSandboxKeys(settings: Partial<BookSettings>): void {
  const record = settings as Record<string, unknown>;
  for (const entry of ignoredWorkspaceSandboxKeys(settings)) {
    deletePath(record, entry.key.split('.'));
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
  // `shell` names the program every Bash command is handed to. A clone that
  // could point it at a binary it ships would run that binary on the first
  // command, so the key is honoured from trusted layers only.
  delete sanitized.shell;
  // Nor may a workspace file widen the sandbox it is supposed to be confined by.
  applyIgnoredWorkspaceSandboxKeys(sanitized);
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
  // A setting that was removed must not brick a working install: an obsolete
  // value of a surviving key would otherwise fail the whole document and stop
  // Book from starting, with a schema dump that names no remedy. Removed keys
  // are reported by `book doctor`, which reads the file itself.
  parsed = normalizeRemovedSettings(parsed);
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

/**
 * Every settings file this resolution would read, in layer order.
 *
 * Exported so callers that need to inspect the files themselves — `book doctor`
 * reporting removed keys, the credential error checking for a stale `auth`
 * block — resolve the same paths the loader does rather than rebuilding them.
 */
export function settingsLayerPaths(
  workspace: string,
  overridePath?: string,
  paths: SettingsResolutionPaths = {},
): string[] {
  const userPath =
    paths.userSettingsPath ??
    (paths.home
      ? join(paths.home, '.book', 'settings.json')
      : join(resolveBookHome(), 'settings.json'));
  const layers = [
    userPath,
    paths.projectSettingsPath ?? join(workspace, '.book', 'settings.json'),
    paths.localSettingsPath ?? join(workspace, '.book', 'settings.local.json'),
  ];
  if (overridePath) layers.push(overridePath);
  return layers;
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
  // `additionalDirectories` widens the roots the file tools serve, so a checked-in
  // declaration is held back for the same reason a project allow rule is: it
  // grants authority, and the decisions that release it live in the local layer,
  // which has not been merged yet. Released after the trust store loads, by real path.
  const declaredProjectDirectories = project?.additionalDirectories ?? [];
  // Released declarations belong between the user and local layers, matching the
  // relative merge order ungated layers still produce.
  const userHookCounts = Object.fromEntries(
    HOOK_EVENTS.map((event) => [event, resolved.hooks[event].length]),
  ) as Record<HookEvent, number>;
  if (project) {
    let withheld: BookSettings = project;
    if (declaredProjectAllow.length > 0) {
      withheld = { ...withheld, permissions: { ...withheld.permissions, allow: [] } };
    }
    if (declaredProjectDirectories.length > 0) {
      withheld = { ...withheld, additionalDirectories: [] };
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
  resolved.projectDirectories = {
    ...resolved.projectDirectories,
    ...trust.projectDirectories,
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

  if (declaredProjectDirectories.length > 0) {
    // Released by real path, not by the text the repository wrote: see `additional-roots.ts`.
    // Approved entries join the resolved list as their declared text, which is what the merge
    // above normalizes and deduplicates; the file tools resolve it again to the same place.
    const { approved } = partitionProjectDirectories(
      collectDeclaredDirectories(workspace, declaredProjectDirectories),
      resolved.projectDirectories,
    );
    if (approved.length > 0) {
      // The approved **real path**, never the declared text. A consumer resolves this list again
      // later with no trust store in hand (see `resolveAdditionalRoots`), so a relative or
      // symlinked spelling would let a relink move a root the user approved as somewhere else.
      // The user saw the real path when the prompt named it; the repository's spelling is what
      // would be dangerous to re-resolve (PR #334 finding 7).
      resolved.additionalDirectories = [
        ...(resolved.additionalDirectories ?? []),
        ...approved.map((directory) => directory.realPath),
      ];
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
  return settings;
}

/**
 * The environment's say over the merged layers, applied to settings that are
 * about to be used rather than saved.
 *
 * `BOOK_STARTUP_ANIMATION` is here, and not in `loadConfig`, because the layers
 * are only half the answer: a reader that resolved the files and stopped would
 * report the file's value while Book acts on the variable's. So every path that
 * produces the *effective* settings calls this — the startup config, the
 * re-read after a provider is removed, `book config get`/`list`. A path that
 * computes what gets written back to a settings file must not: the variable
 * decides the next launch, and baking it into a file would make a later
 * `unset` look like it had failed.
 *
 * The returned object is a new one; the input is left as the caller resolved it.
 */
export function applySettingsEnvOverrides(
  settings: ResolvedSettings,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSettings {
  const startupAnimation = parseEnvBoolean(env.BOOK_STARTUP_ANIMATION);
  if (startupAnimation === undefined) return settings;
  return { ...settings, ui: { ...settings.ui, startupAnimation } };
}

/**
 * What to tell a user whose read or save is being decided by the environment
 * rather than by their settings — the `BOOK_MODEL` warning in one sentence, or
 * nothing when the variable is unset or unreadable.
 */
export function startupAnimationEnvNote(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.BOOK_STARTUP_ANIMATION;
  if (parseEnvBoolean(raw) === undefined) return undefined;
  return (
    `BOOK_STARTUP_ANIMATION is set to "${raw}" — it decides the splash at every ` +
    'launch, so ui.startupAnimation will not apply while it is set.'
  );
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
  if (!validatedSettings) {
    resolveSettings(workspace, undefined, home ? { home } : undefined);
  }

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
