import { describe, expect, it, vi } from 'vitest';
import {
  createQueuedInput,
  enqueueQueuedInput,
  recallNewestQueuedInput,
  restoreQueuedInputAttachments,
  restoreQueuedInputText,
  shouldRequeueQueuedSend,
} from './queued-inputs.js';

describe('queued inputs', () => {
  it('enqueues in FIFO order and enforces capacity', () => {
    const first = createQueuedInput('first', 'session', { id: 'first', createdAt: 1 });
    const second = createQueuedInput('second', 'session', { id: 'second', createdAt: 2 });
    const one = enqueueQueuedInput([], first, 2);
    const two = enqueueQueuedInput(one.queue, second, 2);
    const full = enqueueQueuedInput(two.queue, createQueuedInput('third', 'session'), 2);

    expect(two.queue.map((item) => item.value)).toEqual(['first', 'second']);
    expect(full.accepted).toBe(false);
    expect(full.queue).toEqual(two.queue);
  });

  it('recalls the newest non-dispatching item and preserves its identity', () => {
    const queue = [
      createQueuedInput('first', 'session', { id: 'first', createdAt: 1 }),
      createQueuedInput('sending', 'session', { id: 'sending', createdAt: 2 }),
    ];

    const result = recallNewestQueuedInput(queue, 'sending');

    expect(result.recalled).toMatchObject({ id: 'first', value: 'first', createdAt: 1 });
    expect(result.queue.map((item) => item.id)).toEqual(['sending']);
  });

  it('restores pending inputs before the live draft', () => {
    const queue = [createQueuedInput('first', 'session'), createQueuedInput('second', 'session')];

    expect(restoreQueuedInputText(queue, 'draft')).toBe('first\n\nsecond\n\ndraft');
  });

  it('preserves every queued and draft attachment during interrupt restoration', () => {
    const attachment = (index: number) => ({
      id: `image-${index}`,
      sha256: `${index}`.padStart(64, '0'),
      storageKey: `${`${index}`.padStart(64, '0')}.png`,
      mediaType: 'image/png' as const,
      byteSize: index,
    });
    const queue = [
      createQueuedInput('first', 'session', [attachment(1), attachment(2), attachment(3)]),
      createQueuedInput('second', 'session', [attachment(4), attachment(5)]),
    ];

    expect(restoreQueuedInputAttachments(queue, [attachment(6)]).map((item) => item.id)).toEqual([
      'image-1',
      'image-2',
      'image-3',
      'image-4',
      'image-5',
      'image-6',
    ]);
  });

  it('only retries failures that happen before the user message is persisted', () => {
    expect(shouldRequeueQueuedSend({ status: 'rejected' })).toBe(true);
    expect(shouldRequeueQueuedSend({ status: 'cancelled' })).toBe(true);
    expect(shouldRequeueQueuedSend({ status: 'failed', phase: 'before-prepare' })).toBe(true);
    expect(
      shouldRequeueQueuedSend({
        status: 'failed',
        phase: 'prepare',
        userMessagePersisted: false,
      }),
    ).toBe(true);
    expect(
      shouldRequeueQueuedSend({
        status: 'failed',
        phase: 'prepare',
        userMessagePersisted: true,
      }),
    ).toBe(false);
    expect(shouldRequeueQueuedSend({ status: 'failed', phase: 'run' })).toBe(false);
    expect(shouldRequeueQueuedSend({ status: 'completed' })).toBe(false);
  });

  it('generates a new stable id unless an edited item is resubmitted', () => {
    const generated = '00000000-0000-4000-8000-000000000000';
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(generated);
    expect(createQueuedInput('new', 'session').id).toBe(generated);
    expect(createQueuedInput('edited', 'session', { id: 'same', createdAt: 3 })).toMatchObject({
      id: 'same',
      createdAt: 3,
    });
  });
});
