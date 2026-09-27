import InkTextInput, { type Props as InkTextInputProps } from 'ink-text-input';
import { useInput } from 'ink';
import { useCallback, useRef, useState } from 'react';
import { stripSgrMouseSequences } from '../mouse.js';

export type TextInputFieldProps = InkTextInputProps;

/**
 * `ink-text-input` splices whatever Ink reports as input straight into the value,
 * so a mouse report can otherwise be typed into the focused field. Every Book
 * text field goes through this wrapper so reports used by the transcript never
 * become form data.
 *
 * Dropping the report is only half the job. `ink-text-input` advances its own
 * cursor by the length of the raw input and re-clamps it only when the `value`
 * prop changes, so a stripped report leaves the cursor pointing past the end of
 * a value that never changed — the next Backspace then deletes the wrong
 * character, invisibly in a masked field. Remounting on the strip re-seats the
 * cursor at the end of the value that survived.
 */
export function TextInputField({ onChange, focus = true, ...props }: TextInputFieldProps) {
  const [strippedCount, setStrippedCount] = useState(0);

  const handleChange = useCallback(
    (value: string) => {
      const clean = stripSgrMouseSequences(value);
      if (clean !== value) setStrippedCount((count) => count + 1);
      onChange(clean);
    },
    [onChange],
  );

  // Ctrl+U kills the text from the start of the line to the cursor, and
  // `ink-text-input` has no readline keys at all: it dropped the chord, so the
  // key arrived as an ordinary `u` and the add-provider wizard's prefilled base
  // URL became "u". Its cursor is component state this wrapper cannot read, so
  // rather than guess an offset to cut at, the chord clears the field. That is
  // the whole of what precedes the cursor in the fields this wraps — a prefilled
  // URL, an API key, a model list, a one-line answer — where the cursor sits at
  // the end. A ref keeps this current: `onChange` changes with every keystroke
  // and re-subscribing the handler on each one is what put a stale closure on
  // the key before.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useInput(
    (input, key) => {
      if (!key.ctrl || key.meta || input.toLowerCase() !== 'u') return;
      onChangeRef.current('');
    },
    { isActive: focus },
  );

  return <InkTextInput key={strippedCount} focus={focus} {...props} onChange={handleChange} />;
}

export default TextInputField;
