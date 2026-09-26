import { useInput, type Key } from 'ink';

/**
 * Subscribes the app's global key handler ahead of every other `useInput`.
 *
 * Ink 7 subscribes each `useInput` handler once, from an effect, and calls handlers in the order
 * they subscribed. Effects run children first, so a handler in the app's own body would run after
 * every descendant's. Ink 6 re-subscribed a handler whenever it changed, and the composer's inline
 * handlers changed on every render, which in practice left the app's stable handler ahead of them.
 * Rendered as the first child of the app's tree, this keeps that order: the app decides Esc and
 * Ctrl+C before the composer acts on the key.
 */
export function GlobalKeyHandler({
  onInput,
}: {
  onInput: (input: string, key: Key) => void;
}): null {
  useInput(onInput);
  return null;
}
