import { Text, useInput, type Key } from 'ink';
import { useEffect, useReducer, useRef } from 'react';

interface InputBoxProps {
  value: string;
  /**
   * The parent's copy of the draft, written the moment the parent changes it (history,
   * autocomplete, a restored draft). Ink hands every key of one stdin read to the handlers in
   * turn before React renders, so the key after Up reached this editor while `value` still
   * held the text Up had replaced: Up then a character gave the old text plus the character,
   * and Up then Enter submitted nothing. Each key starts from this copy when it differs.
   */
  liveValueRef?: { readonly current: string };
  /**
   * An edit chord arrived with an empty draft. The editor knows the draft was empty before the key
   * and has already declined to apply it, so the key belongs to the transcript.
   */
  onEmptyChord?: (input: string, key: Key) => void;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  /** Backspace pressed while the composer is empty; the key edits nothing here. */
  onBackspaceWhenEmpty?: () => void;
  placeholder?: string;
  focus?: boolean;
}

interface EditState {
  value: string;
  cursorOffset: number;
}

/**
 * Ctrl chords the editor handles as text edits. With an empty draft there is nothing for them to
 * edit, so they belong to the transcript (Ctrl+E expands a tool, Ctrl+U scrolls) and are handed to
 * `onEmptyChord`; Ctrl+Y still yanks into an empty draft when the kill ring holds text.
 */
export const COMPOSER_EDIT_KEYS = new Set(['a', 'e', 'w', 'u', 'k', 'y']);

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * A Backspace this soon after the previous one is key repeat, not a new press. Repeats come every
 * 30-90 ms once a held key starts repeating (Windows ~33 ms, GNOME/X11 ~30-40 ms, macOS ~90 ms);
 * deliberate taps are slower. The first repeat comes later, after the 250-660 ms repeat delay, and
 * only the second one tells a hold from a tap, so a Backspace on an empty composer removes an
 * attachment this long after the press unless a repeat cancels it. Ink 7 hands each repeated byte
 * over as its own key; without this, holding Backspace to clear a draft went on to delete every
 * attached image.
 */
const HELD_REPEAT_MS = 120;

function previousGraphemeBoundary(value: string, offset: number): number {
  let previous = 0;
  for (const segment of graphemeSegmenter.segment(value)) {
    if (segment.index >= offset) break;
    previous = segment.index;
  }
  return previous;
}

function nextGraphemeBoundary(value: string, offset: number): number {
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
function previousWordBoundary(value: string, offset: number): number {
  let index = offset;
  while (index > 0 && /\s/.test(value[index - 1]!)) index -= 1;
  while (index > 0 && !/\s/.test(value[index - 1]!)) index -= 1;
  return index;
}

/** Offset of the end of the word after `offset`: readline's `kill-word`, what Alt+Delete means. */
function nextWordBoundary(value: string, offset: number): number {
  let index = offset;
  while (index < value.length && /\s/.test(value[index]!)) index += 1;
  while (index < value.length && !/\s/.test(value[index]!)) index += 1;
  return index;
}

/** Remove `[start, end)` and leave the cursor where the text was. */
function cut(value: string, start: number, end: number): { edit: EditState; killed: string } {
  return {
    edit: { value: value.slice(0, start) + value.slice(end), cursorOffset: start },
    killed: value.slice(start, end),
  };
}

function normalizeEdit(value: string, cursorOffset: number): EditState {
  return {
    value: value.normalize('NFC'),
    cursorOffset: value.slice(0, cursorOffset).normalize('NFC').length,
  };
}

function deletePreviousGrapheme(value: string, cursorOffset: number): EditState {
  if (cursorOffset <= 0) return { value, cursorOffset };
  const previousOffset = previousGraphemeBoundary(value, cursorOffset);
  return {
    value: value.slice(0, previousOffset) + value.slice(cursorOffset),
    cursorOffset: previousOffset,
  };
}

function deleteNextGrapheme(value: string, cursorOffset: number): EditState {
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
 * Unicode input editor that keeps its draft in refs so rapid IME replacement
 * events never operate on stale React render state.
 */
export function InputBox({
  value,
  liveValueRef,
  onEmptyChord,
  onChange,
  onSubmit,
  onBackspaceWhenEmpty,
  placeholder = '',
  focus = true,
}: InputBoxProps) {
  const valueRef = useRef(value);
  const cursorOffsetRef = useRef(value.length);
  // Kill ring. The three kill keys are the only edits here that can destroy a
  // long prompt in one keystroke, and Ctrl+U in particular used to scroll the
  // transcript instead — so the recovery key ships with them, not after them.
  const killRingRef = useRef('');
  const lastBackspaceAtRef = useRef(Number.NEGATIVE_INFINITY);
  const pendingRemovalRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onBackspaceWhenEmptyRef = useRef(onBackspaceWhenEmpty);
  onBackspaceWhenEmptyRef.current = onBackspaceWhenEmpty;
  const cancelPendingRemoval = () => {
    clearTimeout(pendingRemovalRef.current);
    pendingRemovalRef.current = undefined;
  };
  useEffect(() => () => clearTimeout(pendingRemovalRef.current), []);
  const [, rerender] = useReducer((version: number) => version + 1, 0);

  // Parent-driven changes such as history navigation and autocomplete own the cursor.
  if (value !== valueRef.current) {
    valueRef.current = value;
    cursorOffsetRef.current = value.length;
  }

  const commit = (edit: EditState) => {
    const changed = edit.value !== valueRef.current;
    valueRef.current = edit.value;
    cursorOffsetRef.current = edit.cursorOffset;
    rerender();
    if (changed) onChange(edit.value);
  };

  const killTo = (start: number, end: number) => {
    const { edit, killed } = cut(valueRef.current, start, end);
    if (!killed) return;
    killRingRef.current = killed;
    commit(edit);
  };

  useInput(
    (input, key) => {
      const parentValue = liveValueRef?.current;
      if (parentValue !== undefined && parentValue !== valueRef.current) {
        valueRef.current = parentValue;
        cursorOffsetRef.current = parentValue.length;
      }
      // Any other key ends a Backspace run, so the next Backspace is a fresh press.
      if (!key.backspace || key.meta) lastBackspaceAtRef.current = Number.NEGATIVE_INFINITY;

      // Alt+Backspace deletes the previous word and Alt+Delete the next one, as
      // they do in every other terminal composer.
      if (key.meta && key.backspace) {
        const cursor = cursorOffsetRef.current;
        killTo(previousWordBoundary(valueRef.current, cursor), cursor);
        return;
      }
      if (key.meta && key.delete) {
        const cursor = cursorOffsetRef.current;
        killTo(cursor, nextWordBoundary(valueRef.current, cursor));
        return;
      }
      if (key.meta && key.delete) {
        const cursor = cursorOffsetRef.current;
        killTo(cursor, nextWordBoundary(valueRef.current, cursor));
        return;
      }

      // Readline motions. The composer dropped every Ctrl chord, so fixing a
      // typo halfway through a long prompt meant holding Backspace — slower
      // still in a language where one character can take several keystrokes to
      // compose.
      if (key.ctrl && !key.meta) {
        const cursor = cursorOffsetRef.current;
        const current = valueRef.current;
        const chord = input.toLowerCase();
        if (COMPOSER_EDIT_KEYS.has(chord) && !current && !(chord === 'y' && killRingRef.current)) {
          onEmptyChord?.(input, key);
          return;
        }
        switch (chord) {
          case 'a':
            commit({ value: current, cursorOffset: 0 });
            return;
          case 'e':
            commit({ value: current, cursorOffset: current.length });
            return;
          case 'w':
            killTo(previousWordBoundary(current, cursor), cursor);
            return;
          case 'u':
            killTo(0, cursor);
            return;
          case 'k':
            killTo(cursor, current.length);
            return;
          case 'y': {
            const yanked = killRingRef.current;
            if (!yanked) return;
            commit({
              value: current.slice(0, cursor) + yanked + current.slice(cursor),
              cursorOffset: cursor + yanked.length,
            });
            return;
          }
          default:
            return;
        }
      }

      if (key.upArrow || key.downArrow || key.tab || key.ctrl || key.meta || key.escape) {
        return;
      }

      if (key.return) {
        if (!key.shift) onSubmit?.(valueRef.current);
        return;
      }

      if (key.leftArrow) {
        commit({
          value: valueRef.current,
          cursorOffset: previousGraphemeBoundary(valueRef.current, cursorOffsetRef.current),
        });
        return;
      }

      if (key.rightArrow) {
        commit({
          value: valueRef.current,
          cursorOffset: nextGraphemeBoundary(valueRef.current, cursorOffsetRef.current),
        });
        return;
      }

      if (key.home) {
        commit({ value: valueRef.current, cursorOffset: 0 });
        return;
      }

      if (key.end) {
        commit({ value: valueRef.current, cursorOffset: valueRef.current.length });
        return;
      }

      if (key.backspace) {
        const now = performance.now();
        const repeat = now - lastBackspaceAtRef.current < HELD_REPEAT_MS;
        lastBackspaceAtRef.current = now;
        // The key is held, so the press that scheduled a removal only started the hold.
        if (repeat) cancelPendingRemoval();
        if (valueRef.current !== '') {
          commit(deletePreviousGrapheme(valueRef.current, cursorOffsetRef.current));
          return;
        }
        if (!repeat) {
          cancelPendingRemoval();
          pendingRemovalRef.current = setTimeout(() => {
            pendingRemovalRef.current = undefined;
            onBackspaceWhenEmptyRef.current?.();
          }, HELD_REPEAT_MS);
        }
        return;
      }

      // Ink 7 reports the Delete key (ESC [3~) apart from Backspace; Ink 6 could not tell them apart.
      if (key.delete) {
        commit(deleteNextGrapheme(valueRef.current, cursorOffsetRef.current));
        return;
      }

      if (input) {
        commit(applyInputSequence(valueRef.current, cursorOffsetRef.current, input));
      }
    },
    { isActive: focus },
  );

  const currentValue = valueRef.current;
  if (!focus) {
    // A placeholder is a hint, focused or not: in full-strength text it read as
    // something the user had typed.
    return currentValue ? <Text>{currentValue}</Text> : <Text color="gray">{placeholder}</Text>;
  }

  if (!currentValue) {
    const [first = ' ', ...rest] = [...placeholder];
    return (
      <Text color="gray">
        <Text inverse>{first}</Text>
        {rest.join('')}
      </Text>
    );
  }

  const cursorOffset = cursorOffsetRef.current;
  const nextOffset = nextGraphemeBoundary(currentValue, cursorOffset);
  const before = currentValue.slice(0, cursorOffset);
  const cursor = currentValue.slice(cursorOffset, nextOffset) || ' ';
  const after = currentValue.slice(nextOffset);

  return (
    <Text>
      {before}
      <Text inverse>{cursor}</Text>
      {after}
    </Text>
  );
}
