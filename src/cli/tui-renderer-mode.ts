export type TuiRendererMode = 'safe' | 'incremental' | 'experimental-scroll';

interface TuiRendererContext {
  isTTY?: boolean;
  screenReader?: boolean;
  incrementalRendererPatched?: boolean;
}

export function resolveTuiRendererMode(
  value = process.env.BOOK_TUI_RENDERER,
  context: TuiRendererContext = {},
): TuiRendererMode {
  if (context.isTTY === false || context.screenReader) return 'safe';
  if (context.incrementalRendererPatched === false) return 'safe';
  if (value === undefined) return 'incremental';
  if (value === 'incremental') return 'incremental';
  if (value === 'experimental-scroll') return 'experimental-scroll';
  return 'safe';
}
