export type TuiRendererMode = 'safe' | 'incremental' | 'experimental-scroll';

interface TuiRendererContext {
  isTTY?: boolean;
  screenReader?: boolean;
  incrementalRendererPatched?: boolean;
  platform?: NodeJS.Platform;
}

export function resolveTuiRendererMode(
  value = process.env.BOOK_TUI_RENDERER,
  context: TuiRendererContext = {},
): TuiRendererMode {
  if (context.isTTY === false || context.screenReader) return 'safe';
  if (context.incrementalRendererPatched === false) return 'safe';
  if (value === 'incremental') return 'incremental';
  if (value === 'experimental-scroll') return 'experimental-scroll';
  if (value === undefined) return context.platform === 'win32' ? 'safe' : 'incremental';
  return 'safe';
}
