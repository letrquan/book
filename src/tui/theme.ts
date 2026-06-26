import { createContext, useContext } from 'react';
import type { ThemeTokens } from '../types.js';
import { DEFAULT_THEME } from '../types.js';

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

export { DEFAULT_THEME };
export type { ThemeTokens };