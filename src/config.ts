import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AgentConfig, RetryConfig } from './types.js';
import { resolveSettings, migrateLegacyPermissions } from './settings-loader.js';
import { DEFAULT_SETTINGS } from './settings.js';

/** Legacy .bookrc.json schema (v0.1.0 format, deprecated). */
const legacyConfigSchema = z.object({
  model: z.string().optional(),
  baseUrl: z.string().url().optional(),
  maxTurns: z.number().int().min(1).max(100).optional(),
  maxTokens: z.number().int().min(1000).optional(),
  autoCompactEnabled: z.boolean().optional(),
  animation: z.object({
    typewriterSpeed: z.number().int().min(1).max(50).default(3),
    spinnerStyle: z.enum(['braille', 'dots']).default('braille'),
  }).optional(),
  accessibility: z.object({
    screenReader: z.boolean().default(false),
    reducedMotion: z.boolean().default(false),
  }).optional(),
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
}

export function loadConfig(workspace?: string, options?: LoadConfigOptions): AgentConfig {
  const settingsOverridePath = options?.settingsOverridePath;
  const noSettings = options?.noSettings ?? false;

  const apiKey = process.env.BOOK_API_KEY;
  if (!apiKey) {
    throw new Error('BOOK_API_KEY not set. Set it via environment variable or .bookrc.json');
  }

  const baseUrl = process.env.BOOK_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.BOOK_MODEL || 'gpt-4o';
  const maxTurns = process.env.BOOK_MAX_TURNS ? parseInt(process.env.BOOK_MAX_TURNS, 10) : 25;
  const maxTokens = process.env.BOOK_MAX_TOKENS ? parseInt(process.env.BOOK_MAX_TOKENS, 10) : 128000;
  const resolvedWorkspace = workspace || process.env.BOOK_WORKSPACE || process.cwd();

  // Load legacy .bookrc.json (deprecated) for backward compat.
  const legacy = loadLegacyConfig(resolvedWorkspace);

  // Resolve layered settings.json from user/project/local scopes, or skip
  // entirely when --no-settings is set (useful for scripted/isolated runs).
  const settings = noSettings
    ? structuredClone(DEFAULT_SETTINGS)
    : resolveSettings(resolvedWorkspace, settingsOverridePath);

  // Migrate any legacy ~/.book/permissions.json rules into .book/settings.local.json.
  if (!noSettings) {
    migrateLegacyPermissions(resolvedWorkspace);
  }

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
    toolRetries: process.env.BOOK_TOOL_RETRIES
      ? clampInt(process.env.BOOK_TOOL_RETRIES, 0, 3)
      : (settings.retry?.toolRetries ?? DEFAULT_SETTINGS.retry.toolRetries),
    watchdog: process.env.BOOK_RETRY_WATCHDOG === '1'
      || settings.retry?.watchdog === true,
  };

  return {
    apiKey,
    baseUrl: process.env.BOOK_BASE_URL || legacy?.baseUrl || baseUrl,
    model: process.env.BOOK_MODEL || settings.model || legacy?.model || model,
    maxTurns: process.env.BOOK_MAX_TURNS
      ? parseInt(process.env.BOOK_MAX_TURNS, 10)
      : settings.maxTurns ?? legacy?.maxTurns ?? maxTurns,
    maxTokens: process.env.BOOK_MAX_TOKENS
      ? parseInt(process.env.BOOK_MAX_TOKENS, 10)
      : settings.maxTokens ?? legacy?.maxTokens ?? maxTokens,
    autoCompactEnabled:
      settings.autoCompactEnabled ?? legacy?.autoCompactEnabled ?? true,
    workspace: resolvedWorkspace,
    animation: legacy?.animation || { typewriterSpeed: 3, spinnerStyle: 'braille' },
    accessibility: legacy?.accessibility || { screenReader: false, reducedMotion: false },
    settings,
    retry,
  };
}

function clampInt(raw: string, min: number, max: number): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}
