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

  it('keeps an inline code span intact (#449)', () => {
    expect(deriveSessionName('`npm test` exits 0 and the output is shown')).toBe(
      '`npm test` exits 0 and the output is shown',
    );
  });

  it('drops a leading code fence and its language tag', () => {
    expect(deriveSessionName('```ts\nconsole.log(1)\n```')).toBe('Console.log(1)');
    expect(deriveSessionName('```\nrun the migration\n```')).toBe('Run the migration');
    expect(deriveSessionName('````md\nfix the build')).toBe('Fix the build');
    for (const prompt of ['```ts\nconst x = 1;\n```', '```\nfoo\n```']) {
      expect(deriveSessionName(prompt).startsWith('`')).toBe(false);
    }
  });

  it('treats a word after the fence as a language tag only when a newline follows it', () => {
    // An inline triple-backtick span keeps its subject (#449 review).
    expect(deriveSessionName('```fix-the-build```')).toBe('```fix-the-build```');
    expect(deriveSessionName('```npm test``` fails on CI')).toBe('```npm test``` fails on CI');
    expect(deriveSessionName('```ts run the migration```')).toBe('```ts run the migration```');
  });

  it('removes a bare fence wherever it appears, not only at the end', () => {
    expect(deriveSessionName('```py\nprint(1)\n```\nwhy does this fail?')).toBe(
      'Print(1) why does this fail',
    );
    expect(deriveSessionName('why does this fail?\n```py\nprint(1)\n```')).toBe(
      'Why does this fail? print(1)',
    );
    expect(deriveSessionName('```\r\nrun it\r\n```\r\nthen stop')).toBe('Run it then stop');
  });

  it('uses a neutral label when no name exists', () => {
    expect(displaySessionName()).toBe(UNTITLED_SESSION_NAME);
    expect(displaySessionName('  ')).toBe(UNTITLED_SESSION_NAME);
  });
});
