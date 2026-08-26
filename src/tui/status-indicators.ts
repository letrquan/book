/**
 * Shared status glyphs and colour tokens for plan rows and task rows.
 *
 * The glyphs are chosen for *width* as much as for looks. `○` and `◉` are East
 * Asian **Ambiguous**: plenty of terminals draw them two cells wide even though
 * every width table the TUI consults calls them one. When that happens the
 * glyph swallows the space behind it, so the row's text lands a column left of
 * the transcript grid and butts straight against its own marker — the plan is
 * the one block in the transcript that visibly fails to line up.
 *
 * This set is the light vocabulary already proven elsewhere in the TUI: `✓` on
 * tool rows, `›` on managed-agent rows, `·` as the separator in every status
 * line. Each one renders one cell wide next to text.
 *
 * Colours keep the roles apart. Clay (`brand`) is product chrome and belongs to
 * the plan; sage stays with the spinner, which is the agent itself speaking.
 */
export const STATUS_INDICATORS = {
  pending: { icon: '·' as const, colorToken: 'inactive' as const },
  in_progress: { icon: '›' as const, colorToken: 'brand' as const },
  completed: { icon: '✓' as const, colorToken: 'success' as const },
};
