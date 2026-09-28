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

/**
 * The frame cap handed to Ink's `render({ maxFps })`. Ink throttles renders to
 * `ceil(1000 / maxFps)` ms, and on Windows libuv timers fire only on the 15.6 ms system tick:
 * the 17 ms that 60 fps asks for waits two ticks (31 ms) and caps the TUI at about 32 fps, so a
 * transcript scrolled with the wheel or a trackpad moves in visible steps. 72 fps asks for
 * 14 ms, which one tick serves. Elsewhere timers are precise and 60 fps means 60.
 */
export function resolveInkMaxFps(platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? 72 : 60;
}
