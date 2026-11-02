import { describe, expect, it } from 'vitest';
import { createSteeringInbox } from './steering.js';
import type { SteeredInput } from '../types/messages.js';

function steer(id: string, content = id): SteeredInput {
  return { id, content, timestamp: 1 };
}

describe('steering inbox', () => {
  it('starts empty', () => {
    const inbox = createSteeringInbox();
    expect(inbox.hasPending()).toBe(false);
    expect(inbox.take()).toEqual([]);
  });

  it('hands back what is pending in FIFO order and empties itself', () => {
    const inbox = createSteeringInbox();
    inbox.push(steer('first'));
    inbox.push(steer('second'));

    expect(inbox.hasPending()).toBe(true);
    expect(inbox.take().map((entry) => entry.id)).toEqual(['first', 'second']);
    expect(inbox.hasPending()).toBe(false);
    expect(inbox.take()).toEqual([]);
  });

  it('takes everything a single drain hands back, even after a partial read', () => {
    // `pending` is the host's view for a UI that lists the queue; reading it must not consume.
    const inbox = createSteeringInbox();
    inbox.push(steer('a'));
    inbox.push(steer('b'));

    expect(inbox.pending().map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(inbox.pending()).toHaveLength(2);
    expect(inbox.take()).toHaveLength(2);
  });

  it('keeps its state per inbox, so two runs never drain each other', () => {
    const one = createSteeringInbox();
    const two = createSteeringInbox();
    one.push(steer('for-one'));

    expect(two.hasPending()).toBe(false);
    expect(two.take()).toEqual([]);
    expect(one.hasPending()).toBe(true);
  });

  it('drops everything pending on clear', () => {
    const inbox = createSteeringInbox();
    inbox.push(steer('a'));
    inbox.push(steer('b'));

    inbox.clear();

    expect(inbox.hasPending()).toBe(false);
    expect(inbox.take()).toEqual([]);
  });

  it('puts requeued steers back at the front, in order, ahead of what is pending', () => {
    // What the loop does with what it took but did not deliver: those must be the next ones the
    // next drain sees, and a steer pushed since must still come after them.
    const inbox = createSteeringInbox();
    inbox.push(steer('first'));
    inbox.push(steer('second'));
    inbox.push(steer('third'));
    const taken = inbox.take();
    inbox.push(steer('later'));

    inbox.requeue(taken);

    expect(inbox.pending().map((entry) => entry.id)).toEqual(['first', 'second', 'third', 'later']);
    expect(inbox.take().map((entry) => entry.id)).toEqual(['first', 'second', 'third', 'later']);
  });

  it('requeues nothing as a no-op', () => {
    const inbox = createSteeringInbox();
    inbox.push(steer('a'));

    inbox.requeue([]);

    expect(inbox.pending().map((entry) => entry.id)).toEqual(['a']);
  });

  it('removes one pending steer by id and leaves the rest in place', () => {
    const inbox = createSteeringInbox();
    inbox.push(steer('first'));
    inbox.push(steer('second'));
    inbox.push(steer('third'));

    inbox.remove('second');

    expect(inbox.pending().map((entry) => entry.id)).toEqual(['first', 'third']);
  });

  it('removing an id the loop already drained changes nothing', () => {
    const inbox = createSteeringInbox();
    inbox.push(steer('taken'));
    inbox.take();
    inbox.push(steer('later'));

    inbox.remove('taken');

    expect(inbox.pending().map((entry) => entry.id)).toEqual(['later']);
  });

  it('hands `pending` a copy, so a caller cannot mutate the queue through it', () => {
    const inbox = createSteeringInbox();
    inbox.push(steer('a'));

    const view = inbox.pending() as SteeredInput[];
    view.push(steer('injected'));

    expect(inbox.pending().map((entry) => entry.id)).toEqual(['a']);
  });
});

describe('send-now on the inbox (#661)', () => {
  it('tells its listeners only while a steer is pending', () => {
    const inbox = createSteeringInbox();
    const heard: string[] = [];
    inbox.onRequestNow(() => heard.push('now'));

    // Nothing to send: the chord does nothing.
    inbox.requestNow();
    expect(heard).toEqual([]);

    inbox.push(steer('a'));
    inbox.requestNow();
    expect(heard).toEqual(['now']);
  });

  it('stops telling a listener once it unsubscribes', () => {
    const inbox = createSteeringInbox();
    const heard: string[] = [];
    const unsubscribe = inbox.onRequestNow(() => heard.push('now'));
    inbox.push(steer('a'));

    unsubscribe();
    inbox.requestNow();

    expect(heard).toEqual([]);
  });

  it('keeps a request standing for a listener that subscribes after it, until the loop takes the steers', () => {
    // The loop listens only while a model request streams. A send-now made between two requests
    // still has to stop the next one, or the words wait for the next tool step after all.
    const inbox = createSteeringInbox();
    inbox.push(steer('a'));
    inbox.requestNow();

    const early: string[] = [];
    inbox.onRequestNow(() => early.push('now'));
    expect(early).toEqual(['now']);

    // Taking the steers answers the request: the next request carries them.
    inbox.take();
    inbox.push(steer('b'));
    const late: string[] = [];
    inbox.onRequestNow(() => late.push('now'));
    expect(late).toEqual([]);
  });

  it('lets a request lapse when nothing is left to send', () => {
    const recalled = createSteeringInbox();
    recalled.push(steer('a'));
    recalled.requestNow();
    // Up took the only steer back for editing.
    recalled.remove('a');
    recalled.push(steer('b'));
    const afterRecall: string[] = [];
    recalled.onRequestNow(() => afterRecall.push('now'));
    expect(afterRecall).toEqual([]);

    const cleared = createSteeringInbox();
    cleared.push(steer('a'));
    cleared.requestNow();
    cleared.clear();
    cleared.push(steer('b'));
    const afterClear: string[] = [];
    cleared.onRequestNow(() => afterClear.push('now'));
    expect(afterClear).toEqual([]);
  });
});
