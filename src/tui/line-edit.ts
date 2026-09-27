/**
 * Single-line text edits, shared by every editor in the TUI.
 *
 * The composer and the sheet fields are the same problem at two sizes, so the
 * offsets a cursor moves by and the text a chord kills live here once rather
 * than being re-derived per component. Everything is a pure function over
 * `(value, cursorOffset)`: no component state, no refs, nothing a keystroke can
 * read stale.
 */

export interface EditState {
  value: string;
  cursorOffset: number;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function previousGraphemeBoundary(value: string, offset: number): number {
  let previous = 0;
  for (const segment of graphemeSegmenter.segment(value)) {
    if (segment.index >= offset) break;
    previous = segment.index;
  }
  return previous;
}

export function nextGraphemeBoundary(value: string, offset: number): number {
  for (const segment of graphemeSegmenter.segment(value)) {
    if (segment.index > offset) return segment.index;
  }
  return value.length;
}

/**
 * Offset of the start of the word before `offset`.
 *
 * Skips the whitespace immediately behind the cursor, then the run of
 * non-whitespace before that — readline's `unix-word-rubout`, which is what
 * Ctrl+W and Alt+Backspace both mean to a terminal user.
 */
export function previousWordBoundary(value: string, offset: number): number {
  let index = offset;
  while (index > 0 && /\s/.test(value[index - 1]!)) index -= 1;
  while (index > 0 && !/\s/.test(value[index - 1]!)) index -= 1;
  return index;
}

/** Offset of the end of the word after `offset`: readline's `kill-word`, what Alt+Delete means. */
export function nextWordBoundary(value: string, offset: number): number {
  let index = offset;
  while (index < value.length && /\s/.test(value[index]!)) index += 1;
  while (index < value.length && !/\s/.test(value[index]!)) index += 1;
  return index;
}

/** Remove `[start, end)` and leave the cursor where the text was. */
export function cut(
  value: string,
  start: number,
  end: number,
): { edit: EditState; killed: string } {
  return {
    edit: { value: value.slice(0, start) + value.slice(end), cursorOffset: start },
    killed: value.slice(start, end),
  };
}

export function normalizeEdit(value: string, cursorOffset: number): EditState {
  return {
    value: value.normalize('NFC'),
    cursorOffset: value.slice(0, cursorOffset).normalize('NFC').length,
  };
}

export function deletePreviousGrapheme(value: string, cursorOffset: number): EditState {
  if (cursorOffset <= 0) return { value, cursorOffset };
  const previousOffset = previousGraphemeBoundary(value, cursorOffset);
  return {
    value: value.slice(0, previousOffset) + value.slice(cursorOffset),
    cursorOffset: previousOffset,
  };
}

export function deleteNextGrapheme(value: string, cursorOffset: number): EditState {
  if (cursorOffset >= value.length) return { value, cursorOffset };
  const nextOffset = nextGraphemeBoundary(value, cursorOffset);
  return { value: value.slice(0, cursorOffset) + value.slice(nextOffset), cursorOffset };
}

/** Apply a raw terminal input chunk, including IME backspace/replacement sequences. */
export function applyInputSequence(value: string, cursorOffset: number, input: string): EditState {
  let edit = { value, cursorOffset };

  for (const character of input) {
    if (character === '\b' || character === '\x7f') {
      edit = deletePreviousGrapheme(edit.value, edit.cursorOffset);
      continue;
    }

    // Ignore control bytes that should never become visible prompt text.
    if (character < ' ' && character !== '\n' && character !== '\t') continue;

    edit = {
      value:
        edit.value.slice(0, edit.cursorOffset) + character + edit.value.slice(edit.cursorOffset),
      cursorOffset: edit.cursorOffset + character.length,
    };
  }

  return normalizeEdit(edit.value, edit.cursorOffset);
}

/**
 * The readline chords a single-line field honours, or `null` when the key is
 * not one of them.
 *
 * A field's editor is the only thing that can act on these: it is the thing
 * holding the cursor. The composer layers a kill ring and its own chord set on
 * top (see `InputBox`); a field has nothing to recover a kill from, so this is
 * the whole contract.
 *
 *   Ctrl+A / Ctrl+E  the start and the end of the line
 *   Ctrl+U           kill to the cursor          (`unix-line-discard`)
 *   Ctrl+K           kill to the end of the line (`kill-line`)
 *   Ctrl+W           kill the word to the left   (`unix-word-rubout`)
 *   Ctrl+D           delete the character under the cursor (`delete-char`)
 *
 * Every other Ctrl chord returns `null`: ignored, never inserted as text. The
 * chords arrive from Ink as the bare letter with `key.ctrl`, so an editor that
 * fell through to insert would type `u`, `w` or `d` into the value.
 */
export function applyReadlineChord(edit: EditState, chord: string): EditState | null {
  const { value, cursorOffset } = edit;
  switch (chord) {
    case 'a':
      return { value, cursorOffset: 0 };
    case 'e':
      return { value, cursorOffset: value.length };
    case 'u':
      return cut(value, 0, cursorOffset).edit;
    case 'k':
      return cut(value, cursorOffset, value.length).edit;
    case 'w':
      return cut(value, previousWordBoundary(value, cursorOffset), cursorOffset).edit;
    case 'd':
      return deleteNextGrapheme(value, cursorOffset);
    default:
      return null;
  }
}

/** The readline chords {@link applyReadlineChord} acts on. */
export const LINE_EDIT_CHORDS = new Set(['a', 'e', 'u', 'k', 'w', 'd']);
