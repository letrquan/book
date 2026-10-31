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
});
