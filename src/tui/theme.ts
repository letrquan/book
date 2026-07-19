import { createContext, useContext } from 'react';
import type { ThemeTokens } from '../types.js';
import { DEFAULT_THEME } from '../types.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/** Quiet editorial dark theme. This is the same as DEFAULT_THEME. */
export const DARK_THEME: ThemeTokens = { ...DEFAULT_THEME };

/** Matched editorial palette for terminals with light backgrounds. */
export const LIGHT_THEME: ThemeTokens = {
  ...DEFAULT_THEME,
  brand: '#607257',
  brandShimmer: '#75886A',
  text: '#302E2A',
  inverseText: '#FBF7EE',
  inactive: '#928A7E',
  subtle: '#746F66',
  suggestion: '#8A8378',
  permission: '#94662B',
  remember: '#805F6E',

  surface: '#EEE8DC',
  surfaceActive: '#DDE6D6',
  border: '#C9C1B3',
  selectionText: '#293126',
  userAccent: '#A45F48',
  assistantAccent: '#607257',
  toolRail: '#A79F91',

  success: '#4F7746',
  error: '#A54F44',
  warning: '#94662B',
  merged: '#4F7746',

  promptBorder: '#607257',
  planMode: '#805F6E',
  autoAccept: '#4F7746',
  bashBorder: '#94662B',

  modeDefault: '#607257',
  modePlan: '#805F6E',
  modeAcceptEdits: '#4F7746',
  modeAuto: '#4F7B71',
  modeDontAsk: '#A54F44',
  modeBypass: '#94662B',

  usageMeter: '#607257',
  usageMeterHigh: '#94662B',
  usageMeterCritical: '#A54F44',
  diffAdded: '#DFECDC',
  diffRemoved: '#F1DDDA',
  diffAddedWord: '#BFD8BD',
  diffRemovedWord: '#E6BFBA',
  diffAddedDimmed: '#EAF3E9',
  diffRemovedDimmed: '#F7E9E7',
  shimmerPair: ['#607257', '#75886A'],
  subagentColors: [
    '#A54F44',
    '#4F7B71',
    '#4F7746',
    '#94662B',
    '#805F6E',
    '#A45F48',
    '#8D6277',
    '#607257',
  ],

  mdCodeBackground: '#E7E2D8',
  mdCodeBorder: '#C9C1B3',
  mdCodeText: '#302E2A',
  mdCodeKeyword: '#805F6E',
  mdCodeString: '#4F7746',
  mdCodeComment: '#746F66',
  mdCodeNumber: '#94662B',
  mdCodeFunction: '#607257',
  mdCodeLineNumber: '#928A7E',
  mdInlineCodeBg: '#E4DED2',
  mdInlineCodeText: '#A45F48',
  mdHeading: '#302E2A',
  mdHeadingH1: '#607257',
  mdHeadingH2: '#75886A',
  mdBlockquoteBorder: '#A79F91',
  mdBlockquoteText: '#746F66',
  mdLink: '#607257',
  mdListMarker: '#A45F48',
  mdHr: '#C9C1B3',
  mdTableBorder: '#C9C1B3',
  mdThinkBg: '#EEE8DC',
  mdThinkBorder: '#C9C1B3',
  mdThinkText: '#746F66',
  mdTurnSeparator: '#A79F91',
  mdCheckboxChecked: '#4F7746',
  mdCheckboxUnchecked: '#928A7E',

  userBg: '#F1E2D8',
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
