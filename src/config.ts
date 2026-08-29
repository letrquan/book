import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';
import { homedir } from 'os';
import type { AgentConfig, RetryConfig } from './types/runtime.js';
import { resolveSettings, migrateLegacyPermissions } from './settings-loader.js';
import { DEFAULT_SETTINGS, type CompactStrategy } from './settings.js';
import { loadMemoryContext } from './memory-store.js';
import { assertHarnessModeAvailable, assertSelectableWorkflow } from './harness/coordinator.js';

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
  /** Run storage migrations after the effective settings and harness mode are validated. */
  runMigrations?: boolean;
  /** CLI -m/--model override, applied before provider registry resolution. */
  modelOverride?: string;
  /** Let the interactive TUI start before a BYOK credential has been added. */
  allowMissingApiKey?: boolean;
}

export function loadConfig(workspace?: string, options?: LoadConfigOptions): AgentConfig {
  const settingsOverridePath = options?.settingsOverridePath;
  const noSettings = options?.noSettings ?? false;
  const resolvedWorkspace = workspace || process.env.BOOK_WORKSPACE || process.cwd();

  // Resolve layered settings.json from user/project/local scopes, or skip
  // entirely when --no-settings is set (useful for scripted/isolated runs).
  let settings = noSettings
    ? structuredClone(DEFAULT_SETTINGS)
    : resolveSettings(resolvedWorkspace, settingsOverridePath);
  assertHarnessModeAvailable(settings.harness.mode);
  assertSelectableWorkflow(settings.harness.mode, settings.harness.workflow);

  if (!noSettings && options?.runMigrations) {
    const migrated = migrateLegacyPermissions(resolvedWorkspace, undefined, settings);
    if (migrated) settings = resolveSettings(resolvedWorkspace, settingsOverridePath);
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
  const effortExplicit = Boolean(process.env.BOOK_EFFORT || settings.effort);
  const rawModel =
    options?.modelOverride || process.env.BOOK_MODEL || settings.model || legacy?.model || 'gpt-4o';
  const compactModel = process.env.BOOK_COMPACT_MODEL || settings.compactModel;
  validateLegacyCompactStrategy(process.env.BOOK_COMPACT_STRATEGY);
  const experimentalZeroMem =
    process.env.BOOK_EXPERIMENTAL_ZERO_MEM === undefined
      ? settings.experimental.zeroMem
      : parseExperimentalZeroMem(process.env.BOOK_EXPERIMENTAL_ZERO_MEM);
  settings = {
    ...settings,
    experimental: { ...settings.experimental, zeroMem: experimentalZeroMem },
  };
  const compactStrategy: CompactStrategy = 'summary';
  const defaultApiKey = process.env.BOOK_API_KEY || '';
  const defaultBaseUrl = process.env.BOOK_BASE_URL || legacy?.baseUrl || DEFAULT_OPENAI_BASE_URL;
  const defaultMaxTokens =
    envMaxTokens ?? settings.maxTokens ?? legacy?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const defaultEffort = validateEffort(process.env.BOOK_EFFORT) || settings.effort || 'high';
  const defaultProvider = validateProvider(process.env.BOOK_PROVIDER) || 'auto';

  let config: AgentConfig = {
    apiKey: defaultApiKey,
    baseUrl: defaultBaseUrl,
    model: rawModel,
    modelSelection: rawModel,
    compactModel,
    compactStrategy,
    experimentalZeroMem,
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
    settingsContext: {
      overridePath: settingsOverridePath,
      noSettings,
    },
    retry,
    memoryContext,
    effort: defaultEffort,
    provider: defaultProvider,
  };

  config = applyModelDefaults(resolveModelProviderConfig(config, rawModel));

  if (!config.apiKey && !options?.allowMissingApiKey) {
    throw new Error(
      'BOOK_API_KEY or provider.<id>.apiKey not set. Set BOOK_API_KEY or use {env:VAR} in settings.',
    );
  }

  return config;
}

function plainModelConfig(config: AgentConfig, model: string): AgentConfig {
  return {
    ...config,
    apiKey: config.defaultApiKey ?? config.apiKey,
    baseUrl: config.defaultBaseUrl ?? config.baseUrl,
    model,
    modelSelection: model,
    modelInfo: undefined,
    provider: config.defaultProvider ?? config.provider,
  };
}

export function applyModelDefaults(config: AgentConfig): AgentConfig {
  const maxTokens = config.maxTokensExplicit
    ? config.maxTokens
    : (config.modelInfo?.maxOutputTokens ?? config.defaultMaxTokens ?? config.maxTokens);

  let effort = config.effort;
  if (!config.effortExplicit) {
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

  const fallbackApiKey = config.defaultApiKey !== undefined ? config.defaultApiKey : config.apiKey;
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

/** Resolve the optional reducer model without changing the active agent model. */
export function resolveCompactModelConfig(config: AgentConfig): AgentConfig {
  const compactModel = config.compactModel?.trim() || config.settings.compactModel?.trim();
  if (!compactModel || compactModel === config.modelSelection || compactModel === config.model) {
    return config;
  }
  return applyModelDefaults(resolveModelProviderConfig(config, compactModel));
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

const VALID_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function validateEffort(raw: string | undefined): AgentConfig['effort'] {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return VALID_EFFORT_LEVELS.has(normalized) ? (normalized as AgentConfig['effort']) : undefined;
}

const VALID_PROVIDERS = new Set(['anthropic', 'openai', 'auto']);

function validateProvider(raw: string | undefined): AgentConfig['provider'] {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return VALID_PROVIDERS.has(normalized) ? (normalized as AgentConfig['provider']) : undefined;
}

function validateLegacyCompactStrategy(raw: string | undefined): void {
  if (raw === undefined) return;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'summary') return;
  if (normalized === 'zero-mem') {
    throw new Error(
      'BOOK_COMPACT_STRATEGY=zero-mem is no longer supported. Set ' +
        'BOOK_EXPERIMENTAL_ZERO_MEM=true to enable the experimental Zero-Mem runtime.',
    );
  }
  throw new Error('BOOK_COMPACT_STRATEGY is deprecated and, when present, must be "summary"');
}

function parseExperimentalZeroMem(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error('BOOK_EXPERIMENTAL_ZERO_MEM must be "true" or "false"');
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
