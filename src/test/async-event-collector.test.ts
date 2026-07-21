import { describe, expect, it } from 'vitest';
import { AsyncEventCollector } from './async-event-collector.js';

describe('AsyncEventCollector', () => {
  it('resolves waiting consumers and preserves buffered order', async () => {
    const collector = new AsyncEventCollector<string>();
    const waiting = collector.next();
    collector.push('first');
    collector.push('second');

    await expect(waiting).resolves.toEqual({ value: 'first', done: false });
    await expect(collector.next()).resolves.toEqual({ value: 'second', done: false });
    collector.close();
    await expect(collector.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('rejects pending consumers when closed with an error', async () => {
    const collector = new AsyncEventCollector<string>();
    const waiting = collector.next();
    collector.close(new Error('collector failed'));

    await expect(waiting).rejects.toThrow('collector failed');
    await expect(collector.next()).rejects.toThrow('collector failed');
    expect(collector.push('late')).toBe(false);
  });
});
