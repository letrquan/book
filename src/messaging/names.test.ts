import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { deriveLiveSessionName, slugifySessionName } from './names.js';

/** A byte source that replays `bytes`, then repeats the last one. */
function bytes(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

describe('slugifySessionName', () => {
  it('keeps lowercase ASCII letters and digits, joined by single hyphens', () => {
    expect(slugifySessionName('My Project')).toBe('my-project');
    expect(slugifySessionName('  book__v2..final  ')).toBe('book-v2-final');
    expect(slugifySessionName('Café Déjà')).toBe('cafe-deja');
    expect(slugifySessionName('-x-')).toBe('x');
  });

  it('is empty when nothing survives', () => {
    expect(slugifySessionName('日本')).toBe('');
    expect(slugifySessionName('...')).toBe('');
  });

  it('caps the length without leaving a trailing hyphen', () => {
    const slug = slugifySessionName(`${'a'.repeat(31)} tail`);
    expect(slug).toBe('a'.repeat(31));
    expect(slugifySessionName('b'.repeat(80))).toHaveLength(32);
  });
});

describe('deriveLiveSessionName', () => {
  const cwd = join('work', 'Book Repo');

  it('derives <slug(basename cwd)>-<2 hex>', () => {
    expect(deriveLiveSessionName({ cwd, liveNames: new Set(), randomByte: bytes(0x3f) })).toEqual({
      name: 'book-repo-3f',
      nameSource: 'derived',
    });
    expect(
      deriveLiveSessionName({ cwd: join('w', 'x'), liveNames: new Set(), randomByte: bytes(5) }),
    ).toEqual({ name: 'x-05', nameSource: 'derived' });
  });

  it('falls back to the book stem when the workspace name slugs to nothing', () => {
    expect(
      deriveLiveSessionName({ cwd: join('w', '日本'), liveNames: new Set(), randomByte: bytes(1) }),
    ).toEqual({ name: 'book-01', nameSource: 'derived' });
  });

  it('re-rolls a name a live session holds, and says so', () => {
    expect(
      deriveLiveSessionName({
        cwd,
        liveNames: new Set(['book-repo-3f', 'book-repo-40']),
        randomByte: bytes(0x3f, 0x40, 0x41),
      }),
    ).toEqual({ name: 'book-repo-41', nameSource: 'collision' });
  });

  it('widens the suffix once two hex digits keep colliding, and never loops forever', () => {
    const liveNames = new Set(['book-repo-07', 'book-repo-0707']);
    const widened = deriveLiveSessionName({ cwd, liveNames, randomByte: bytes(7, 7) });
    // Every byte is 7: the two-hex names all collide, then so does every four-hex one, and the
    // derivation still returns.
    expect(widened).toEqual({ name: 'book-repo-0707', nameSource: 'collision' });

    let calls = 0;
    const later = deriveLiveSessionName({
      cwd,
      liveNames: new Set(['book-repo-07']),
      randomByte: () => (++calls <= 32 ? 7 : 9),
    });
    expect(later).toEqual({ name: 'book-repo-0909', nameSource: 'collision' });
  });

  it('takes BOOK_SESSION_NAME as the user name, slugged, even when a live session holds it', () => {
    expect(
      deriveLiveSessionName({
        cwd,
        liveNames: new Set(['api-worker']),
        env: { BOOK_SESSION_NAME: ' API Worker ' },
        randomByte: bytes(0),
      }),
    ).toEqual({ name: 'api-worker', nameSource: 'user' });
  });

  it('derives a name when BOOK_SESSION_NAME slugs to nothing', () => {
    expect(
      deriveLiveSessionName({
        cwd,
        liveNames: new Set(),
        env: { BOOK_SESSION_NAME: '!!!' },
        randomByte: bytes(0xab),
      }),
    ).toEqual({ name: 'book-repo-ab', nameSource: 'derived' });
  });
});
