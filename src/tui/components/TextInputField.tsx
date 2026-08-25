import InkTextInput, { type Props as InkTextInputProps } from 'ink-text-input';
import { useCallback, useState } from 'react';
import { stripSgrMouseSequences } from '../mouse.js';

export type TextInputFieldProps = InkTextInputProps;

/**
 * `ink-text-input` splices whatever Ink reports as input straight into the value,
 * so a mouse report from a tracking mode Book did not set (a multiplexer, or a
 * program that exited without restoring the terminal) would be typed into the
 * field. Every Book text field goes through this wrapper so a value can never
 * carry one.
 *
 * Dropping the report is only half the job. `ink-text-input` advances its own
 * cursor by the length of the raw input and re-clamps it only when the `value`
 * prop changes, so a stripped report leaves the cursor pointing past the end of
 * a value that never changed — the next Backspace then deletes the wrong
 * character, invisibly in a masked field. Remounting on the strip re-seats the
 * cursor at the end of the value that survived.
 */
export function TextInputField({ onChange, ...props }: TextInputFieldProps) {
  const [strippedCount, setStrippedCount] = useState(0);

  const handleChange = useCallback(
    (value: string) => {
      const clean = stripSgrMouseSequences(value);
      if (clean !== value) setStrippedCount((count) => count + 1);
      onChange(clean);
    },
    [onChange],
  );

  return <InkTextInput key={strippedCount} {...props} onChange={handleChange} />;
}

export default TextInputField;
