import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { resolveBookHome } from './book-home.js';

describe('resolveBookHome', () => {
  it('uses the conventional .book directory under the system home by default', () => {
    const systemHome = 'C:\\Users\\test-user';
    expect(resolveBookHome({}, systemHome)).toBe(join(systemHome, '.book'));
  });

  it('resolves an explicit BOOK_HOME independently of the system home', () => {
    expect(resolveBookHome({ BOOK_HOME: './isolated-book-home' }, '/ignored')).toBe(
      resolve('./isolated-book-home'),
    );
  });

  it('ignores an empty BOOK_HOME override', () => {
    const systemHome = '/tmp/test-home';
    expect(resolveBookHome({ BOOK_HOME: '   ' }, systemHome)).toBe(join(systemHome, '.book'));
  });
});
