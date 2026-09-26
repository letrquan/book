import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';
import { homedir } from 'os';
import type { AgentConfig, RetryConfig } from './types/runtime.js';
import {
  resolveSettings,
  migrateLegacyPermissions,
  settingsLayerPaths,
} from './settings-loader.js';
import { hadRemovedAuthConfiguration } from './settings-removed.js';
import type { SettingsResolutionPaths } from './settings-loader.js';
import { DEFAULT_SETTINGS, type CompactStrategy, type ResolvedSettings } from './settings.js';
import { loadMemoryContext } from './memory-store.js';
import { EFFORT_LEVELS, getAvailableEffortLevels, isEffortLevel } from './commands/effort.js';
import { createModelWindowStore, type ModelWindowStore } from './model-window-store.js';
import { resolveShell } from './shell-selection.js';

/** Legacy .bookrc.json schema (v0.1.0 format, deprecated). */
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
/** Conservative per-request output budget when a model provides no metadata. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

const legacyConfigSchema = z.object({
  model: z.string().optional(),
  baseUrl: z.string().url().optional(),
  maxTurns: z.number().int().min(1).optional(),
  maxTokens: z.number().int().min(1000).optional(),
  autoCompactEnabled: z.boolean().optional(),
  animation: z
    .object({
      typewriterSpeed: z.number().int().min(1).max(50).default(3),
      spinnerStyle: z.enum(['braille', 'dots']).default('braille'),
    })
    .optional(),
  accessibility: z
    .object({
      screenReader: z.boolean().default(false),
      reducedMotion: z.boolean().default(false),
    })
    .optional(),
});

/**
 * Try to load a legacy .bookrc.json file from the workspace root.
 * Returns partial config if found, null otherwise. Emits a deprecation warning.
 */
function loadLegacyConfig(workspace: string): Partial<AgentConfig> | null {
  const path = join(workspace, '.bookrc.json');
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    const parsed = legacyConfigSchema.parse(raw);
    console.warn(
      '⚠  .bookrc.json is deprecated. Move your settings to .book/settings.json (project), ' +
        '.book/settings.local.json (local overrides), or ~/.book/settings.json (user).',
    );
    return {
      model: parsed.model,
      baseUrl: parsed.baseUrl,
      maxTurns: parsed.maxTurns,
      maxTokens: parsed.maxTokens,
      autoCompactEnabled: parsed.autoCompactEnabled,
      animation: parsed.animation,
      accessibility: parsed.accessibility,
    };
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${path}`);
    }
    throw e;
  }
}

export interface LoadConfigOptions {
  /** Path to an ad-hoc settings file (--settings flag); takes highest priority. */
  settingsOverridePath?: string;
  /** If true, skip all settings.json layers entirely (use defaults + legacy .bookrc.json). */
  noSettings?: boolean;
  /** Run storage migrations after effective settings are validated. */
  runMigrations?: boolean;
  /** CLI -m/--model override, applied before provider registry resolution. */
  modelOverride?: string;
  /**
   * CLI --effort override. Passed in rather than assigned after the fact so it
   * counts as an explicit choice: model metadata must not override a level the
   * user typed, and providers that gate on `effortExplicit` must see it.
   */
  effortOverride?: AgentConfig['effort'];
  /**
   * Redirect individual settings layers. Pointing one at a path that does not
   * exist drops it from the merge, which is how `book doctor` finds the layer a
   * failure first appears in.
   */
  settingsPaths?: SettingsResolutionPaths;
  /** Let the interactive TUI start before a BYOK credential has been added. */
  allowMissingApiKey?: boolean;
  /** Optional store for learned context window ceilings. */
  modelWindowStore?: ModelWindowStore;
}

export function loadConfig(workspace?: string, options?: LoadConfigOptions): AgentConfig {
  const settingsOverridePath = options?.settingsOverridePath;
  const noSettings = options?.noSettings ?? false;
  const resolvedWorkspace = workspace || process.env.BOOK_WORKSPACE || process.cwd();

  // Resolve layered settings.json from user/project/local scopes, or skip
  // entirely when --no-settings is set (useful for scripted/isolated runs).
  let settings = noSettings
    ? structuredClone(DEFAULT_SETTINGS)
    : resolveSettings(resolvedWorkspace, settingsOverridePath, options?.settingsPaths);

  if (!noSettings && options?.runMigrations) {
    const migrated = migrateLegacyPermissions(resolvedWorkspace, undefined, settings);
    if (migrated) {
      settings = resolveSettings(resolvedWorkspace, settingsOverridePath, options?.settingsPaths);
    }
  }

  // Load legacy .bookrc.json (deprecated) only after settings availability is accepted.
  const legacy = loadLegacyConfig(resolvedWorkspace);

  // Resolve retry configuration: env vars take precedence over settings.json.
  const retry: RetryConfig = {
    maxAttempts: process.env.BOOK_RETRY_MAX_ATTEMPTS
      ? clampInt(process.env.BOOK_RETRY_MAX_ATTEMPTS, 0, 15)
      : (settings.retry?.maxAttempts ?? DEFAULT_SETTINGS.retry.maxAttempts),
    baseDelayMs: process.env.BOOK_RETRY_BASE_DELAY_MS
      ? clampInt(process.env.BOOK_RETRY_BASE_DELAY_MS, 100, 60000)
      : (settings.retry?.baseDelayMs ?? DEFAULT_SETTINGS.retry.baseDelayMs),
    maxDelayMs: process.env.BOOK_RETRY_MAX_DELAY_MS
      ? clampInt(process.env.BOOK_RETRY_MAX_DELAY_MS, 100, 300000)
      : (settings.retry?.maxDelayMs ?? DEFAULT_SETTINGS.retry.maxDelayMs),
    totalBudgetMs: process.env.BOOK_RETRY_TOTAL_BUDGET_MS
      ? clampInt(process.env.BOOK_RETRY_TOTAL_BUDGET_MS, 0, 600000)
      : (settings.retry?.totalBudgetMs ?? DEFAULT_SETTINGS.retry.totalBudgetMs),
    requestTimeoutMs: process.env.BOOK_REQUEST_TIMEOUT_MS
      ? clampInt(process.env.BOOK_REQUEST_TIMEOUT_MS, 5000, 600000)
      : (settings.retry?.requestTimeoutMs ?? DEFAULT_SETTINGS.retry.requestTimeoutMs),
    streamStallTimeoutMs: process.env.BOOK_STREAM_STALL_TIMEOUT_MS
      ? clampInt(process.env.BOOK_STREAM_STALL_TIMEOUT_MS, 5000, 120000)
      : (settings.retry?.streamStallTimeoutMs ?? DEFAULT_SETTINGS.retry.streamStallTimeoutMs),
    thinkingStallTimeoutMs: process.env.BOOK_THINKING_STALL_TIMEOUT_MS
      ? clampInt(process.env.BOOK_THINKING_STALL_TIMEOUT_MS, 10_000, 1_800_000)
      : (settings.retry?.thinkingStallTimeoutMs ?? DEFAULT_SETTINGS.retry.thinkingStallTimeoutMs),
    toolRetries: process.env.BOOK_TOOL_RETRIES
      ? clampInt(process.env.BOOK_TOOL_RETRIES, 0, 3)
      : (settings.retry?.toolRetries ?? DEFAULT_SETTINGS.retry.toolRetries),
    watchdog: process.env.BOOK_RETRY_WATCHDOG === '1' || settings.retry?.watchdog === true,
    streamReissueAttempts: process.env.BOOK_STREAM_REISSUE_ATTEMPTS
      ? clampInt(process.env.BOOK_STREAM_REISSUE_ATTEMPTS, 0, 10)
      : (settings.retry?.streamReissueAttempts ?? DEFAULT_SETTINGS.retry.streamReissueAttempts),
    outputCapContinuations:
      settings.retry?.outputCapContinuations ?? DEFAULT_SETTINGS.retry.outputCapContinuations,
  };

  const memoryContext = settings.memory.enabled ? loadMemoryContext(resolvedWorkspace) : undefined;

  const envMaxTokens = parsePositiveInt(process.env.BOOK_MAX_TOKENS, 'BOOK_MAX_TOKENS');
  const maxTokensExplicit =
    envMaxTokens !== undefined ||
    settings.maxTokens !== undefined ||
    legacy?.maxTokens !== undefined;
  // "Explicit" means a human chose this level -- by flag, env var, or settings --
  // as opposed to a default or a value inferred from model metadata. Both
  // consumers depend on that one meaning: applyModelDefaults declines to override
  // an explicit level, and the OpenAI-compatible path sends `reasoning_effort`
  // only for one. Omitting the flag left `--effort` accepted, reported, and
  // discarded on that path.
  const effortExplicit = Boolean(
    options?.effortOverride || process.env.BOOK_EFFORT || settings.effort,
  );
  const rawModel =
    options?.modelOverride || process.env.BOOK_MODEL || settings.model || legacy?.model || 'gpt-4o';
  const compactModel = process.env.BOOK_COMPACT_MODEL || settings.compactModel;
  const compactEffort = settings.compactEffort;
  const compactStrategy: CompactStrategy = 'summary';
  // Resolved once here: the Bash tool, the system prompt, and `book doctor`
  // must all name the same shell for the whole session.
  const shell = resolveShell({ requested: settings.shell });
  const defaultApiKey = process.env.BOOK_API_KEY || '';
  const explicitBaseUrl = process.env.BOOK_BASE_URL || legacy?.baseUrl;
  const defaultProviderOverride = validateProvider(process.env.BOOK_PROVIDER) || 'auto';

  const defaultBaseUrl = explicitBaseUrl || DEFAULT_OPENAI_BASE_URL;
  const defaultMaxTokens =
    envMaxTokens ?? settings.maxTokens ?? legacy?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const defaultEffort =
    options?.effortOverride || validateEffort(process.env.BOOK_EFFORT) || settings.effort || 'high';
  const defaultProvider = defaultProviderOverride;

  let config: AgentConfig = {
    apiKey: defaultApiKey,
    baseUrl: defaultBaseUrl,
    model: rawModel,
    modelSelection: rawModel,
    compactModel,
    compactEffort,
    compactStrategy,
    // Undefined = unlimited. Only set when env/settings/legacy explicitly provide a value.
    maxTurns: process.env.BOOK_MAX_TURNS
      ? parseInt(process.env.BOOK_MAX_TURNS, 10)
      : (settings.maxTurns ?? legacy?.maxTurns),
    maxTokens: defaultMaxTokens,
    maxTokensExplicit,
    defaultMaxTokens,
    effortExplicit,
    defaultEffort,
    defaultApiKey,
    defaultBaseUrl,
    defaultProvider,
    autoCompactEnabled: settings.autoCompactEnabled ?? legacy?.autoCompactEnabled ?? true,
    workspace: resolvedWorkspace,
    animation: legacy?.animation || { typewriterSpeed: 3, spinnerStyle: 'braille' },
    accessibility: legacy?.accessibility || { screenReader: false, reducedMotion: false },
    settings,
    shell,
    settingsContext: {
      overridePath: settingsOverridePath,
      noSettings,
    },
    retry,
    memoryContext,
    effort: defaultEffort,
    provider: defaultProvider,
    modelWindowStore: options?.modelWindowStore ?? createModelWindowStore(),
  };

  config = applyModelDefaults(resolveModelProviderConfig(config, rawModel));
  config.modelProviderWarning = describeUnresolvedProviderPrefix(settings.provider, rawModel);

  if (!config.apiKey && !options?.allowMissingApiKey) {
    // Someone whose only credential was a subscription profile arrives here
    // after their `auth` block was silently discarded by validation. Telling
    // them to set a key they never had describes a user who configured
    // nothing, not one whose working configuration was removed.
    throw new Error(
      'BOOK_API_KEY or provider.<id>.apiKey not set. Set BOOK_API_KEY ' +
        'or use {env:VAR} in settings.' +
        (hadRemovedAuthConfiguration(
          noSettings
            ? []
            : settingsLayerPaths(resolvedWorkspace, settingsOverridePath, options?.settingsPaths),
          process.env,
        )
          ? '\n\nSubscription authentication (`book auth login`) was removed in this version, ' +
            'and Book authenticates with API keys only. The auth configuration still on this ' +
            'machine is no longer read; `book doctor` lists it and what to delete.'
          : ''),
    );
  }

  return config;
}

function plainModelConfig(config: AgentConfig, model: string): AgentConfig {
  return {
    ...config,
    // `||`, not `??`: `defaultApiKey` is `''` when BOOK_API_KEY is unset, and
    // an empty string is present as far as `??` is concerned. Switching to an
    // unprefixed model would then wipe a key that came from a provider entry
    // and send every later request out with an empty credential.
    apiKey: config.defaultApiKey || config.apiKey,
    baseUrl: config.defaultBaseUrl || config.baseUrl,
    model,
    modelSelection: model,
    modelInfo: undefined,
    provider: config.defaultProvider ?? config.provider,
  };
}

/** Whether a human chose the config's effort level; see `AgentConfig.effortChosen`. */
export function isEffortChosen(
  config: Pick<AgentConfig, 'effortChosen' | 'effortExplicit'>,
): boolean {
  return config.effortChosen ?? config.effortExplicit === true;
}

export function applyModelDefaults(config: AgentConfig): AgentConfig {
  const maxTokens = config.maxTokensExplicit
    ? config.maxTokens
    : (config.modelInfo?.maxOutputTokens ?? config.defaultMaxTokens ?? config.maxTokens);

  let effort = config.effort;
  if (!isEffortChosen(config)) {
    if (config.modelInfo?.effort === false) {
      effort = undefined;
    } else if (typeof config.modelInfo?.effort === 'object' && config.modelInfo.effort.default) {
      effort = config.modelInfo.effort.default;
    } else {
      effort = config.defaultEffort ?? effort;
    }
  }

  return { ...config, maxTokens, effort };
}

/** Freeze resolved configuration so runtime code cannot acquire mutable session state. */
export function freezeAgentConfig(config: AgentConfig): AgentConfig {
  return deepFreeze(config);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * Describe a `<prefix>/` in a model id that matches no configured provider.
 *
 * The two forms are spelled identically: `9router/qc/qwen3.7-max` names a
 * configured provider, while `meta-llama/llama-3-70b` is one vendor-namespaced
 * model id that an OpenAI-compatible endpoint expects verbatim. An unmatched
 * prefix therefore cannot be rejected -- falling back to the plain id is right
 * for the second form, and that fallback is why nothing was ever said about the
 * first.
 *
 * Once the user has configured providers at all, though, a prefix matching none
 * of them is far more likely a typo than a namespace, and the fallback quietly
 * substitutes `https://api.openai.com/v1` -- an endpoint they never chose, for a
 * vendor that has never heard of the model. The only symptom is a separate
 * "credentials not resolved" line, which sends them looking for a missing key
 * rather than a misspelled provider id.
 */
export function describeUnresolvedProviderPrefix(
  providers: ResolvedSettings['provider'],
  rawModel: string,
): string | undefined {
  const slash = rawModel.indexOf('/');
  if (slash <= 0 || slash === rawModel.length - 1) return undefined;

  const prefix = rawModel.slice(0, slash);
  const configured = Object.keys(providers);
  if (configured.length === 0 || configured.includes(prefix)) return undefined;

  return (
    `Model "${rawModel}" names provider "${prefix}", which is not configured ` +
    `(configured: ${[...configured].sort().join(', ')}). ` +
    `Treating the whole id as a model name against the default endpoint. ` +
    `Add provider.${prefix} to settings, or use one of the configured ids.`
  );
}

/** Resolve "provider/model" strings through settings.provider, OpenCode-style. */
export function resolveModelProviderConfig(
  config: AgentConfig,
  rawModel = config.model,
): AgentConfig {
  const slash = rawModel.indexOf('/');
  if (slash <= 0) return plainModelConfig(config, rawModel);
  if (slash === rawModel.length - 1) {
    throw new Error(`Invalid model "${rawModel}". Expected "provider/model".`);
  }

  const providerId = rawModel.slice(0, slash);
  const model = rawModel.slice(slash + 1);
  const provider = config.settings.provider[providerId];
  if (!provider) return plainModelConfig(config, rawModel);

  // Same empty-string trap as `plainModelConfig`: an unset BOOK_API_KEY is `''`,
  // which is defined, so a presence test would prefer it over a real key.
  const fallbackApiKey = config.defaultApiKey || config.apiKey;
  const apiKey = resolveSecret(provider.apiKey, config.workspace) ?? fallbackApiKey;
  return {
    ...config,
    apiKey,
    baseUrl: provider.baseURL ?? provider.baseUrl ?? config.defaultBaseUrl ?? config.baseUrl,
    model,
    modelSelection: rawModel,
    modelInfo: provider.models[model],
    provider: provider.type,
  };
}

/**
 * Clamp an effort down to the highest level the model's catalog lists at or
 * below it. A catalog that disables effort gets none. A catalog entry without a
 * `levels` list, and a model without a catalog entry, keep the effort as asked;
 * an empty `levels` list exposes no choices, and gets none. When the catalog
 * lists no level at or below it, a defaulted effort gets none -- an unlisted
 * level is a 400 on a strict endpoint, and the clamp never goes back up -- while
 * `raiseToLowest` (a level someone chose) takes the lowest listed level instead,
 * the nearest the model offers to what was asked.
 */
export function clampEffortToCatalog(
  config: Pick<AgentConfig, 'model' | 'modelSelection' | 'modelInfo'>,
  effort: AgentConfig['effort'],
  options: { raiseToLowest?: boolean } = {},
): AgentConfig['effort'] {
  const levels = getAvailableEffortLevels(config);
  if (levels === null || effort === undefined) return undefined;
  const ceiling = EFFORT_LEVELS.indexOf(effort);
  const clamped = levels.filter((level) => EFFORT_LEVELS.indexOf(level) <= ceiling).at(-1);
  return clamped ?? (options.raiseToLowest ? levels[0] : undefined);
}

/**
 * The effort of a request on the compact model. A checkpoint does not need
 * minutes of reasoning, and at `--effort max` on a slow route the reducer's
 * request produced no byte for long enough that the proxy dropped it, ten times
 * over (#214). Memory extraction answers inside a 4,000-token output limit,
 * which a reply at `max` can spend on reasoning alone. The target is
 * `compactEffort`, or else the session's effort capped at `medium`, clamped to
 * the compact model's catalog: it never falls back to the uncapped session effort.
 */
function compactModelEffort(config: AgentConfig): AgentConfig['effort'] {
  const cap = EFFORT_LEVELS.indexOf('medium');
  const target =
    config.compactEffort ??
    (config.effort && EFFORT_LEVELS.indexOf(config.effort) > cap ? 'medium' : config.effort);
  // An explicit `compactEffort` is a choice for this model: below every listed level it takes the
  // lowest one. The session's capped effort never goes back up.
  return clampEffortToCatalog(config, target, {
    raiseToLowest: config.compactEffort !== undefined,
  });
}

/**
 * Whether a request sends its effort: the `effortExplicit` flag, which is what
 * makes the OpenAI-compatible path send `reasoning_effort`. A strict endpoint
 * answers an effort for a model that does not reason with a 400 that is not
 * retried, so a request sends one only when a level was chosen for it, or when
 * its model's catalog lists that level. With neither -- the default `gpt-4o`, or
 * any model without a catalog entry -- it carries none, like the main agent's.
 * Every request on the compact model, and every managed child, decides by this
 * one rule. A catalog entry without a `levels` list vouches for the level it
 * names as its `default`, and only that one.
 */
export function resolveEffortExplicit(
  config: Pick<AgentConfig, 'modelInfo'>,
  effort: AgentConfig['effort'],
  chosen: boolean,
): boolean {
  if (effort === undefined) return false;
  if (chosen) return true;
  const catalog = config.modelInfo?.effort;
  if (typeof catalog !== 'object') return false;
  return catalog.levels ? catalog.levels.includes(effort) : catalog.default === effort;
}

/**
 * The compact model's config, for every request made on it: the compaction
 * reducer, the deferred-compaction judge and memory extraction. It is routed to
 * `compactModel` when one is set, without changing the active agent model, and
 * carries the capped, catalog-clamped effort of `compactModelEffort`. It keeps
 * the session's retry policy; the reducer and the judge add their retry caps
 * through `resolveReducerModelConfig`.
 */
export function resolveCompactModelConfig(config: AgentConfig): AgentConfig {
  const compactModel = config.compactModel?.trim() || config.settings.compactModel?.trim();
  const resolved =
    !compactModel || compactModel === config.modelSelection || compactModel === config.model
      ? config
      : applyModelDefaults(resolveModelProviderConfig(config, compactModel));
  const effort = compactModelEffort(resolved);
  // A level was chosen by `compactEffort` or for the session. A level a managed child's catalog
  // merely listed is sent to the child's model, but is not a choice the compact model inherits.
  const chosen = resolved.compactEffort !== undefined || isEffortChosen(resolved);
  return {
    ...resolved,
    effort,
    effortChosen: chosen,
    effortExplicit: resolveEffortExplicit(resolved, effort, chosen),
  };
}

/**
 * The reducer's and the judge's config: the compact model's, retried at most
 * twice with the watchdog off. Both fall back when the model path fails -- the
 * reducer to the deterministic checkpoint, the judge to an inconclusive verdict
 * that commits the checkpoint anyway -- so more attempts only delay that. Memory
 * extraction keeps the session's retry policy: it gives up on a session after
 * three failed starts, and the cap made that happen sooner on a flaky route.
 */
export function resolveReducerModelConfig(config: AgentConfig): AgentConfig {
  const resolved = resolveCompactModelConfig(config);
  return {
    ...resolved,
    // A reducer request that dies before its first byte twice is not going to succeed
    // at that size, and runCompaction already falls back to the deterministic
    // checkpoint when the model path fails — ten attempts at five minutes each only
    // delayed that fallback. The watchdog retries 429/529 without limit, which
    // would lift this cap, so it is off for the reducer.
    retry: {
      ...resolved.retry,
      maxAttempts: Math.min(resolved.retry.maxAttempts, 2),
      watchdog: false,
    },
  };
}

export function resolveSecret(raw: string | undefined, workspace: string): string | undefined {
  if (!raw) return undefined;
  const envMatch = raw.match(/^\{env:([^}]+)\}$/);
  if (envMatch) return process.env[envMatch[1]];

  const fileMatch = raw.match(/^\{file:([^}]+)\}$/);
  if (!fileMatch) return raw;

  const p = fileMatch[1];
  let path: string;
  if (p.startsWith('~/')) {
    path = join(homedir(), p.slice(2));
  } else if (isAbsolute(p)) {
    path = p;
  } else {
    const root = resolve(workspace);
    path = resolve(root, p);
    const rel = relative(root, path);
    if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  }

  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return undefined;
  }
}

function validateEffort(raw: string | undefined): AgentConfig['effort'] {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return isEffortLevel(normalized) ? normalized : undefined;
}

const VALID_PROVIDERS = new Set(['anthropic', 'openai', 'auto']);

function validateProvider(raw: string | undefined): AgentConfig['provider'] {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return VALID_PROVIDERS.has(normalized) ? (normalized as AgentConfig['provider']) : undefined;
}

function clampInt(raw: string, min: number, max: number): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function parsePositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}
