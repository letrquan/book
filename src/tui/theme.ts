import { createContext, useContext } from 'react';
import type { ThemeTokens } from '../types/theme.js';
import { DEFAULT_THEME } from '../types/theme.js';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

/** Quiet editorial dark theme. This is the same as DEFAULT_THEME. */
export const DARK_THEME: ThemeTokens = { ...DEFAULT_THEME };

/** Matched editorial palette for terminals with light backgrounds. */
/**
 * Warm editorial light palette. Mirrors DEFAULT_THEME role for role: the same
 * seven hues, darkened for a light background.
 */
export const LIGHT_THEME: ThemeTokens = {
  ...DEFAULT_THEME,
  brand: '#A45F48',
  brandShimmer: '#B87458',

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
  merged: '#4F7B71',

  promptBorder: '#7C8A76',
  planMode: '#805F6E',
  autoAccept: '#4F7746',
  bashBorder: '#94662B',

  modeDefault: '#7C8A76',
  modePlan: '#805F6E',
  modeAcceptEdits: '#4F7746',
  modeAuto: '#4F7B71',
  modeDontAsk: '#A54F44',
  modeBypass: '#94662B',

  usageMeter: '#4F7B71',
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
  mdCodeBorder: '#CFC7B9',
  mdCodeText: '#302E2A',
  mdCodeKeyword: '#805F6E',
  mdCodeString: '#4F7746',
  mdCodeComment: '#8A8378',
  mdCodeNumber: '#94662B',
  mdCodeFunction: '#4F7B71',
  mdCodeLineNumber: '#A79F91',
  mdInlineCodeBg: '#E4DED2',
  mdInlineCodeText: '#A45F48',
  mdHeadingH1: '#14130F',
  mdHeadingH2: '#23211D',
  mdHeading: '#5F5B51',
  mdBlockquoteBorder: '#A79F91',
  mdBlockquoteText: '#746F66',
  mdLink: '#4F7B71',
  mdListMarker: '#7C8A76',
  mdHr: '#CFC7B9',
  mdTableBorder: '#CFC7B9',
  mdThinkBg: '#EEE8DC',
  mdThinkBorder: '#CFC7B9',
  mdThinkText: '#746F66',
  mdTurnSeparator: '#C9C1B3',
  mdCheckboxChecked: '#4F7746',
  mdCheckboxUnchecked: '#928A7E',

  userBg: '#F3E7DE',
};

/**
 * Soothing pastel dark palette based on Catppuccin Mocha.
 * Medium contrast, soft pastels, reduced eye fatigue.
 */
export const CATPPUCCIN_THEME: ThemeTokens = {
  ...DEFAULT_THEME,
  brand: '#CBA6F7',
  brandShimmer: '#F5C2E7',

  text: '#CDD6F4',
  inverseText: '#11111B',
  inactive: '#6C7086',
  subtle: '#A6ADC8',
  suggestion: '#7F849C',
  permission: '#F9E2AF',
  remember: '#F5C2E7',

  surface: '#1E1E2E',
  surfaceActive: '#313244',
  border: '#45475A',
  selectionText: '#F5E0DC',
  userAccent: '#89B4FA',
  assistantAccent: '#B4BEFE',
  toolRail: '#585B70',

  success: '#A6E3A1',
  error: '#F38BA8',
  warning: '#F9E2AF',
  merged: '#94E2D5',

  promptBorder: '#89B4FA',
  planMode: '#F5C2E7',
  autoAccept: '#A6E3A1',
  bashBorder: '#FAB387',

  modeDefault: '#89B4FA',
  modePlan: '#F5C2E7',
  modeAcceptEdits: '#A6E3A1',
  modeAuto: '#94E2D5',
  modeDontAsk: '#F38BA8',
  modeBypass: '#FAB387',

  diffAdded: '#23342E',
  diffRemoved: '#3B2430',
  diffAddedWord: '#315444',
  diffRemovedWord: '#5C2C40',
  diffAddedDimmed: '#1B2A24',
  diffRemovedDimmed: '#2D1D26',

  usageMeter: '#94E2D5',
  usageMeterHigh: '#FAB387',
  usageMeterCritical: '#F38BA8',

  shimmerPair: ['#B4BEFE', '#CBA6F7'],
  subagentColors: [
    '#F38BA8',
    '#FAB387',
    '#F9E2AF',
    '#A6E3A1',
    '#94E2D5',
    '#89B4FA',
    '#CBA6F7',
    '#F5C2E7',
  ],

  mdCodeBackground: '#181825',
  mdCodeBorder: '#313244',
  mdCodeText: '#CDD6F4',
  mdCodeKeyword: '#CBA6F7',
  mdCodeString: '#A6E3A1',
  mdCodeComment: '#6C7086',
  mdCodeNumber: '#FAB387',
  mdCodeFunction: '#89B4FA',
  mdCodeLineNumber: '#585B70',
  mdInlineCodeBg: '#313244',
  mdInlineCodeText: '#F5C2E7',
  mdHeadingH1: '#F5E0DC',
  mdHeadingH2: '#BAC2DE',
  mdHeading: '#A6ADC8',
  mdBlockquoteBorder: '#585B70',
  mdBlockquoteText: '#A6ADC8',
  mdLink: '#89DCEB',
  mdListMarker: '#89B4FA',
  mdHr: '#45475A',
  mdTableBorder: '#45475A',
  mdThinkBg: '#181825',
  mdThinkBorder: '#313244',
  mdThinkText: '#7F849C',
  mdTurnSeparator: '#45475A',
  mdCheckboxChecked: '#A6E3A1',
  mdCheckboxUnchecked: '#6C7086',

  userBg: '#24273A',
};

/**
 * Arctic and glacial slate palette based on Nord.
 * Low blue-light glare, tranquil cool tones.
 */
export const NORD_THEME: ThemeTokens = {
  ...DEFAULT_THEME,
  brand: '#88C0D0',
  brandShimmer: '#8FBCBB',

  text: '#D8DEE9',
  inverseText: '#2E3440',
  inactive: '#4C566A',
  subtle: '#9AA7BC',
  suggestion: '#616E88',
  permission: '#EBCB8B',
  remember: '#B48EAD',

  surface: '#2E3440',
  surfaceActive: '#3B4252',
  border: '#434C5E',
  selectionText: '#ECEFF4',
  userAccent: '#81A1C1',
  assistantAccent: '#8FBCBB',
  toolRail: '#4C566A',

  success: '#A3BE8C',
  error: '#BF616A',
  warning: '#EBCB8B',
  merged: '#88C0D0',

  promptBorder: '#81A1C1',
  planMode: '#B48EAD',
  autoAccept: '#A3BE8C',
  bashBorder: '#D08770',

  modeDefault: '#5E81AC',
  modePlan: '#B48EAD',
  modeAcceptEdits: '#A3BE8C',
  modeAuto: '#8FBCBB',
  modeDontAsk: '#BF616A',
  modeBypass: '#D08770',

  diffAdded: '#2A3B35',
  diffRemoved: '#3D2930',
  diffAddedWord: '#385648',
  diffRemovedWord: '#5E353F',
  diffAddedDimmed: '#23302B',
  diffRemovedDimmed: '#312127',

  usageMeter: '#81A1C1',
  usageMeterHigh: '#EBCB8B',
  usageMeterCritical: '#BF616A',

  shimmerPair: ['#88C0D0', '#8FBCBB'],
  subagentColors: [
    '#BF616A',
    '#D08770',
    '#EBCB8B',
    '#A3BE8C',
    '#8FBCBB',
    '#88C0D0',
    '#81A1C1',
    '#B48EAD',
  ],

  mdCodeBackground: '#242933',
  mdCodeBorder: '#3B4252',
  mdCodeText: '#D8DEE9',
  mdCodeKeyword: '#81A1C1',
  mdCodeString: '#A3BE8C',
  mdCodeComment: '#616E88',
  mdCodeNumber: '#B48EAD',
  mdCodeFunction: '#88C0D0',
  mdCodeLineNumber: '#4C566A',
  mdInlineCodeBg: '#3B4252',
  mdInlineCodeText: '#88C0D0',
  mdHeadingH1: '#ECEFF4',
  mdHeadingH2: '#E5E9F0',
  mdHeading: '#9AA7BC',
  mdBlockquoteBorder: '#4C566A',
  mdBlockquoteText: '#9AA7BC',
  mdLink: '#81A1C1',
  mdListMarker: '#88C0D0',
  mdHr: '#434C5E',
  mdTableBorder: '#434C5E',
  mdThinkBg: '#242933',
  mdThinkBorder: '#3B4252',
  mdThinkText: '#616E88',
  mdTurnSeparator: '#434C5E',
  mdCheckboxChecked: '#A3BE8C',
  mdCheckboxUnchecked: '#4C566A',

  userBg: '#353C4A',
};

/**
 * Warm earthy dark palette based on Gruvbox Dark.
 * Reduced blue light, high legibility, warm tones.
 */
export const GRUVBOX_THEME: ThemeTokens = {
  ...DEFAULT_THEME,
  brand: '#FE8019',
  brandShimmer: '#FABD2F',

  text: '#EBDBB2',
  inverseText: '#282828',
  inactive: '#7C6F64',
  subtle: '#A89984',
  suggestion: '#928374',
  permission: '#FABD2F',
  remember: '#D3869B',

  surface: '#282828',
  surfaceActive: '#3C3836',
  border: '#504945',
  selectionText: '#FBF1C7',
  userAccent: '#FE8019',
  assistantAccent: '#8EC07C',
  toolRail: '#665C54',

  success: '#B8BB26',
  error: '#FB4934',
  warning: '#FABD2F',
  merged: '#83A598',

  promptBorder: '#83A598',
  planMode: '#D3869B',
  autoAccept: '#B8BB26',
  bashBorder: '#FABD2F',

  modeDefault: '#689D6A',
  modePlan: '#D3869B',
  modeAcceptEdits: '#B8BB26',
  modeAuto: '#8EC07C',
  modeDontAsk: '#FB4934',
  modeBypass: '#FE8019',

  diffAdded: '#2B3322',
  diffRemoved: '#3B2320',
  diffAddedWord: '#3E522C',
  diffRemovedWord: '#5C2B25',
  diffAddedDimmed: '#23291C',
  diffRemovedDimmed: '#2E1C1A',

  usageMeter: '#83A598',
  usageMeterHigh: '#FABD2F',
  usageMeterCritical: '#FB4934',

  shimmerPair: ['#8EC07C', '#B8BB26'],
  subagentColors: [
    '#FB4934',
    '#FE8019',
    '#FABD2F',
    '#B8BB26',
    '#8EC07C',
    '#83A598',
    '#D3869B',
    '#D5C4A1',
  ],

  mdCodeBackground: '#1D2021',
  mdCodeBorder: '#3C3836',
  mdCodeText: '#EBDBB2',
  mdCodeKeyword: '#FB4934',
  mdCodeString: '#B8BB26',
  mdCodeComment: '#928374',
  mdCodeNumber: '#D3869B',
  mdCodeFunction: '#8EC07C',
  mdCodeLineNumber: '#665C54',
  mdInlineCodeBg: '#3C3836',
  mdInlineCodeText: '#FE8019',
  mdHeadingH1: '#FBF1C7',
  mdHeadingH2: '#F2E5BC',
  mdHeading: '#D5C4A1',
  mdBlockquoteBorder: '#665C54',
  mdBlockquoteText: '#A89984',
  mdLink: '#83A598',
  mdListMarker: '#FE8019',
  mdHr: '#504945',
  mdTableBorder: '#504945',
  mdThinkBg: '#1D2021',
  mdThinkBorder: '#3C3836',
  mdThinkText: '#928374',
  mdTurnSeparator: '#504945',
  mdCheckboxChecked: '#B8BB26',
  mdCheckboxUnchecked: '#7C6F64',

  userBg: '#32302F',
};

/**
 * Scientifically tuned low-contrast dark palette based on Solarized Dark.
 * Engineered Lab color space contrast for zero eye fatigue.
 */
export const SOLARIZED_DARK_THEME: ThemeTokens = {
  ...DEFAULT_THEME,
  brand: '#268BD2',
  brandShimmer: '#2AA198',

  text: '#839496',
  inverseText: '#002B36',
  inactive: '#586E75',
  subtle: '#657B83',
  suggestion: '#586E75',
  permission: '#B58900',
  remember: '#D33682',

  surface: '#002B36',
  surfaceActive: '#073642',
  border: '#0E4B5B',
  selectionText: '#FDF6E3',
  userAccent: '#268BD2',
  assistantAccent: '#2AA198',
  toolRail: '#586E75',

  success: '#859900',
  error: '#DC322F',
  warning: '#B58900',
  merged: '#2AA198',

  promptBorder: '#268BD2',
  planMode: '#D33682',
  autoAccept: '#859900',
  bashBorder: '#CB4B16',

  modeDefault: '#586E75',
  modePlan: '#D33682',
  modeAcceptEdits: '#859900',
  modeAuto: '#2AA198',
  modeDontAsk: '#DC322F',
  modeBypass: '#CB4B16',

  diffAdded: '#0A3326',
  diffRemoved: '#36191E',
  diffAddedWord: '#134F3A',
  diffRemovedWord: '#54222A',
  diffAddedDimmed: '#08291F',
  diffRemovedDimmed: '#2B1418',

  usageMeter: '#2AA198',
  usageMeterHigh: '#B58900',
  usageMeterCritical: '#DC322F',

  shimmerPair: ['#2AA198', '#859900'],
  subagentColors: [
    '#DC322F',
    '#CB4B16',
    '#B58900',
    '#859900',
    '#2AA198',
    '#268BD2',
    '#6C71C4',
    '#D33682',
  ],

  mdCodeBackground: '#00212B',
  mdCodeBorder: '#073642',
  mdCodeText: '#839496',
  mdCodeKeyword: '#859900',
  mdCodeString: '#2AA198',
  mdCodeComment: '#586E75',
  mdCodeNumber: '#D33682',
  mdCodeFunction: '#268BD2',
  mdCodeLineNumber: '#586E75',
  mdInlineCodeBg: '#073642',
  mdInlineCodeText: '#2AA198',
  mdHeadingH1: '#FDF6E3',
  mdHeadingH2: '#EEE8D5',
  mdHeading: '#93A1A1',
  mdBlockquoteBorder: '#586E75',
  mdBlockquoteText: '#657B83',
  mdLink: '#6C71C4',
  mdListMarker: '#2AA198',
  mdHr: '#073642',
  mdTableBorder: '#073642',
  mdThinkBg: '#00212B',
  mdThinkBorder: '#073642',
  mdThinkText: '#586E75',
  mdTurnSeparator: '#073642',
  mdCheckboxChecked: '#859900',
  mdCheckboxUnchecked: '#586E75',

  userBg: '#073642',
};

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

/** Detect whether COLORFGBG reports a light terminal background. */
export function hasLightTerminalBackground(colorFgBg = process.env.COLORFGBG ?? ''): boolean {
  const background = Number(colorFgBg.split(';').at(-1));
  return background === 7 || background === 15;
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

/** Resolve a built-in, automatic, or project theme preference into tokens. */
export function resolveTheme(
  workspace: string,
  preference: string,
  colorFgBg = process.env.COLORFGBG ?? '',
): ResolvedTheme | null {
  const requested = preference.trim();
  const builtin = requested.toLowerCase();
  if (builtin === 'dark') {
    return { preference: 'dark', resolvedName: 'dark', tokens: DARK_THEME };
  }
  if (builtin === 'light') {
    return { preference: 'light', resolvedName: 'light', tokens: LIGHT_THEME };
  }
  if (builtin === 'auto') {
    const isLight = hasLightTerminalBackground(colorFgBg);
    return {
      preference: 'auto',
      resolvedName: isLight ? 'light' : 'dark',
      tokens: isLight ? LIGHT_THEME : DARK_THEME,
    };
  }
  if (builtin === 'catppuccin' || builtin === 'catppuccin-mocha' || builtin === 'mocha') {
    return { preference: 'catppuccin', resolvedName: 'catppuccin', tokens: CATPPUCCIN_THEME };
  }
  if (builtin === 'nord') {
    return { preference: 'nord', resolvedName: 'nord', tokens: NORD_THEME };
  }
  if (builtin === 'gruvbox' || builtin === 'gruvbox-dark') {
    return { preference: 'gruvbox', resolvedName: 'gruvbox', tokens: GRUVBOX_THEME };
  }
  if (builtin === 'solarized-dark' || builtin === 'solarized') {
    return {
      preference: 'solarized-dark',
      resolvedName: 'solarized-dark',
      tokens: SOLARIZED_DARK_THEME,
    };
  }
  if (!requested) return null;
  const custom = loadCustomTheme(workspace, requested);
  return custom ? { preference: requested, resolvedName: requested, tokens: custom } : null;
}

export { DEFAULT_THEME };
export type { ThemeTokens };
