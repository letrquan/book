import { describe, expect, it } from 'vitest';
import { parseMouseWheelDirection } from './mouse.js';

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
