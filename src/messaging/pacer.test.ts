import { describe, expect, it } from 'vitest';
import { SendPacer } from './pacer.js';

describe('SendPacer', () => {
  it("mirrors the receiver's bucket: 30 sends, then paced", () => {
    let now = 0;
    const pacer = new SendPacer(() => now);
    for (let i = 0; i < 30; i++) expect(pacer.take('/s/1.sock')).toBe(true);
    expect(pacer.take('/s/1.sock')).toBe(false);
    // Each receiver is paced on its own.
    expect(pacer.take('/s/2.sock')).toBe(true);
    now += 2_000;
    expect(pacer.take('/s/1.sock')).toBe(true);
    expect(pacer.take('/s/1.sock')).toBe(false);
  });

  it('gives a token back for a send that never reached the receiver', () => {
    const pacer = new SendPacer(() => 0);
    for (let i = 0; i < 30; i++) pacer.take('/s/1.sock');
    pacer.refund('/s/1.sock');
    expect(pacer.take('/s/1.sock')).toBe(true);
    expect(pacer.take('/s/1.sock')).toBe(false);
  });

  it('never refunds past a full bucket', () => {
    const pacer = new SendPacer(() => 0);
    pacer.take('/s/1.sock');
    pacer.refund('/s/1.sock');
    pacer.refund('/s/1.sock');
    expect(pacer.available('/s/1.sock')).toBe(30);
  });
});
