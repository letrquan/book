import { useEffect } from 'react';
import type { EventEmitter } from 'node:events';
import { useInput, useStdin, type Key } from 'ink';

const CTRL_C_RUN = /^\x03{2,}$/;

/**
 * Makes a run of Ctrl+C bytes that arrived in one stdin read reach every `useInput` subscriber as
 * that many separate presses, in order (#504).
 *
 * Ink splits a read only at escape sequences and backspace bytes, so `\x03\x03` is handed on as
 * one event that `parseKeypress` reads as no key at all: not Ctrl+C, and, as text, a pair of
 * control bytes for any subscriber that takes unnamed input. Two presses land in one read whenever
 * the event loop stalls between them, as Book's own does for a few hundred ms after its first
 * frame. Splitting at the emitter, before any subscriber sees the event, is what keeps the control
 * bytes out of the composer as well as counting each press. Only a run made entirely of Ctrl+C
 * bytes is split; text, a paste and every other sequence pass through untouched.
 *
 * Returns the function that takes the splitting off again.
 */
export function splitCtrlCRuns(emitter: EventEmitter): () => void {
  const original = emitter.emit;
  const split = function (this: EventEmitter, event: string | symbol, ...args: unknown[]) {
    const chunk = args[0];
    if (event === 'input' && typeof chunk === 'string' && CTRL_C_RUN.test(chunk)) {
      let heard = false;
      for (let press = 0; press < chunk.length; press++) {
        heard = original.call(this, event, '\x03') || heard;
      }
      return heard;
    }
    return original.call(this, event, ...args);
  } as EventEmitter['emit'];
  emitter.emit = split;
  return () => {
    if (emitter.emit === split) emitter.emit = original;
  };
}

/**
 * Subscribes the app's global key handler ahead of every other `useInput`.
 *
 * Ink 7 subscribes each `useInput` handler once, from an effect, and calls handlers in the order
 * they subscribed. Effects run children first, so a handler in the app's own body would run after
 * every descendant's. Ink 6 re-subscribed a handler whenever it changed, and the composer's inline
 * handlers changed on every render, which in practice left the app's stable handler ahead of them.
 * Rendered as the first child of the app's tree, this keeps that order: the app decides Esc and
 * Ctrl+C before the composer acts on the key.
 *
 * It also owns the Ctrl+C-run splitting (`splitCtrlCRuns`), since it is the one component every
 * layout of the app mounts first.
 */
export function GlobalKeyHandler({
  onInput,
}: {
  onInput: (input: string, key: Key) => void;
}): null {
  const { internal_eventEmitter } = useStdin() as ReturnType<typeof useStdin> & {
    internal_eventEmitter?: EventEmitter;
  };
  useEffect(
    () => (internal_eventEmitter ? splitCtrlCRuns(internal_eventEmitter) : undefined),
    [internal_eventEmitter],
  );
  useInput(onInput);
  return null;
}
