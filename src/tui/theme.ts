import { createContext, useContext } from 'react';
import type { ThemeTokens } from '../types/theme.js';
import { DEFAULT_THEME } from '../types/theme.js';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Apple-inspired default palette: near-black neutral surfaces, bright grey
 * text, and one blue action accent. Every other hue is a system colour that
 * appears only when a state needs attention, so ordinary chrome never competes
 * with the work.
 */
export const APPLE_THEME: ThemeTokens = { ...DEFAULT_THEME };

export interface ResolvedTheme {
  preference: string;
  resolvedName: string;
  tokens: ThemeTokens;
}

const CUSTOM_THEME_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * React context for theme tokens.
 * Components that render colors read from this instead of hardcoded strings,
 * so custom themes can override the palette globally.
 */
export const ThemeContext = createContext<ThemeTokens>(DEFAULT_THEME);

/**
 * Hook to access the current theme tokens.
 */
export function useTheme(): ThemeTokens {
  return useContext(ThemeContext);
}

/** List safe custom theme names from .book/themes. */
export function listCustomThemes(workspace: string): string[] {
  const themesDir = join(workspace, '.book', 'themes');
  try {
    return readdirSync(themesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -'.json'.length))
      .filter((name) => CUSTOM_THEME_NAME.test(name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * Try to load a custom theme from .book/themes/<name>.json.
 * Returns the loaded theme tokens, or null if not found.
 */
export function loadCustomTheme(workspace: string, name: string): ThemeTokens | null {
  if (!CUSTOM_THEME_NAME.test(name)) return null;
  const themePath = join(workspace, '.book', 'themes', `${name}.json`);
  if (!existsSync(themePath)) return null;
  try {
    const raw = readFileSync(themePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ThemeTokens>;
    return { ...DEFAULT_THEME, ...parsed };
  } catch {
    return null;
  }
}

/** Resolve a theme preference into tokens. */
export function resolveTheme(workspace: string, preference: string): ResolvedTheme | null {
  const requested = preference.trim();
  const builtin = requested.toLowerCase();
  if (builtin === 'apple' || builtin === 'apple-dark') {
    return { preference: 'apple', resolvedName: 'apple', tokens: APPLE_THEME };
  }
  if (!requested) return null;
  const custom = loadCustomTheme(workspace, requested);
  return custom ? { preference: requested, resolvedName: requested, tokens: custom } : null;
}

export { DEFAULT_THEME };
export type { ThemeTokens };
