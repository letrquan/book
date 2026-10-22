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
import { buildRipgrepArgs, fileTools, ripgrepIgnoreFile } from './file.js';

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
    // Said, so the list is not taken for the whole workspace.
    expect(result.content).toContain('share (EUNC)');
    expectShareUntouched();
  });

  it('Grep does not follow a link to a share', async () => {
    const result = await grep.execute({ pattern: 'marker', include: '**/*.ts' }, ctx);
    expect(result.content).toContain('app.ts');
    expect(result.content).not.toContain('remote.ts');
    expectShareUntouched();
  });

  it('Grep does not start ripgrep in a root that links to a share', async () => {
    links.map.set(windowsSpelling(ws), '\\\\host\\share\\ws');
    const result = await grep.execute(
      { pattern: 'marker', include: '**/*.ts' },
      { ...ctx, env: { BOOK_GREP_BACKEND: 'ripgrep' } },
    );
    // The portable backend answered, without listing the root, rather than ripgrep.
    expect(result.content).not.toContain('rg was not found');
    expect(result.content).toContain('EUNC');
    expect(touches(nodeFs.readdir, ws)).toBe(false);
  });

  it('Grep refuses a path that links to a share before resolving it', async () => {
    for (const env of [{ BOOK_GREP_BACKEND: 'typescript' }, { BOOK_GREP_BACKEND: 'ripgrep' }]) {
      const result = await grep.execute({ pattern: 'marker', path: 'share' }, { ...ctx, env });
      expect(result.status).toBe('error');
      expect(result.structuredError?.code).toBe('path_unreadable');
    }
    for (const spy of [
      fs.realpathSync,
      fs.realpathSync.native,
      nodeFs.realpathSync,
      nodeFs.realpathSync.native,
      fs.realpath,
      nodeFs.readdir,
    ]) {
      expect(touches(spy, join(ws, 'share'))).toBe(false);
    }
    // The control: a local path is resolved through the spied calls.
    await grep.execute({ pattern: 'marker', path: 'src' }, ctx);
    expect(
      [
        fs.realpathSync,
        fs.realpathSync.native,
        nodeFs.realpathSync,
        nodeFs.realpathSync.native,
      ].some((spy) => touches(spy, join(ws, 'src'))),
    ).toBe(true);
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

describe('the ripgrep backend on Windows', () => {
  it('is handed the root .gitignore once the guard passes it, and finds no ignore files itself', async () => {
    writeFileSync(join(ws, '.gitignore'), 'build/\n');
    expect(await ripgrepIgnoreFile(ws)).toBe(join(ws, '.gitignore'));
    expect(await ripgrepIgnoreFile(join(ws, 'src'))).toBeNull();

    links.map.set(windowsSpelling(join(ws, '.gitignore')), '\\\\host\\share\\ignore');
    expect(await ripgrepIgnoreFile(ws)).toBeNull();

    const argv = (ignoreFile?: string | null) =>
      buildRipgrepArgs({
        pattern: 'x',
        includePattern: '**/*',
        contextBefore: 0,
        contextAfter: 0,
        multiline: false,
        relativePath: '',
        ignoreFile,
      });
    const noDiscovery = ['--no-ignore-vcs', '--no-ignore-dot', '--no-ignore-parent'];
    expect(argv(join(ws, '.gitignore'))).toEqual(
      expect.arrayContaining([...noDiscovery, '--ignore-file', join(ws, '.gitignore')]),
    );
    expect(argv(null)).toEqual(expect.arrayContaining(noDiscovery));
    expect(argv(null)).not.toContain('--ignore-file');
  });

  it('answers a cancel that lands while it looks for the ignore file, before starting ripgrep', async () => {
    const controller = new AbortController();
    // The cancel lands while the root's .gitignore is being looked up, which is what the guard's
    // own lstat of it marks: no timer race decides which comes first.
    const lstat = vi.mocked(fs.lstatSync);
    const original = lstat.getMockImplementation()!;
    lstat.mockImplementation(((path: string, ...rest: unknown[]) => {
      if (windowsSpelling(path) === windowsSpelling(join(ws, '.gitignore'))) {
        controller.abort(new Error('grep cancelled'));
      }
      return (original as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof original);
    try {
      await expect(
        grep.execute(
          { pattern: 'marker', include: '**/*.ts' },
          { ...ctx, env: { BOOK_GREP_BACKEND: 'ripgrep' }, signal: controller.signal },
        ),
      ).rejects.toThrow('grep cancelled');
      expect(controller.signal.aborted).toBe(true);
    } finally {
      lstat.mockImplementation(original);
    }
  });

  it('finds its own ignore files off Windows', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    writeFileSync(join(ws, '.gitignore'), 'build/\n');
    expect(await ripgrepIgnoreFile(ws)).toBeUndefined();
    const argv = buildRipgrepArgs({
      pattern: 'x',
      includePattern: '**/*',
      contextBefore: 0,
      contextAfter: 0,
      multiline: false,
      relativePath: '',
    });
    for (const flag of [
      '--no-ignore-vcs',
      '--no-ignore-dot',
      '--no-ignore-parent',
      '--ignore-file',
    ]) {
      expect(argv).not.toContain(flag);
    }
  });
});
