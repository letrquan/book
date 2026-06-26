import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AgentConfig } from './types.js';
import { resolveSettings } from './settings-loader.js';
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

export function loadConfig(
  workspace?: string,
  settingsOverridePath?: string,
): AgentConfig {
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

  // Resolve layered settings.json from user/project/local scopes.
  const settings = resolveSettings(resolvedWorkspace, settingsOverridePath);

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
  };
}
