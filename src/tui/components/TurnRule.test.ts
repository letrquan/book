import { describe, expect, it } from 'vitest';
import { composeTurnRule } from './TurnRule.js';
import { displayWidth } from './word-wrap.js';

function rendered(parts: ReturnType<typeof composeTurnRule>): string {
  return `${parts.lead}${parts.label}${parts.fill}${parts.trailing}${parts.tail}`;
}

describe('composeTurnRule', () => {
  it('spans exactly the requested width', () => {
    for (const width of [20, 40, 80, 120, 200]) {
      expect(displayWidth(rendered(composeTurnRule('you', '10:55', width)))).toBe(width);
    }
  });

  it('spans the width without a trailing label too', () => {
    for (const width of [20, 80, 200]) {
      expect(displayWidth(rendered(composeTurnRule('you', '', width)))).toBe(width);
    }
  });

  it('keeps the label readable and drops fill first when space is tight', () => {
    const parts = composeTurnRule('you', '10:55', 20);
    expect(parts.label).toBe('you');
    expect(rendered(parts)).toContain('10:55');
  });

  it('truncates an over-long label rather than overflowing', () => {
    const parts = composeTurnRule('a'.repeat(200), '10:55', 40);
    expect(displayWidth(rendered(parts))).toBe(40);
  });

  it('never renders below a usable minimum width', () => {
    expect(displayWidth(rendered(composeTurnRule('you', '', 1)))).toBe(8);
  });
});
