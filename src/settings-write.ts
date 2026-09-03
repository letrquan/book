/**
 * The one guarded write behind every `<key>=<value>` settings change.
 *
 * There are two of those surfaces — `book config set` and the TUI's `/config
 * <key>=<value>` — and until this module existed they agreed about almost
 * nothing. The CLI defaulted to the user-global layer, refused a key no loader
 * reads, and checked the resulting *merge* before writing; the TUI always wrote
 * `.book/settings.local.json`, accepted any key at all, and reported success
 * either way. A user could therefore set the same preference twice, two ways,
 * and get two files, one of which was inert.
 *
 * The guards are ordered so the most specific refusal wins, and every one of
 * them runs *before* anything is written: a refusal that lands after a partial
 * write is a worse outcome than the write it was trying to prevent.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getNestedValue, setNestedValue } from './cli/utils.js';
import { resolveSettings } from './settings-loader.js';
import { assertHarnessModeAvailable, assertSelectableWorkflow } from './harness/coordinator.js';
import {
  formatSettingsDiagnostics,
  readSettingsDocument,
  SETTINGS_TOP_LEVEL_KEYS,
  SettingsRepository,
} from './settings-repository.js';
import {
  blockedConfigWritePath,
  settingsScopeLabel,
  settingsScopePath,
  type SettingsScope,
} from './settings-scope.js';

/**
 * Settings paths held in `<BOOK_HOME>/trust.json` rather than in either
 * workspace layer, mapped to the `book trust` subcommand that records them.
 * `mcp.projectServers` has no subcommand yet; it is listed so the refusal
 * explains the silence instead of writing a key nothing reads.
 */
const TRUST_OWNED_KEYS: Record<string, string> = {
  'commands.projectCommands': 'Record it with: book trust command <name>',
  'hooks.projectEntries': 'Record it with: book trust hook <fingerprint>',
  'permissions.projectAllowRules': 'Record it with: book trust rule <rule>',
  'mcp.projectServers': 'Approve the server when Book prompts for it.',
};

/**
 * Read one layer's file verbatim, without merging or defaults.
 *
 * `resolveSettings` deliberately cannot answer "what is in this file", because
 * it returns the merge. A scoped read has to bypass it. A missing file is an
 * ordinary answer here; an unreadable one is *not* reported as an empty one,
 * because that would let a malformed layer look like it holds nothing while it
 * is still the file the user has to fix.
 */
export interface ScopeDocument {
  scope: SettingsScope;
  path: string;
  /** `absent` and `unreadable` both yield an empty `document`, and mean different things. */
  status: 'present' | 'absent' | 'unreadable';
  error?: string;
  document: Record<string, unknown>;
}

export function readScopeDocument(scope: SettingsScope, workspace: string): ScopeDocument {
  const path = settingsScopePath(scope, workspace);
  const result = readSettingsDocument(path);
  if (result.status === 'valid') {
    return { scope, path, status: 'present', document: result.document };
  }
  if (result.status === 'absent') {
    return { scope, path, status: 'absent', document: {} };
  }
  return { scope, path, status: 'unreadable', error: result.error, document: {} };
}

/** Which `SettingsResolutionPaths` entry a scope occupies in the merge. */
const SCOPE_RESOLUTION_PATH = {
  user: 'userSettingsPath',
  project: 'projectSettingsPath',
  local: 'localSettingsPath',
} as const satisfies Record<SettingsScope, string>;

export interface SettingWriteOptions {
  workspace: string;
  /** Dot-separated settings path, exactly as the user typed it. */
  key: string;
  /** Already parsed from its source syntax; stored verbatim. */
  value: unknown;
  scope: SettingsScope;
  settingsOverridePath?: string;
  noSettings?: boolean;
}

/**
 * A layer that defines the same key and is resolved after the one written.
 *
 * `override` is the `--settings <path>` document, which is merged last of all
 * and so outranks every scope a command can write.
 */
export interface SettingShadow {
  scope: SettingsScope | 'override';
  path: string;
  /** The layer could not be read, so whether it shadows the write is unknown. */
  unreadable: boolean;
  error?: string;
}

export type SettingWriteResult =
  | { ok: false; error: string }
  | {
      ok: true;
      scope: SettingsScope;
      /** The file actually written, for a message that names it. */
      path: string;
      value: unknown;
      shadowedBy: SettingShadow[];
    };

/**
 * Would this write leave a merged configuration that no command can load?
 *
 * Validating the single layer being written does not determine the effective
 * configuration. `harness.workflow` is valid on its own and rejected against an
 * effective `harness.mode` of `off` — so the write succeeded and every
 * subsequent invocation, including the command that made it, failed before it
 * started. The recovery was hand-editing JSON.
 *
 * The candidate layer is resolved in place of the real one, through the same
 * merge and the same assertions the loader runs, so this cannot drift from what
 * actually rejects the configuration. Returns the loader's own message, which
 * already says what to change.
 */
function describeEffectiveBreak(options: SettingWriteOptions): string | undefined {
  // With every layer skipped there is no merge to predict, and the write is
  // aimed at a file this invocation is deliberately not reading.
  if (options.noSettings) return undefined;

  const layer = readScopeDocument(options.scope, options.workspace);
  // An unreadable layer is about to be reported by the write itself, and a
  // candidate built on a document we could not read would be a guess.
  if (layer.status === 'unreadable') return undefined;

  const loads = (paths?: Record<string, string>): boolean => {
    try {
      assertLoadable(options.workspace, options.settingsOverridePath, paths);
      return true;
    } catch {
      return false;
    }
  };

  // A configuration that was already broken must not make this refuse the write
  // that would repair it. Setting a key is the tool a user reaches for when a
  // layer is wrong, so only a write that *introduces* the failure is refused.
  if (!loads()) return undefined;

  const candidate = structuredClone(layer.document);
  setNestedValue(candidate, options.key, options.value);

  const directory = mkdtempSync(join(tmpdir(), 'book-config-preflight-'));
  try {
    const candidatePath = join(directory, 'settings.json');
    writeFileSync(candidatePath, JSON.stringify(candidate));
    assertLoadable(options.workspace, options.settingsOverridePath, {
      [SCOPE_RESOLUTION_PATH[options.scope]]: candidatePath,
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Resolve the merge and run the loader's own cross-layer assertions. */
function assertLoadable(
  workspace: string,
  settingsOverridePath: string | undefined,
  paths?: Record<string, string>,
): void {
  const resolved = resolveSettings(workspace, settingsOverridePath, paths);
  assertHarnessModeAvailable(resolved.harness.mode);
  assertSelectableWorkflow(resolved.harness.mode, resolved.harness.workflow);
}

/**
 * Resolution runs user → project → local → `--settings` override, so these are
 * the layers merged *after* each writable scope.
 */
const SCOPES_RESOLVED_AFTER = {
  user: ['project', 'local'],
  project: ['local'],
  local: [],
} as const satisfies Record<SettingsScope, ReadonlyArray<SettingsScope>>;

/**
 * The layers that define `key` and are resolved *after* the one written.
 *
 * A write can look like it did nothing: anything merged later still decides the
 * session. Reporting it is the difference between a setting that took and one
 * that merely claims to have. This checked only the user scope at first, which
 * left `--project` — the scope most likely to be shadowed, since the local
 * layer is exactly where a previous version of this command put everything —
 * reporting success for a value nothing would read. An unreadable layer is
 * reported too: it cannot be shown to hold the key, and cannot be shown not to.
 */
function shadowingScopes(
  workspace: string,
  scope: SettingsScope,
  key: string,
  settingsOverridePath?: string,
): SettingShadow[] {
  const shadowing: SettingShadow[] = [];
  for (const candidate of SCOPES_RESOLVED_AFTER[scope]) {
    const layer = readScopeDocument(candidate, workspace);
    if (layer.status === 'unreadable') {
      shadowing.push({
        scope: candidate,
        path: layer.path,
        unreadable: true,
        error: layer.error,
      });
      continue;
    }
    if (layer.status === 'absent') continue;
    if (getNestedValue(layer.document, key) === undefined) continue;
    shadowing.push({ scope: candidate, path: layer.path, unreadable: false });
  }
  // The override document is merged after every scope, so it wins over a write
  // to any of them — including the local layer, which nothing else shadows.
  if (settingsOverridePath) {
    const override = readSettingsDocument(settingsOverridePath);
    if (override.status === 'malformed' || override.status === 'non-object') {
      shadowing.push({
        scope: 'override',
        path: settingsOverridePath,
        unreadable: true,
        error: override.error,
      });
    } else if (
      override.status === 'valid' &&
      getNestedValue(override.document, key) !== undefined
    ) {
      shadowing.push({ scope: 'override', path: settingsOverridePath, unreadable: false });
    }
  }
  return shadowing;
}

/** The refusal for a key no configuration surface may write, or undefined. */
export function guardSettingWrite(key: string, value: unknown): string | undefined {
  const parts = key.split('.').filter(Boolean);
  if (parts.length === 0) {
    return 'Invalid key. Use dot-separated path: e.g. permissions.deny';
  }

  const blocked = blockedConfigWritePath(key);
  if (blocked) return blocked;

  const topKey = parts[0];
  if (!SETTINGS_TOP_LEVEL_KEYS.includes(topKey)) {
    return (
      'Unknown top-level key: ' + topKey + '. Valid keys: ' + SETTINGS_TOP_LEVEL_KEYS.join(', ')
    );
  }

  // Every key recording a decision *about* a repository is read from
  // `<BOOK_HOME>/trust.json`, never from a settings file — the workspace layers
  // are stripped of them, and no loader consults the user-global one for them
  // either. Writing one here would report success and change nothing on the
  // next load in *any* scope, so it is refused everywhere, naming the command
  // that does record it.
  //
  // Matching has to run in both directions. A deeper path reaches the key
  // (`commands.projectCommands.deploy`), and so does a shallower one: setting
  // `commands` to `{"projectCommands":…}` replaces the whole section, which is
  // the same write with the same silent outcome. Comparing only the first two
  // segments would have caught the first and missed the second.
  const trustPath = Object.keys(TRUST_OWNED_KEYS).find(
    (owned) => key === owned || key.startsWith(`${owned}.`) || owned.startsWith(`${key}.`),
  );
  if (trustPath) {
    return (
      `${trustPath} records a decision about repository-declared configuration, so it is\n` +
      `not read from any file inside the workspace. Writing it here would change nothing.\n` +
      `  ${TRUST_OWNED_KEYS[trustPath]}`
    );
  }

  if (
    key.trim().toLowerCase() === 'compactstrategy' &&
    typeof value === 'string' &&
    value.trim().toLowerCase() === 'zero-mem'
  ) {
    return (
      'compactStrategy "zero-mem" is no longer supported. Set ' +
      'experimental.zeroMem=true in <BOOK_HOME>/settings.json, pass an explicit ' +
      '--settings file, or use BOOK_EXPERIMENTAL_ZERO_MEM=true.'
    );
  }

  return undefined;
}

/**
 * Guard, preflight, and write one settings key. Never throws, never prints.
 *
 * Callers own presentation only: the CLI writes to stdout and sets an exit
 * code, the TUI renders a transcript line. Sharing everything up to that point
 * is what keeps the two surfaces from disagreeing about which file a preference
 * lands in.
 */
export function applySettingWrite(options: SettingWriteOptions): SettingWriteResult {
  const refusal = guardSettingWrite(options.key, options.value);
  if (refusal) return { ok: false, error: refusal };

  // Checked before the write, not after: a value that bricks the merge would
  // otherwise have to be removed by hand, since every command that could
  // remove it fails at load.
  const effectiveBreak = describeEffectiveBreak(options);
  if (effectiveBreak) {
    return {
      ok: false,
      error:
        `Refusing to write ${options.key}: the resulting configuration would not load.\n` +
        `  ${effectiveBreak}\n` +
        `  ${options.key} is valid on its own, but a settings layer does not decide the effective\n` +
        `  configuration -- the merge of every layer does. Nothing was written.`,
    };
  }

  const targetPath = settingsScopePath(options.scope, options.workspace);
  const result = new SettingsRepository(targetPath).set({ [options.key]: options.value });
  if (!result.ok) {
    return { ok: false, error: formatSettingsDiagnostics(result.diagnostics) };
  }

  return {
    ok: true,
    scope: options.scope,
    path: result.path,
    value: options.value,
    shadowedBy: shadowingScopes(
      options.workspace,
      options.scope,
      options.key,
      options.settingsOverridePath,
    ),
  };
}

/** How a shadowing layer is named in a message. */
function shadowLabel(shadow: SettingShadow): string {
  return shadow.scope === 'override' ? '--settings override' : settingsScopeLabel(shadow.scope);
}

/** How a shadowing layer is described, with the command that clears it. */
export function describeSettingShadow(shadow: SettingShadow, key: string): string {
  if (shadow.unreadable) {
    return (
      `${shadowLabel(shadow)} settings (${shadow.path}) could not be read ` +
      `(${shadow.error ?? 'unknown error'}), so whether it overrides ${key} here is unknown.`
    );
  }
  const remedy =
    shadow.scope === 'override'
      ? `Remove ${key} from that file, or start without --settings.`
      : `Clear it with: book config unset --${shadow.scope} ${key}`;
  return (
    `${key} is also set in ${shadowLabel(shadow)} settings (${shadow.path}), ` +
    `which is resolved later and still wins here. ${remedy}`
  );
}
