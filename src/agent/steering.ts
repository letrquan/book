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
 */
export function createSteeringInbox(): SteeringInboxHandle {
  let queue: SteeredInput[] = [];
  return {
    push(input) {
      queue.push(input);
    },
    take() {
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
    clear() {
      queue = [];
    },
    remove(id) {
      queue = queue.filter((entry) => entry.id !== id);
    },
    pending() {
      // A copy: the host renders this while the loop may push or drain, and a live array would
      // let one mutate the other's view.
      return [...queue];
    },
  };
}
