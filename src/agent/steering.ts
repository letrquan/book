import type { SteeredInput, SteeringInbox } from '../types/messages.js';

/**
 * The host's handle on a steering inbox: the loop reads through `SteeringInbox`, while the host
 * that feeds it also needs to push, inspect and clear.
 */
export interface SteeringInboxHandle extends SteeringInbox {
  /** Queue a steer. It stays pending until the loop's next boundary drains it. */
  push(input: SteeredInput): void;
  /** Drop everything pending: the host withdrew its steers, or the run is gone. */
  clear(): void;
  /**
   * Take one pending steer out by id: the user recalled it with Up to edit, and a steer they are
   * editing must not also be delivered where it was. A no-op when the loop already drained it.
   */
  remove(id: string): void;
  /** A snapshot of what is queued, oldest first, without consuming it. */
  pending(): readonly SteeredInput[];
}

/**
 * A queue of user messages for one running loop.
 *
 * Instance state only, deliberately: the queue belongs to the run whose host feeds it, and a
 * module-level one would let two runs drain each other's messages. `take` hands back everything
 * pending in one call, so a steer pushed while a tool batch ran cannot slip between results.
 * `requestNow` asks the loop to stop the model request in flight so the steers go at once (#661).
 */
export function createSteeringInbox(): SteeringInboxHandle {
  let queue: SteeredInput[] = [];
  /**
   * A send-now that has not been answered yet. It is answered when the loop takes what is
   * pending, and it lapses when nothing is left to send: a steer recalled with Up, or cleared.
   */
  let nowRequested = false;
  const nowListeners = new Set<() => void>();
  return {
    push(input) {
      queue.push(input);
    },
    take() {
      nowRequested = false;
      if (queue.length === 0) return [];
      const taken = queue;
      queue = [];
      return taken;
    },
    requeue(inputs) {
      if (inputs.length > 0) queue = [...inputs, ...queue];
    },
    hasPending() {
      return queue.length > 0;
    },
    requestNow() {
      if (queue.length === 0) return;
      nowRequested = true;
      // A copy: a listener that unsubscribes while it runs must not skip the next one.
      for (const listener of [...nowListeners]) listener();
    },
    onRequestNow(listener) {
      nowListeners.add(listener);
      if (nowRequested && queue.length > 0) listener();
      return () => {
        nowListeners.delete(listener);
      };
    },
    clear() {
      queue = [];
      nowRequested = false;
    },
    remove(id) {
      queue = queue.filter((entry) => entry.id !== id);
      if (queue.length === 0) nowRequested = false;
    },
    pending() {
      // A copy: the host renders this while the loop may push or drain, and a live array would
      // let one mutate the other's view.
      return [...queue];
    },
  };
}
