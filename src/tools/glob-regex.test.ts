import { describe, expect, it } from 'vitest';
import {
  globIgnorePatternsWithinLimit,
  globPatternWithinLimit,
  globToRegex,
  globWalkBases,
  globWalkPattern,
  MAX_GLOB_PATTERN_LENGTH,
} from './glob-regex.js';

/** The bases a pattern reports, ordered so an assertion does not depend on enumeration order. */
const basesOf = (pattern: string): string[] => [...globWalkBases(pattern)].sort();

describe('globToRegex', () => {
  it('anchors a pattern at both ends', () => {
    expect(globToRegex('*.ts').test('a.ts')).toBe(true);
    expect(globToRegex('*.ts').test('a.ts.bak')).toBe(false);
  });
});

describe('globWalkBases', () => {
  it('reports where the walk starts, not what the pattern spells', () => {
    // Nothing is named literally, so the walk starts where it stands.
    expect(basesOf('*')).toEqual(['.']);
    expect(basesOf('**/*.ts')).toEqual(['.']);
    expect(basesOf('src/**/*.ts')).toEqual(['src']);
    expect(basesOf('/tmp/ws/src/*.ts')).toEqual(['/tmp/ws/src']);
  });

  it('reports the parent a pattern climbs into', () => {
    expect(basesOf('../**/*')).toEqual(['..']);
    expect(basesOf('../*.ts')).toEqual(['..']);
    expect(basesOf('foo/../bar/*.ts')).toEqual(['foo/../bar']);
  });

  it('reads a pattern holding no glob as the directory that holds the file', () => {
    expect(basesOf('notes.txt')).toEqual(['.']);
    expect(basesOf('src')).toEqual(['.']);
    expect(basesOf('src/notes.txt')).toEqual(['src']);
    // A pattern ending in a separator names the directory itself.
    expect(basesOf('src/')).toEqual(['src']);
  });

  it('enumerates the ways a brace group in the first segment can be spelled', () => {
    // The base of `.{.,x}/*` is its parent: the group's own `.` spells `..`.
    expect(basesOf('.{.,x}/*')).toEqual(['..', '.x']);
    expect(basesOf('{a,b}/*')).toEqual(['a', 'b']);
    expect(basesOf('src/{a,{b,../..}}/*')).toEqual(['src/../..', 'src/a', 'src/b']);
    // A group decides the base only while the walk is still inside the first segment.
    expect(basesOf('src/{a,b}/*.ts')).toEqual(['src/a', 'src/b']);
    // A group with no comma of its own is a range, not an enumeration.
    expect(basesOf('logs/{1..3}.txt')).toEqual(['logs']);
  });

  it('reads an anchor too large to spell out as it stands', () => {
    const anchor = '{a,b}'.repeat(20);
    expect(basesOf(`${anchor}/x`)).toEqual(['.']);
    // One that names a parent is reported unreadable instead, since the enumeration that would
    // show the climb is the one that could not run.
    expect(globWalkBases(`src/{,..}${anchor}/*`)).toEqual([]);
  });

  it('reports no base for a pattern too long for the matcher to read', () => {
    expect(globWalkBases('{a,'.repeat(10_000) + '}'.repeat(10_000))).toEqual([]);
  });
});

describe('globPatternWithinLimit', () => {
  it('holds the line at the length the matcher can survive', () => {
    expect(globPatternWithinLimit('src/**/*.ts')).toBe(true);
    expect(globPatternWithinLimit('a'.repeat(MAX_GLOB_PATTERN_LENGTH))).toBe(true);
    expect(globPatternWithinLimit('a'.repeat(MAX_GLOB_PATTERN_LENGTH + 1))).toBe(false);
  });
});

describe('globIgnorePatternsWithinLimit', () => {
  it('drops the entries the matcher cannot compile and keeps the rest in order', () => {
    // A walk compiles its ignore entries like its pattern, so a `.gitignore` line over the limit
    // has to go before the list is handed over — the ordinary lines beside it still apply.
    const tooLong = 'a'.repeat(MAX_GLOB_PATTERN_LENGTH + 1);
    expect(globIgnorePatternsWithinLimit(['dist', tooLong, '**/build/**'])).toEqual([
      'dist',
      '**/build/**',
    ]);
    expect(globIgnorePatternsWithinLimit([])).toEqual([]);
  });
});

describe('globWalkPattern', () => {
  it('leaves a POSIX pattern as written', () => {
    // A brace expansion, an extglob and an escape are the caller's syntax and must survive.
    for (const pattern of ['src/*.ts', 'src/{a,b}/*.ts', 'src/(a|b)/*.ts', 'src/\\*.ts']) {
      expect(globWalkPattern(pattern)).toBe(pattern);
    }
  });

  it('splices the converted base back onto the dynamic tail', () => {
    expect(globWalkPattern('src/{a,b}/*.ts')).toBe('src/{a,b}/*.ts');
    expect(globWalkPattern('/tmp/ws/src/*.ts')).toBe('/tmp/ws/src/*.ts');
  });
});
