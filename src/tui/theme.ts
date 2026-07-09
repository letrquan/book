import { createContext, useContext } from 'react';
import type { ThemeTokens } from '../types.js';
import { DEFAULT_THEME } from '../types.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Dark theme — Claude Code default. White text on dark backgrounds.
 * This is the same as DEFAULT_THEME.
 */
export const DARK_THEME: ThemeTokens = { ...DEFAULT_THEME };

/**
 * Light theme — dark text on light backgrounds.
 * Inverts the color scheme for terminals with light backgrounds.
 */
export const LIGHT_THEME: ThemeTokens = {
  ...DEFAULT_THEME,
  text: 'black',
  inverseText: 'white',
  inactive: '#666',
  subtle: '#666',
  suggestion: '#888',
  brand: 'blue',
  brandShimmer: '#06c',
  promptBorder: 'blue',
  planMode: '#a0a',
  autoAccept: 'green',
  bashBorder: '#c90',
  usageMeter: 'blue',
  usageMeterHigh: '#c90',
  usageMeterCritical: 'red',
  diffAdded: 'green',
  diffRemoved: 'red',
  diffAddedWord: '#0a0',
  diffRemovedWord: '#e00',
  diffAddedDimmed: '#060',
  diffRemovedDimmed: '#900',
  shimmerPair: ['blue', '#06c'],
  success: 'green',
  error: 'red',
  warning: '#c90',

  mdCodeBackground: '#f0f0f0',
  mdCodeBorder: '#ccc',
  mdCodeText: '#333',
  mdCodeKeyword: '#7b2cbf',
  mdCodeString: '#2d6a4f',
  mdCodeComment: '#777',
  mdCodeNumber: '#b06000',
  mdCodeFunction: '#0066cc',
  mdCodeLineNumber: '#999',
  mdInlineCodeBg: '#e8e8e8',
  mdInlineCodeText: '#b06000',
  mdHeading: 'black',
  mdHeadingH1: 'blue',
  mdHeadingH2: '#064f8f',
  mdBlockquoteBorder: '#aaa',
  mdBlockquoteText: '#666',
  mdLink: 'blue',
  mdListMarker: '#888',
  mdHr: '#ccc',
  mdTableBorder: '#aaa',
  mdThinkBg: '#f6f6f6',
  mdThinkBorder: '#bbb',
  mdThinkText: '#666',
  mdTurnSeparator: '#bbb',
  mdCheckboxChecked: 'green',
  mdCheckboxUnchecked: '#888',

  userBg: '#e8e8e8',
};

/**
 * All built-in theme names.
 */
export type ThemeName = 'dark' | 'light' | 'auto';

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

/**
 * Try to load a custom theme from .book/themes/<name>.json.
 * Returns the loaded theme tokens, or null if not found.
 */
export function loadCustomTheme(workspace: string, name: string): ThemeTokens | null {
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

export { DEFAULT_THEME };
export type { ThemeTokens };