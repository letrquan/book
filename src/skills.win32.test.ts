import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #579: on Windows, skill discovery must not open a network share a repository named with a
 * committed link: resolving `\\host\share` sends an SMB request (and the user's NTLM credentials)
 * to `host`. A project skill root, a skill directory and a SKILL.md can each be such a link. Run on
 * any host: the platform is stubbed, discovery runs over real directories, and the UNC guard sees
 * the links the map below declares, keyed by their Windows spelling. The `fs` calls that would
 * resolve or read are spied, so a call that reached a share is an assertion failure, and the local
 * skill beside them is the control.
 */
const fake = vi.hoisted(() => {
  // Read before any test stubs the platform.
  const posixHost = process.platform !== 'win32';
  return {
    /** A path's Windows spelling, to the target the guard is told it links to. */
    links: new Map<string, string>(),
    /**
     * The host's own spelling of a path the guard asks about. On a POSIX host it asks about
     * `\tmp\…`, the Windows spelling of `/tmp/…`; on Windows the two are the same.
     */
    onHost: (path: string) =>
      posixHost && /^\\(?!\\)/.test(path) ? path.replace(/\\/g, '/') : path,
  };
});

async function fsWithFakeLinks(importOriginal: () => Promise<typeof import('fs')>) {
  const actual = await importOriginal();
  const stats = (link: boolean) => ({
    isSymbolicLink: () => link,
    isDirectory: () => false,
    isFile: () => false,
  });
  return {
    ...actual,
    lstatSync: vi.fn((path: string) =>
      fake.links.has(path) ? stats(true) : actual.lstatSync(fake.onHost(path)),
    ),
    readlinkSync: vi.fn(
      (path: string) => fake.links.get(path) ?? actual.readlinkSync(fake.onHost(path)),
    ),
    existsSync: vi.fn(actual.existsSync),
    statSync: vi.fn(actual.statSync),
    readdirSync: vi.fn(actual.readdirSync),
    openSync: vi.fn(actual.openSync),
    readFileSync: vi.fn(actual.readFileSync),
    realpathSync: Object.assign(vi.fn(actual.realpathSync), {
      native: vi.fn(actual.realpathSync.native),
    }),
  };
}

// `skills.ts` reads through `node:fs` and the guard through `fs`: both see the same fake.
vi.mock('fs', (importOriginal) => fsWithFakeLinks(importOriginal));
vi.mock('node:fs', (importOriginal) => fsWithFakeLinks(importOriginal));

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { existsSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'os';
import { join, win32 } from 'path';
import { SkillRegistry } from './skill-registry.js';
import { discoverSkills, loadSkillBody, skillRoots } from './skills.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const windows = (path: string) => win32.resolve(path);

const spies = () => [
  existsSync,
  statSync,
  readdirSync,
  openSync,
  readFileSync,
  realpathSync,
  realpathSync.native,
];

/** The paths a spied `fs` call was handed, in their Windows spelling. */
function calledWith(spy: unknown): string[] {
  return (spy as { mock: { calls: unknown[][] } }).mock.calls.map(([path]) =>
    windows(String(path)),
  );
}

const touches = (spy: unknown, path: string) =>
  calledWith(spy).some(
    (called) => called === windows(path) || called.startsWith(`${windows(path)}\\`),
  );

function writeSkill(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: The ${name} skill`, '---', 'Body'].join('\n'),
  );
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'book-unc-skills-'));
  fake.links.clear();
  for (const spy of spies()) vi.mocked(spy).mockClear();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  rmSync(tmp, { recursive: true, force: true });
});

describe('skill discovery on Windows with UNC links (#579)', () => {
  it('neither resolves nor reads a project root, skill or SKILL.md that links to a share', () => {
    const home = join(tmp, 'home');
    const ws = join(tmp, 'ws');
    // A user root that exists, so project roots are compared with it by real path.
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });

    const claudeRoot = join(ws, '.claude', 'skills');
    const bookRoot = join(ws, '.book', 'skills');
    writeSkill(join(claudeRoot, 'shared'), 'shared');
    writeSkill(join(bookRoot, 'evil'), 'evil');
    writeSkill(join(bookRoot, 'trap'), 'trap');
    writeSkill(join(bookRoot, 'good'), 'good');
    // A resource link: `collectResources` lstats it and leaves it out, so it is never followed.
    mkdirSync(join(tmp, 'elsewhere'));
    writeFileSync(join(tmp, 'elsewhere', 'note.md'), 'note');
    symlinkSync(join(tmp, 'elsewhere'), join(bookRoot, 'good', 'assets'), 'junction');

    fake.links.set(windows(claudeRoot), '\\\\attacker\\share\\skills');
    fake.links.set(windows(join(bookRoot, 'evil')), '\\\\attacker\\share\\evil');
    fake.links.set(windows(join(bookRoot, 'trap', 'SKILL.md')), '\\\\attacker\\share\\SKILL.md');
    fake.links.set(windows(join(bookRoot, 'good', 'assets')), '\\\\attacker\\share\\assets');

    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const options = {
      homeDir: home,
      bookHomeDir: join(home, '.book'),
      projectRoot: ws,
      includeOpenCode: false,
    };
    // Not a root at all, so nothing that takes its roots from here resolves it either.
    const roots = skillRoots(ws, options).map((root) => root.path);
    expect(roots).not.toContain(claudeRoot);
    expect(roots).toEqual(expect.arrayContaining([bookRoot, join(home, '.claude', 'skills')]));
    for (const spy of spies()) vi.mocked(spy).mockClear();

    const skills = discoverSkills(ws, {}, options);

    expect(skills.map((skill) => skill.name)).toEqual(['good']);
    expect(skills[0].issues.map((issue) => issue.code)).toContain('resource_symlink_ignored');

    for (const spy of spies()) {
      for (const refused of [
        claudeRoot,
        join(bookRoot, 'evil'),
        join(bookRoot, 'trap', 'SKILL.md'),
        join(bookRoot, 'good', 'assets'),
      ]) {
        expect(touches(spy, refused), refused).toBe(false);
      }
    }
    // The controls: discovery's calls go through the spied `fs`, so the guard is what kept them
    // off the links above.
    expect(touches(realpathSync.native, bookRoot)).toBe(true);
    expect(touches(readdirSync, bookRoot)).toBe(true);
    expect(touches(openSync, join(bookRoot, 'good', 'SKILL.md'))).toBe(true);
  });

  it('lists no project skills in a workspace reached through a link to a share', () => {
    const ws = join(tmp, 'ws');
    writeSkill(join(ws, '.book', 'skills', 'remote'), 'remote');
    fake.links.set(windows(ws), '\\\\attacker\\share\\proj');

    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    expect(discoverSkills(ws, {}, { includeUser: false, projectRoot: ws })).toEqual([]);
    for (const spy of spies()) expect(touches(spy, ws)).toBe(false);
  });

  // Spelled as UNC, the workspace only resolves as one through Windows' own `path`.
  it.runIf(process.platform === 'win32')('lists no project skills under a UNC workspace', () => {
    const ws = '\\\\attacker\\share\\proj';
    expect(discoverSkills(ws, {}, { includeUser: false, projectRoot: ws })).toEqual([]);
    for (const spy of spies()) {
      expect(calledWith(spy).filter((path) => path.includes('attacker'))).toEqual([]);
    }
  });
});

describe('skill discovery and loading on Windows with links to a network path', () => {
  it('finds the project root without probing a workspace reached through a link to a share', () => {
    const ws = join(tmp, 'ws');
    writeSkill(join(ws, '.book', 'skills', 'remote'), 'remote');
    fake.links.set(windows(ws), '\\\\host\\share\\proj');

    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    expect(discoverSkills(ws, {}, { includeUser: false })).toEqual([]);
    for (const spy of spies()) expect(touches(spy, ws)).toBe(false);
  });

  it('loads neither the body nor a resource of a skill whose directory became such a link', () => {
    const ws = join(tmp, 'ws');
    const dir = join(ws, '.book', 'skills', 'good');
    writeSkill(dir, 'good');
    writeFileSync(join(dir, 'notes.md'), 'notes');

    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const options = { includeUser: false, projectRoot: ws };
    const registry = new SkillRegistry(
      ws,
      { enabled: true, overrides: {}, execution: {} },
      options,
    );
    // The controls: both load while the directory is local.
    registry.activate('good', 'user', 0);
    expect(registry.readResource('good', 'notes.md').content).toBe('notes');
    const [skill] = discoverSkills(ws, {}, options);
    expect(loadSkillBody(skill).body).toBe('Body');

    fake.links.set(windows(dir), '\\\\host\\share\\good');
    for (const spy of spies()) vi.mocked(spy).mockClear();
    expect(() => loadSkillBody(skill)).toThrow(/network/);
    expect(() => registry.readResource('good', 'notes.md')).toThrow(/network/);
    for (const spy of spies()) expect(touches(spy, dir)).toBe(false);
  });
});
