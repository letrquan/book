import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Context discovery on Windows (the per-turn fingerprint of what it reads, and the lists it
 * builds) asks the UNC guard before it follows a project path: a link to a network path under
 * `.claude`, `.book/commands`, `.book/agents` or a skill root is neither resolved nor listed. Run
 * on any host, as the other `*.win32.test.ts` suites are (`src/test/windows-links.ts`).
 */
const links = vi.hoisted(() => ({
  map: new Map<string, string>(),
  posixHost: process.platform !== 'win32',
}));

vi.mock('fs', async (importOriginal) =>
  (await import('../test/windows-links.js')).withWindowsLinks(await importOriginal(), links),
);
vi.mock('node:fs', async (importOriginal) =>
  (await import('../test/windows-links.js')).withWindowsLinks(await importOriginal(), links),
);

import * as fs from 'fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clearSpies, touches, windowsSpelling } from '../test/windows-links.js';
import { AgentContextCache } from './context.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const previousBookHome = process.env.BOOK_HOME;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'book-context-links-'));
  process.env.BOOK_HOME = join(tmp, 'book-home');
  links.map.clear();
  clearSpies(fs);
  clearSpies(nodeFs);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  if (previousBookHome === undefined) delete process.env.BOOK_HOME;
  else process.env.BOOK_HOME = previousBookHome;
  rmSync(tmp, { recursive: true, force: true });
});

const followers = () => [
  fs.statSync,
  fs.readdirSync,
  fs.existsSync,
  fs.readFileSync,
  fs.openSync,
  fs.realpathSync,
  fs.realpathSync.native,
  nodeFs.statSync,
  nodeFs.readdirSync,
  nodeFs.existsSync,
  nodeFs.readFileSync,
  nodeFs.openSync,
  nodeFs.realpathSync,
  nodeFs.realpathSync.native,
];

describe('context discovery on Windows with links to a network path', () => {
  it('neither resolves nor lists a project path that links to a share', () => {
    const ws = join(tmp, 'ws');
    const linked = [
      join(ws, '.claude', 'notes'),
      join(ws, '.book', 'commands', 'shared'),
      join(ws, '.book', 'agents'),
      join(ws, '.book', 'skills', 'remote'),
    ];
    for (const dir of linked) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'inside.md'), 'inside');
      links.map.set(windowsSpelling(dir), '\\\\host\\share\\dir');
    }
    mkdirSync(join(ws, '.book', 'skills', 'good'), { recursive: true });
    writeFileSync(
      join(ws, '.book', 'skills', 'good', 'SKILL.md'),
      ['---', 'name: good', 'description: The good skill', '---', 'Body'].join('\n'),
    );
    writeFileSync(join(ws, 'CLAUDE.md'), 'Project instructions.');

    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const discovery = new AgentContextCache().discovery(ws);

    expect(
      discovery.skills.filter((skill) => skill.source === 'project').map((s) => s.name),
    ).toEqual(['good']);
    for (const spy of followers()) {
      for (const dir of linked) expect(touches(spy, dir), dir).toBe(false);
    }
    // The controls: the fingerprint and discovery read through the spied calls.
    expect(touches(fs.statSync, join(ws, 'CLAUDE.md'))).toBe(true);
    expect(touches(fs.statSync, join(ws, '.book', 'skills', 'good'))).toBe(true);
  });
});
