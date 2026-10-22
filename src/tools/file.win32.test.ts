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
// Spied, so a test can tell whether a ripgrep process was started at all.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

import { spawn } from 'node:child_process';
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
  vi.mocked(spawn).mockClear();
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
});

/** Whether a ripgrep process was started. */
const startedRipgrep = () => vi.mocked(spawn).mock.calls.some(([command]) => command === 'rg');

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
    expect(result.content).toContain('share (UNC)');
    expectShareUntouched();
  });

  it('Grep does not follow a link to a share', async () => {
    const result = await grep.execute({ pattern: 'marker', include: '**/*.ts' }, ctx);
    expect(result.content).toContain('app.ts');
    expect(result.content).not.toContain('remote.ts');
    expectShareUntouched();
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

  it('gives one path_unreadable failure for a workspace that links to a share', async () => {
    links.map.set(windowsSpelling(ws), '\\\\host\\share\\ws');
    const results = [
      await glob.execute({ pattern: '**/*.ts' }, ctx),
      await grep.execute({ pattern: 'marker' }, ctx),
      await grep.execute({ pattern: 'marker', path: 'src' }, ctx),
      await grep.execute({ pattern: 'marker' }, { ...ctx, env: { BOOK_GREP_BACKEND: 'ripgrep' } }),
    ];
    for (const result of results) {
      expect(result.status).toBe('error');
      expect(result.structuredError?.code).toBe('path_unreadable');
    }
    for (const spy of [nodeFs.readdir, fs.readdir, fs.realpath]) {
      expect(touches(spy, ws)).toBe(false);
    }
    expect(startedRipgrep()).toBe(false);
  });

  it('searches a root the user configured on a share, but not a link below it to another', async () => {
    // An additionalDirectories entry and the memory directory, each reached as a share: the user
    // chose them, as Read serves them.
    const extra = join(tmp, 'extra');
    const memory = join(tmp, 'memory');
    for (const dir of [extra, memory]) {
      mkdirSync(dir);
      writeFileSync(join(dir, 'lib.ts'), 'const marker = 3;');
    }
    symlinkSync(join(tmp, 'share'), join(extra, 'away'), 'junction');
    links.map.set(windowsSpelling(extra), '\\\\nas\\data');
    links.map.set(windowsSpelling(memory), '\\\\nas\\home\\memory');
    links.map.set(windowsSpelling(join(extra, 'away')), '\\\\other\\share');
    const configured = { ...ctx, additionalRoots: [extra], memorySearchRoot: memory };

    for (const root of [extra, memory]) {
      const result = await grep.execute({ pattern: 'marker', path: root }, configured);
      expect(result.status, root).toBe('success');
      expect(result.content, root).toContain('lib.ts');
    }
    // A link found below the root, and a path the model names through it, lead elsewhere.
    expect(touches(fs.realpath, join(extra, 'away'))).toBe(false);
    const through = await grep.execute(
      { pattern: 'marker', path: join(extra, 'away') },
      configured,
    );
    expect(through.structuredError?.code).toBe('path_unreadable');
    // And without the configuration, the same root is refused.
    const unconfigured = await grep.execute({ pattern: 'marker', path: extra }, ctx);
    expect(unconfigured.status).toBe('error');
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
      expect(startedRipgrep()).toBe(false);
    } finally {
      lstat.mockImplementation(original);
    }
    // The control: without a cancel, the same search does start ripgrep.
    await grep.execute(
      { pattern: 'marker', include: '**/*.ts' },
      { ...ctx, env: { BOOK_GREP_BACKEND: 'ripgrep' } },
    );
    expect(startedRipgrep()).toBe(true);
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
