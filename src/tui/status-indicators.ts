/**
 * Shared status glyphs and colour tokens for the agent's steps and the task list.
 *
 * Every glyph here is East Asian **Neutral**, so every terminal draws it one cell
 * wide. An Ambiguous glyph (`○`, and also `·` and `•`) is drawn two cells wide by
 * some terminals, which swallows the space behind it and lands the row's text a
 * column off the grid. Each is also in the common coding fonts (JetBrains Mono,
 * Cascadia): a glyph the font lacks comes from a fallback font, often as a colour
 * emoji wider than its cell, which is how `✎` failed.
 *
 * The set reads as a circle being filled: `◌` a step not yet begun, `◔` the one
 * in hand, `✓` the ones finished. Only the step in hand takes the rubric. A
 * finished step takes the same grey `✓` as a finished tool row, because success
 * is the default: colour is what a failure or a pending prompt spends, and a
 * check that is merely done has nothing to report.
 */
export const STATUS_INDICATORS = {
  pending: { icon: '◌' as const, colorToken: 'inactive' as const },
  in_progress: { icon: '◔' as const, colorToken: 'brand' as const },
  completed: { icon: '✓' as const, colorToken: 'inactive' as const },
};
