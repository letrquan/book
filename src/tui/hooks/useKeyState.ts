import { useCallback, useRef, useState } from 'react';

/**
 * State a key handler can read back inside the same keypress batch.
 *
 * Ink hands a whole chunk of stdin to its handlers in one go, and React batches
 * every `setState` made while that runs. So two keys delivered together — a
 * paste, a held arrow that repeats faster than a frame, buffered input over a
 * slow link — reach the handler with state still showing what it was before the
 * first key touched it. Anything the handler *reads back* is therefore stale:
 *
 *   - a cursor, so Enter opens the row the user was on two keys ago
 *   - a mode flag, so the key meant for a confirmation prompt is dispatched by
 *     the branch that was live before the prompt opened, and does nothing
 *
 * Both were live defects. They were also why the picker suites had to sleep
 * between keypresses to let React flush, which is what made them flake on a
 * loaded CI runner (#148): the sleep was buying correctness, not just settling
 * the frame.
 *
 * `read()` returns the value as of the last `set()`, whether or not React has
 * re-rendered. `set` is the only writer, so the two cannot drift — which a
 * hand-rolled `useState` + `useRef` pair does the moment one update forgets the
 * ref.
 *
 * Use it for state a `useInput` handler reads. Plain `useState` is right for
 * everything a handler only writes (an error string, a filter echoed back into
 * the render).
 */
export function useKeyState<T>(initial: T | (() => T)): [T, (next: T) => void, () => T] {
  const [value, setValue] = useState(initial);
  const ref = useRef(value);
  const set = useCallback((next: T) => {
    ref.current = next;
    setValue(next);
  }, []);
  const read = useCallback(() => ref.current, []);
  return [value, set, read];
}
