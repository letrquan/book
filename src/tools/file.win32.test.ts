import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The walks of `Glob` and `Grep` on Windows ask the UNC guard before they list a directory they
 * start from or follow a link: a link to `\\host\share` is not resolved, and a pattern naming a
 * share is not listed. Run on any host: the platform is stubbed, the walk runs over a real
 * directory, and the guard sees the links `links.map` declares (`src/test/windows-links.ts`).
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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearSpies, touches, windowsSpelling } from '../test/windows-links.js';
import type { ToolContext } from '../types/tools.js';
import { fileTools } from './file.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const glob = fileTools.find((tool) => tool.name === 'Glob')!;
const grep = fileTools.find((tool) => tool.name === 'Grep')!;

let tmp: string;
let ws: string;
let ctx: ToolContext;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'book-walk-links-'));
  ws = join(tmp, 'ws');
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src', 'app.ts'), 'const marker = 1;');
  // What the share would serve.
  mkdirSync(join(tmp, 'share'));
  writeFileSync(join(tmp, 'share', 'remote.ts'), 'const marker = 2;');
  // Real links, so the walk meets link entries (a junction needs no privilege on Windows): one the
  // guard sees as a link to a share, and one to a directory in the workspace.
  symlinkSync(join(tmp, 'share'), join(ws, 'share'), 'junction');
  symlinkSync(join(ws, 'src'), join(ws, 'alias'), 'junction');
  links.map.clear();
  links.map.set(windowsSpelling(join(ws, 'share')), '\\\\host\\share');
  links.map.set(windowsSpelling(join(ws, 'alias')), windowsSpelling(join(ws, 'src')));
  ctx = { workspaceRoot: ws, env: { BOOK_GREP_BACKEND: 'typescript' } };
  clearSpies(fs);
  clearSpies(nodeFs);
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  rmSync(tmp, { recursive: true, force: true });
});

/** That the walk resolved neither the link to the share nor anything behind it, and did the rest. */
function expectShareUntouched(): void {
  for (const spy of [fs.realpath, nodeFs.readdir, fs.readdir]) {
    expect(touches(spy, join(ws, 'share'))).toBe(false);
    expect(touches(spy, join(tmp, 'share'))).toBe(false);
  }
  // The controls: the walk lists through the spied `readdir`, and resolves the local link.
  expect(touches(nodeFs.readdir, join(ws, 'src'))).toBe(true);
  expect(touches(fs.realpath, join(ws, 'alias'))).toBe(true);
}

describe('Glob and Grep walks on Windows with a link to a network path', () => {
  it('Glob does not follow a link to a share', async () => {
    const result = await glob.execute({ pattern: '**/*.ts' }, ctx);
    expect(result.status).toBe('success');
    expect(result.content).toContain('app.ts');
    expect(result.content).not.toContain('remote.ts');
    expectShareUntouched();
  });

  it('Grep does not follow a link to a share', async () => {
    const result = await grep.execute({ pattern: 'marker', include: '**/*.ts' }, ctx);
    expect(result.content).toContain('app.ts');
    expect(result.content).not.toContain('remote.ts');
    expectShareUntouched();
  });

  it('Glob and Grep do not list a workspace that links to a share', async () => {
    links.map.set(windowsSpelling(ws), '\\\\host\\share\\ws');
    await glob.execute({ pattern: '**/*.ts' }, ctx);
    await grep.execute({ pattern: 'marker', include: '**/*.ts' }, ctx);
    for (const spy of [nodeFs.readdir, fs.readdir, fs.realpath]) {
      expect(touches(spy, ws)).toBe(false);
    }
  });

  // Only Windows' own `path` keeps a UNC pattern as the walk's root; elsewhere it walks from `cwd`.
  it.runIf(process.platform === 'win32')(
    'Glob and Grep do not list a share a pattern names',
    async () => {
      await glob.execute({ pattern: '//host/share/**/*.ts' }, ctx);
      await grep.execute({ pattern: 'marker', include: '//host/share/**/*.ts' }, ctx);
      for (const spy of [nodeFs.readdir, fs.readdir, fs.realpath]) {
        expect(touches(spy, '\\\\host\\share')).toBe(false);
      }
    },
  );
});
