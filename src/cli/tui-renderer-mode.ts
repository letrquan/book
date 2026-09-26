export type TuiRendererMode = 'safe' | 'incremental' | 'experimental-scroll';

interface TuiRendererContext {
  isTTY?: boolean;
  screenReader?: boolean;
  incrementalRendererFixed?: boolean;
  platform?: NodeJS.Platform;
}

export function resolveTuiRendererMode(
  value = process.env.BOOK_TUI_RENDERER,
  context: TuiRendererContext = {},
): TuiRendererMode {
  if (context.isTTY === false || context.screenReader) return 'safe';
  if (context.incrementalRendererFixed === false) return 'safe';
  if (value === 'incremental') return 'incremental';
  if (value === 'experimental-scroll') return 'experimental-scroll';
  if (value === undefined) return context.platform === 'win32' ? 'safe' : 'incremental';
  return 'safe';
}

/**
 * Ink 6 rendered live frames unless it detected CI; Ink 7 also requires a TTY stdout. Book runs its
 * TUI on a non-TTY stdout when a Windows build is launched from WSL, so it passes Ink 6's rule to
 * `render({ interactive })` itself. Same test as Ink's `is-in-ci`.
 */
export function isCiEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  const set = (key: string) => key in env && env[key] !== '0' && env[key] !== 'false';
  return set('CI') || set('CONTINUOUS_INTEGRATION');
}
