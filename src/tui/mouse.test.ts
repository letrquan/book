import { describe, expect, it } from 'vitest';
import { parseSgrMouseEvent, parseSgrMouseEvents, stripSgrMouseSequences } from './mouse.js';

describe('stripSgrMouseSequences', () => {
  it('removes mouse reports before and after Ink consumes the escape byte', () => {
    expect(stripSgrMouseSequences('\x1b[<64;13;20M')).toBe('');
    expect(stripSgrMouseSequences('[<0;13;20m')).toBe('');
    expect(stripSgrMouseSequences('before\x1b[<32;4;7Mafter')).toBe('beforeafter');
  });

  it('removes every report in a burst', () => {
    expect(stripSgrMouseSequences('\x1b[<0;4;2M\x1b[<32;5;2M\x1b[<0;5;2m')).toBe('');
  });

  it('leaves ordinary typed text alone', () => {
    expect(stripSgrMouseSequences('https://api.example.com/v1')).toBe('https://api.example.com/v1');
    expect(stripSgrMouseSequences('sk-[<abc>]')).toBe('sk-[<abc>]');
  });
});

describe('parseSgrMouseEvent', () => {
  it('parses clicks, releases, movement, coordinates, and modifiers', () => {
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
  });

  it('parses wheels and rejects malformed reports', () => {
    expect(parseSgrMouseEvent('\x1b[<64;4;7M')).toMatchObject({
      type: 'wheel',
      button: 'wheel-up',
    });
    expect(parseSgrMouseEvent('\x1b[<65;4;7M')).toMatchObject({
      type: 'wheel',
      button: 'wheel-down',
    });
    expect(parseSgrMouseEvent('\x1b[<0;0;2M')).toBeNull();
    expect(parseSgrMouseEvent('\x1b[<64;1;1m')).toBeNull();
    expect(parseSgrMouseEvent('text')).toBeNull();
  });
});

describe('parseSgrMouseEvents', () => {
  it('parses every complete report in one terminal chunk', () => {
    expect(parseSgrMouseEvents('\x1b[<64;13;20M\x1b[<0;4;7M\x1b[<0;4;7m')).toMatchObject([
      { type: 'wheel', button: 'wheel-up' },
      { type: 'press', button: 'left' },
      { type: 'release', button: 'left' },
    ]);
  });
});
