import { describe, expect, it } from 'vitest';
import { parseMouseWheelDirection, parseSgrMouseEvent, parseSgrMouseEvents } from './mouse.js';

describe('parseSgrMouseEvent', () => {
  it('parses left clicks, releases, movement, coordinates, and modifiers', () => {
    expect(parseSgrMouseEvent('\x1b[<0;13;20M')).toEqual({
      type: 'press',
      button: 'left',
      x: 13,
      y: 20,
      shift: false,
      alt: false,
      ctrl: false,
    });
    expect(parseSgrMouseEvent('\x1b[<0;13;20m')).toMatchObject({
      type: 'release',
      button: 'left',
    });
    expect(parseSgrMouseEvent('\x1b[<52;4;7M')).toMatchObject({
      type: 'move',
      button: 'left',
      shift: true,
      ctrl: true,
    });
    expect(parseSgrMouseEvent('\x1b[<35;4;7M')).toMatchObject({
      type: 'move',
      button: 'none',
    });
  });

  it('rejects malformed, zero-coordinate, and wheel-release reports', () => {
    expect(parseSgrMouseEvent('\x1b[<0;0;2M')).toBeNull();
    expect(parseSgrMouseEvent('\x1b[<64;1;1m')).toBeNull();
    expect(parseSgrMouseEvent('text')).toBeNull();
  });
});

describe('parseMouseWheelDirection', () => {
  it('parses wheel up and down reports', () => {
    expect(parseMouseWheelDirection('\x1b[<64;13;20M')).toBe('up');
    expect(parseMouseWheelDirection('\x1b[<65;13;20M')).toBe('down');
  });

  it('allows keyboard modifier bits on wheel reports', () => {
    expect(parseMouseWheelDirection('\x1b[<68;4;7M')).toBe('up');
    expect(parseMouseWheelDirection('\x1b[<77;4;7M')).toBe('down');
  });

  it('ignores clicks, releases, malformed reports, and trailing input', () => {
    expect(parseMouseWheelDirection('\x1b[<0;13;20M')).toBeNull();
    expect(parseMouseWheelDirection('\x1b[<64;13;20m')).toBeNull();
    expect(parseMouseWheelDirection('\x1b[<64;13M')).toBeNull();
    expect(parseMouseWheelDirection('\x1b[<64;13;20Mtext')).toBeNull();
  });
});

describe('parseSgrMouseEvents', () => {
  it('parses every complete report in a coalesced terminal input chunk', () => {
    expect(parseSgrMouseEvents('\x1b[<64;13;20M\x1b[<64;13;20M\x1b[<65;13;20M')).toMatchObject([
      { type: 'wheel', button: 'wheel-up' },
      { type: 'wheel', button: 'wheel-up' },
      { type: 'wheel', button: 'wheel-down' },
    ]);
  });

  it('ignores surrounding text, incomplete reports, and invalid wheel releases', () => {
    expect(parseSgrMouseEvents('text\x1b[<64;1;1Mincomplete\x1b[<65;1')).toMatchObject([
      { type: 'wheel', button: 'wheel-up' },
    ]);
    expect(parseSgrMouseEvents('\x1b[<64;1;1m')).toEqual([]);
  });
});
