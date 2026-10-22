import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `loadGitignore` on Windows asks the UNC guard before it opens `.gitignore`: one that links to a
 * network path is not opened and gives no patterns. Run on any host, as the other
 * `*.win32.test.ts` suites are (`src/test/windows-links.ts`).
 */
const links = vi.hoisted(() => ({
  map: new Map<string, string>(),
  posixHost: process.platform !== 'win32',
}));

vi.mock('fs', async (importOriginal) =>
  (await import('../test/windows-links.js')).withWindowsLinks(await importOriginal(), links),
);

import * as fs from 'fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clearSpies, touches, windowsSpelling } from '../test/windows-links.js';
import { loadGitignore } from './gitignore.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'book-gitignore-links-'));
  links.map.clear();
  clearSpies(fs);
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  rmSync(tmp, { recursive: true, force: true });
});

describe('loadGitignore on Windows with a link to a network path', () => {
  it('does not open a .gitignore that links to a share, and still reads a local one', () => {
    const linked = join(tmp, 'linked');
    const local = join(tmp, 'local');
    for (const dir of [linked, local]) {
      mkdirSync(dir);
      writeFileSync(join(dir, '.gitignore'), 'build/\n');
    }
    links.map.set(windowsSpelling(join(linked, '.gitignore')), '\\\\host\\share\\ignore');

    expect(loadGitignore(linked).patterns).toEqual([]);
    for (const spy of [fs.existsSync, fs.readFileSync, fs.statSync, fs.openSync]) {
      expect(touches(spy, join(linked, '.gitignore'))).toBe(false);
    }

    // The control: a local .gitignore is read through the spied calls.
    expect(loadGitignore(local).patterns).toEqual(['build/']);
    expect(touches(fs.readFileSync, join(local, '.gitignore'))).toBe(true);
  });
});
