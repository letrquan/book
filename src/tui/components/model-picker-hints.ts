/**
 * What `/model` tells you it can do.
 *
 * The picker binds six Alt-chords. The footer used to be four hand-written
 * strings chosen by two booleans, and between them they left holes:
 *
 * - **`Alt+E` was advertised nowhere at all.** Setting a model's effort was
 *   reachable only by guessing, and the row it opens (`Effort [high] ← →
 *   adjust`) is only visible *after* you have already found the key.
 * - **`Alt+S` disappeared whenever a removable BYOK provider existed**, because
 *   that branch spent the line on `Alt+A` and `Alt+D` instead — so the chord
 *   that always works was hidden by the presence of one that sometimes does.
 *
 * Both came from writing the sentence out per case. This builds it from what is
 * actually available, so a chord cannot be advertised when it will not fire, and
 * cannot be dropped because a different one appeared.
 *
 * Two lines, split by what they act on: choosing a model, and managing the
 * catalog. That split is the reason it fits — six chords and the navigation keys
 * do not fit on one 80-column line, and a wrapped footer is what this replaces.
 */
export interface ModelPickerHintState {
  /** BYOK management is offered at all. */
  allowProviderManagement: boolean;
  /** Some provider in the list can be removed. */
  hasRemovableProviders: boolean;
  /** The selected row is a model that carries per-model effort. */
  canSetEffort: boolean;
  /** The selected row belongs to a provider the user owns. */
  editableProviderId?: string;
  /** Drop the descriptions, keep every chord. */
  compact: boolean;
  /** The list can be typed at. */
  filterable: boolean;
}

/** The footer, as one or two lines. Never empty; never missing a live chord. */
export function modelPickerHints(state: ModelPickerHintState): string[] {
  const { compact } = state;

  // Descriptions stay terse in both widths. The line this replaces was 81
  // columns and fit; spelling the chords out ("use for this session") pushes
  // past 100 and wraps, which is the defect. Compact drops the filter hint
  // rather than a chord — typing is discoverable by doing it, a chord is not.
  const choosing = [
    '↑↓ select',
    state.filterable && !compact ? 'type filter' : undefined,
    'Enter save',
    'Alt+S session',
    state.canSetEffort ? 'Alt+E effort' : undefined,
    'Esc cancel',
  ].filter(Boolean) as string[];

  const managing = state.allowProviderManagement
    ? ([
        compact ? 'Alt+A add' : 'Alt+A add BYOK',
        // "remove BYOK" survives compact: `Alt+D` is the one chord here that
        // deletes something, and "remove" alone does not say what.
        state.hasRemovableProviders ? 'Alt+D remove BYOK' : undefined,
        state.editableProviderId
          ? compact
            ? 'Alt+R refresh'
            : `Alt+R refresh ${state.editableProviderId}`
          : undefined,
        state.editableProviderId ? 'Alt+M add model' : undefined,
      ].filter(Boolean) as string[])
    : [];

  return managing.length > 0
    ? [choosing.join(' · '), managing.join(' · ')]
    : [choosing.join(' · ')];
}
