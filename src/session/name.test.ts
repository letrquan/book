import { describe, expect, it } from 'vitest';
import { deriveSessionName, displaySessionName, UNTITLED_SESSION_NAME } from './name.js';

describe('session names', () => {
  it('derives a readable title from the first prompt', () => {
    expect(deriveSessionName('  fix the login bug\n in the API. ')).toBe(
      'Fix the login bug in the API',
    );
  });

  it('removes command markers and clips long prompts', () => {
    const name = deriveSessionName(
      '! investigate this very long session prompt that should remain readable in the picker and status panel',
    );
    expect(name).toBe('Investigate this very long session prompt that...');
    expect(name.length).toBeLessThanOrEqual(56);
  });

  it('uses a neutral label when no name exists', () => {
    expect(displaySessionName()).toBe(UNTITLED_SESSION_NAME);
    expect(displaySessionName('  ')).toBe(UNTITLED_SESSION_NAME);
  });
});
