import { describe, expect, it } from 'vitest';
import { modelPickerHints, type ModelPickerHintState } from './model-picker-hints.js';

function state(overrides: Partial<ModelPickerHintState> = {}): ModelPickerHintState {
  return {
    allowProviderManagement: true,
    hasRemovableProviders: false,
    canSetEffort: false,
    compact: false,
    filterable: true,
    ...overrides,
  };
}

/** Every chord the picker binds, and the state that makes it fire. */
const CHORDS = ['Alt+S', 'Alt+E', 'Alt+A', 'Alt+D', 'Alt+R', 'Alt+M'] as const;

describe('modelPickerHints', () => {
  it('advertises every chord that is live, in the fullest state', () => {
    const text = modelPickerHints(
      state({ hasRemovableProviders: true, canSetEffort: true, editableProviderId: 'gateway' }),
    ).join(' | ');

    for (const key of CHORDS) expect(text).toContain(key);
  });

  it('advertises Alt+E, which the old footer never mentioned anywhere', () => {
    // Setting a model's effort was reachable only by guessing: the row it opens
    // is visible after you press the key, never before.
    expect(modelPickerHints(state({ canSetEffort: true })).join(' ')).toContain('Alt+E');
    expect(modelPickerHints(state({ canSetEffort: false })).join(' ')).not.toContain('Alt+E');
  });

  it('keeps Alt+S when a removable provider exists', () => {
    // The old footer spent that line on Alt+A and Alt+D instead, so the chord
    // that always works vanished whenever one that sometimes works appeared.
    const text = modelPickerHints(state({ hasRemovableProviders: true })).join(' ');
    expect(text).toContain('Alt+S');
    expect(text).toContain('Alt+D');
  });

  it('never advertises a chord that would not fire', () => {
    const plain = modelPickerHints(state({ allowProviderManagement: false })).join(' ');
    expect(plain).toContain('Alt+S');
    for (const key of ['Alt+A', 'Alt+D', 'Alt+R', 'Alt+M']) expect(plain).not.toContain(key);

    const noRow = modelPickerHints(state({ editableProviderId: undefined })).join(' ');
    expect(noRow).not.toContain('Alt+R');
    expect(noRow).not.toContain('Alt+M');
  });

  it('drops descriptions rather than chords when compact', () => {
    const full = state({
      hasRemovableProviders: true,
      canSetEffort: true,
      editableProviderId: 'g',
    });
    const wide = modelPickerHints(full);
    const narrow = modelPickerHints({ ...full, compact: true });

    for (const key of CHORDS) expect(narrow.join(' ')).toContain(key);
    expect(narrow.join(' ').length).toBeLessThan(wide.join(' ').length);
  });

  it('splits into two lines only when there is catalog management to show', () => {
    expect(modelPickerHints(state({ allowProviderManagement: false }))).toHaveLength(1);
    expect(modelPickerHints(state())).toHaveLength(2);
  });

  it('keeps every line inside the width the old footer fit in', () => {
    // A wrapped footer is the defect being fixed, so the budget is the widest
    // line the picker shipped with before (81 columns), in the worst state.
    const worst = {
      allowProviderManagement: true,
      hasRemovableProviders: true,
      canSetEffort: true,
      editableProviderId: 'gateway',
      filterable: true,
    };

    for (const line of modelPickerHints({ ...worst, compact: false })) {
      expect(line.length).toBeLessThanOrEqual(81);
    }
    for (const line of modelPickerHints({ ...worst, compact: true })) {
      expect(line.length).toBeLessThanOrEqual(66);
    }
  });
});
