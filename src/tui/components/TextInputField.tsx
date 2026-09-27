import { Text, useInput } from 'ink';
import { useCallback, useReducer, useRef } from 'react';
import {
  applyReadlineChord,
  deleteNextGrapheme,
  deletePreviousGrapheme,
  type EditState,
} from '../line-edit.js';
import { stripSgrMouseSequences } from '../mouse.js';

export interface TextInputFieldProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  /** Replaces every character, for a secret: one mask character per value character. */
  mask?: string;
  focus?: boolean;
  showCursor?: boolean;
}

const REVERSE_ON = '\u001b[7m';
const REVERSE_OFF = '\u001b[27m';

/** The field's own cursor: a highlighted cell, not the terminal's cursor. */
function highlight(text: string): string {
  return `${REVERSE_ON}${text}${REVERSE_OFF}`;
}

/**
 * The single-line editor every Book text field uses.
 *
 * This was a wrapper around `ink-text-input`, which has no readline keys at
 * all: it dispatched on `key.backspace`, `key.leftArrow` and `key.return` and
 * spliced everything else into the value as literal text, so every chord
 * arrived as its own letter — Ctrl+U in a wizard's prefilled base URL produced
 * `u`. Filtering in front of it could not fix that either: Ink delivers one
 * stdin chunk to every handler in turn, so after a Left the inner component
 * re-subscribed and inserted its `u` *after* the wrapper had cleared the
 * field, leaving `https://abc.example/vu1`.
 *
 * Owning the cursor is the fix. The chords a single-line field honours are
 * {@link applyReadlineChord} — Ctrl+A/E, Ctrl+U, Ctrl+K, Ctrl+W, Ctrl+D — and
 * every other Ctrl chord is dropped rather than typed, because a chord reaches
 * this handler as the bare letter it stands for.
 *
 * A mouse report used by the transcript reaches every field too, so raw input
 * is stripped before it is spliced in. That is now sufficient on its own: the
 * cursor is this component's state and moves by what was inserted rather than
 * by the length of the report, so the re-seat `ink-text-input` needed cannot
 * come back.
 */
export function TextInputField({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  mask,
  focus = true,
  showCursor = true,
}: TextInputFieldProps) {
  // Refs rather than state, like `InputBox`: Ink runs the handler once per
  // stdin chunk, so a key that arrives in the same React batch as the value it
  // edits must see the value as it was when the key arrived.
  const valueRef = useRef(value);
  const cursorRef = useRef(value.length);
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  onChangeRef.current = onChange;
  onSubmitRef.current = onSubmit;
  const [, rerender] = useReducer((version: number) => version + 1, 0);

  // A value the parent changed — a different step's field, a reset, a
  // suggestion — puts the cursor at its end, the way a fresh field reads.
  if (value !== valueRef.current) {
    valueRef.current = value;
    cursorRef.current = value.length;
  }

  const commit = useCallback((edit: EditState) => {
    const changed = edit.value !== valueRef.current;
    valueRef.current = edit.value;
    cursorRef.current = Math.max(0, Math.min(edit.cursorOffset, edit.value.length));
    rerender();
    if (changed) onChangeRef.current(edit.value);
  }, []);

  useInput(
    (rawInput, key) => {
      if (
        key.upArrow ||
        key.downArrow ||
        (key.ctrl && rawInput === 'c') ||
        key.tab ||
        (key.shift && key.tab)
      ) {
        return;
      }
      if (key.return) {
        onSubmitRef.current?.(valueRef.current);
        return;
      }

      const current: EditState = { value: valueRef.current, cursorOffset: cursorRef.current };

      // A chord arrives as the bare letter it stands for, so one this editor
      // does not know must end the key here: falling through would type it.
      if (key.ctrl) {
        const edit = applyReadlineChord(current, rawInput.toLowerCase());
        if (edit) commit(edit);
        return;
      }
      if (key.meta) return;
      if (key.leftArrow) {
        commit({ value: current.value, cursorOffset: current.cursorOffset - 1 });
        return;
      }
      if (key.rightArrow) {
        commit({ value: current.value, cursorOffset: current.cursorOffset + 1 });
        return;
      }
      if (key.home) {
        commit({ value: current.value, cursorOffset: 0 });
        return;
      }
      if (key.end) {
        commit({ value: current.value, cursorOffset: current.value.length });
        return;
      }
      if (key.backspace) {
        commit(deletePreviousGrapheme(current.value, current.cursorOffset));
        return;
      }
      if (key.delete) {
        commit(deleteNextGrapheme(current.value, current.cursorOffset));
        return;
      }
      // A key release is its own event; the press above already acted.
      if (key.eventType === 'release') return;

      const input = stripSgrMouseSequences(rawInput);
      if (!input) return;
      commit({
        value:
          current.value.slice(0, current.cursorOffset) +
          input +
          current.value.slice(current.cursorOffset),
        cursorOffset: current.cursorOffset + input.length,
      });
    },
    { isActive: focus },
  );

  const shown = mask ? mask.repeat(value.length) : value;
  const cursorAt = cursorRef.current;
  // An empty field shows the placeholder with the cursor over its first
  // character, which is how the field reads as focused when there is nothing to
  // edit yet. Grey is the placeholder's own colour; the theme tints the rest.
  if (shown.length === 0) {
    return (
      <Text>
        {placeholder
          ? showCursor && focus
            ? `${REVERSE_ON}${placeholder[0]}${REVERSE_OFF}${placeholder.slice(1)}`
            : placeholder
          : showCursor && focus
            ? highlight(' ')
            : ''}
      </Text>
    );
  }

  let body: string;
  if (showCursor && focus) {
    body = '';
    let index = 0;
    for (const character of shown) {
      body += index === cursorAt ? highlight(character) : character;
      index += character.length;
    }
    if (cursorAt >= shown.length) body += highlight(' ');
  } else {
    body = shown;
  }

  return <Text>{body}</Text>;
}

export default TextInputField;
