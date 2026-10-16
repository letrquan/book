import { useEffect } from 'react';
import type { EventEmitter } from 'node:events';
import { useInput, useStdin, type Key } from 'ink';
import { createUiDebugLogger, type DebugLogger } from '../debug-log.js';

const uiLog = createUiDebugLogger('tui:global-key-handler');

const CTRL_C = '\x03';

/**
 * The pieces of one input event: its Ctrl+C bytes, each alone, and the text between them, in
 * order. Ink's input parser splits a read at escape sequences and backspace bytes only, so an
 * event is either one escape sequence (which never holds a Ctrl+C byte) or a run of text.
 */
function ctrlCPieces(chunk: string): string[] {
  const pieces: string[] = [];
  let textStart = 0;
  for (let index = 0; index < chunk.length; index++) {
    if (chunk[index] !== CTRL_C) continue;
    if (index > textStart) pieces.push(chunk.slice(textStart, index));
    pieces.push(CTRL_C);
    textStart = index + 1;
  }
  if (textStart < chunk.length) pieces.push(chunk.slice(textStart));
  return pieces;
}

/**
 * Makes every Ctrl+C byte that arrived in a stdin read with other input reach each `useInput`
 * subscriber as a press of its own, in order, with the text around it as events of their own
 * (#504).
 *
 * Ink splits a read only at escape sequences and backspace bytes, so `\x03\x03`, `q\x03\x03` or
 * `\x03\r` is handed on as one event that `parseKeypress` reads as no key at all: not Ctrl+C, and,
 * as text, control bytes for any subscriber that takes unnamed input. Presses land in one read
 * whenever the event loop stalls between them, as Book's own does for a few hundred ms after its
 * first frame. Splitting at the emitter, before any subscriber sees the event, is what keeps the
 * control bytes out of the composer as well as counting each press.
 *
 * The pieces are delivered one per turn of the event loop, the first at once, so each sees the
 * state the one before it left: with a draft in the composer, the first press clears it and the
 * second arms the exit window, exactly as two separate reads would. An event read while pieces
 * are still waiting queues behind them, which keeps the order. Removing the splitting drops the
 * pieces still waiting.
 *
 * An event with no Ctrl+C byte, or only one, is passed on untouched and at once, so `hello\r` in
 * one read is still the multiline paste the composer takes it for. Ink's own `paste` event, which
 * only a `usePaste` subscriber receives, is a different event and is never touched; Book has none,
 * so a bracketed paste reaches it as an ordinary `input` event, which it cannot tell from typing.
 *
 * Returns the function that takes the splitting off again.
 */
export function splitCtrlCBytes(emitter: EventEmitter): () => void {
  const original = emitter.emit;
  const waiting: string[] = [];
  let timer: NodeJS.Immediate | undefined;

  const deliver = (piece: string) => original.call(emitter, 'input', piece);
  const drain = () => {
    timer = undefined;
    const piece = waiting.shift();
    if (piece === undefined) return;
    deliver(piece);
    if (waiting.length > 0 && timer === undefined) timer = setImmediate(drain);
  };

  const split = function (this: EventEmitter, event: string | symbol, ...args: unknown[]) {
    const chunk = args[0];
    if (event !== 'input' || typeof chunk !== 'string') return original.call(this, event, ...args);
    if (waiting.length === 0 && (chunk === CTRL_C || !chunk.includes(CTRL_C))) {
      return original.call(this, event, ...args);
    }
    const pieces = ctrlCPieces(chunk);
    if (waiting.length === 0) {
      const heard = deliver(pieces.shift()!);
      waiting.push(...pieces);
      if (waiting.length > 0 && timer === undefined) timer = setImmediate(drain);
      return heard;
    }
    waiting.push(...pieces);
    return emitter.listenerCount('input') > 0;
  } as EventEmitter['emit'];

  emitter.emit = split;
  return () => {
    waiting.length = 0;
    if (timer !== undefined) clearImmediate(timer);
    timer = undefined;
    if (emitter.emit === split) emitter.emit = original;
  };
}

/**
 * Installs {@link splitCtrlCBytes} on Ink's input emitter. Ink hands the emitter out as an
 * `internal_` member, so a later Ink may drop it; the splitting is then off, and that is said once
 * in the UI debug log (`BOOK_DEBUG_UI`) rather than lost silently.
 */
export function installCtrlCSplitting(
  emitter: EventEmitter | undefined,
  log: DebugLogger = uiLog,
): (() => void) | undefined {
  if (!emitter) {
    log.warn(
      'Ink exposes no internal_eventEmitter: Ctrl+C bytes read together are not split into presses (#504)',
    );
    return undefined;
  }
  return splitCtrlCBytes(emitter);
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
 * It also owns the Ctrl+C splitting (`splitCtrlCBytes`), since it is the one component every
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
  useEffect(() => installCtrlCSplitting(internal_eventEmitter), [internal_eventEmitter]);
  useInput(onInput);
  return null;
}
