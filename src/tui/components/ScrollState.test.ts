import { describe, it, expect } from 'vitest';

/**
 * Tests for App-level scroll input handling.
 *
 * The scroll offset is now line-based: it represents how many lines above
 * the tail (newest message) to start the visible window from. PgUp/PgDn
 * move by a screenful (chat height), Up/Down move by 1 line.
 *
 * maxScrollOffset = totalLines - chatHeight (clamped to >= 0).
 */

// ---------------------------------------------------------------------------
// Replicate the scroll offset reducer logic from App.tsx useInput handler.
// This is the pure state machine without React/Ink dependencies.
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function scrollUp(offset: number, maxOffset: number, pageSize: number): number {
  return clamp(offset + 1, 0, maxOffset);
}

function scrollDown(offset: number): number {
  return Math.max(0, offset - 1);
}

function pageUp(offset: number, maxOffset: number, pageSize: number): number {
  return clamp(offset + pageSize, 0, maxOffset);
}

function pageDown(offset: number, pageSize: number): number {
  return Math.max(0, offset - pageSize);
}

function scrollHome(maxOffset: number): number {
  return maxOffset;
}

function scrollEnd(): number {
  return 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Scroll offset state machine (line-based)', () => {
  const chatHeight = 24;
  const totalLines = 200;
  const maxOffset = Math.max(0, totalLines - chatHeight); // 176
  const pageSize = chatHeight - 2; // 22

  it('starts at offset 0 (tail)', () => {
    expect(scrollEnd()).toBe(0);
  });

  it('Up arrow increases offset by 1', () => {
    expect(scrollUp(0, maxOffset, chatHeight)).toBe(1);
    expect(scrollUp(5, maxOffset, chatHeight)).toBe(6);
  });

  it('Down arrow decreases offset by 1', () => {
    expect(scrollDown(5)).toBe(4);
    expect(scrollDown(1)).toBe(0);
  });

  it('Down arrow at offset 0 stays at 0', () => {
    expect(scrollDown(0)).toBe(0);
  });

  it('Up arrow clamped to maxOffset', () => {
    expect(scrollUp(maxOffset, maxOffset, chatHeight)).toBe(maxOffset);
    expect(scrollUp(maxOffset - 1, maxOffset, chatHeight)).toBe(maxOffset);
  });

  it('PgUp increases by page size', () => {
    expect(pageUp(0, maxOffset, pageSize)).toBe(22);
  });

  it('PgDn decreases by page size', () => {
    expect(pageDown(44, pageSize)).toBe(22);
  });

  it('PgUp clamped to maxOffset', () => {
    expect(pageUp(maxOffset - 5, maxOffset, pageSize)).toBe(maxOffset);
  });

  it('PgDn at 0 stays at 0', () => {
    expect(pageDown(0, pageSize)).toBe(0);
  });

  it('Home jumps to maxOffset', () => {
    expect(scrollHome(maxOffset)).toBe(maxOffset);
  });

  it('End jumps to 0', () => {
    expect(scrollEnd()).toBe(0);
  });

  it('multiple PgUp then PgDn returns to original', () => {
    let offset = 0;
    offset = pageUp(offset, maxOffset, pageSize); // 22
    offset = pageUp(offset, maxOffset, pageSize); // 44
    offset = pageDown(offset, pageSize); // 22
    offset = pageDown(offset, pageSize); // 0
    expect(offset).toBe(0);
  });

  it('line-by-line scrolling is precise', () => {
    let offset = 0;
    for (let i = 0; i < 10; i++) offset = scrollUp(offset, maxOffset, chatHeight);
    expect(offset).toBe(10);
    for (let i = 0; i < 5; i++) offset = scrollDown(offset);
    expect(offset).toBe(5);
  });

  it('maxOffset is 0 when content fits in viewport', () => {
    const smallTotal = 20; // fewer lines than chatHeight=24
    const smallMax = Math.max(0, smallTotal - chatHeight);
    expect(smallMax).toBe(0);
  });
});
