import { Text, useInput } from 'ink';
import { useReducer, useRef } from 'react';

interface InputBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
}

interface EditState {
  value: string;
  cursorOffset: number;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

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
  onChange,
  onSubmit,
  placeholder = '',
  focus = true,
}: InputBoxProps) {
  const valueRef = useRef(value);
  const cursorOffsetRef = useRef(value.length);
  // Kill ring. The three kill keys are the only edits here that can destroy a
  // long prompt in one keystroke, and Ctrl+U in particular used to scroll the
  // transcript instead — so the recovery key ships with them, not after them.
  const killRingRef = useRef('');
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
      // Alt+Backspace deletes the previous word, as it does in every other
      // terminal composer.
      if (key.meta && (key.backspace || key.delete)) {
        const cursor = cursorOffsetRef.current;
        killTo(previousWordBoundary(valueRef.current, cursor), cursor);
        return;
      }

      // Readline motions. The composer dropped every Ctrl chord, so fixing a
      // typo halfway through a long prompt meant holding Backspace — slower
      // still in a language where one character can take several keystrokes to
      // compose.
      if (key.ctrl && !key.meta) {
        const cursor = cursorOffsetRef.current;
        const current = valueRef.current;
        switch (input.toLowerCase()) {
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

      if (key.backspace || key.delete) {
        commit(deletePreviousGrapheme(valueRef.current, cursorOffsetRef.current));
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
    return <Text>{currentValue || placeholder}</Text>;
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
