import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'http';
import { createServer as createNetServer } from 'net';
import { homedir, tmpdir } from 'os';
import { join, posix } from 'path';
import { fileURLToPath } from 'url';
import {
  BOOK_TEMP_PREFIXES,
  SANDBOX_EXEC_PATH,
  SEATBELT_SYSTEM_READ_ROOTS,
  renderSeatbeltProfile,
  seatbeltExecution,
  type SeatbeltOperation,
  type SeatbeltPolicy,
} from './sandbox-seatbelt.js';
import {
  buildSeatbeltExecution,
  buildSeatbeltPolicy,
  describeSandboxBackend,
  realSandboxHost,
  sandboxBackendAvailable,
  sandboxBackendFor,
  seatbeltTempRoots,
  type SandboxHost,
} from './sandbox.js';
import { DEFAULT_SETTINGS, type ResolvedSettings } from './settings.js';

type SandboxTestOverrides = Partial<Omit<ResolvedSettings['sandbox'], 'filesystem' | 'network'>> & {
  filesystem?: Partial<ResolvedSettings['sandbox']['filesystem']>;
  network?: Partial<ResolvedSettings['sandbox']['network']>;
};

function sandboxSettings(overrides: SandboxTestOverrides = {}): ResolvedSettings['sandbox'] {
  const base = structuredClone(DEFAULT_SETTINGS.sandbox) as ResolvedSettings['sandbox'];
  return {
    ...base,
    enabled: true,
    ...overrides,
    filesystem: { ...base.filesystem, ...overrides.filesystem },
    network: { ...base.network, ...overrides.network },
  };
}

type MemoryNode = 'file' | 'dir' | { link: string } | { text: string };

const isLink = (node: MemoryNode | undefined): node is { link: string } =>
  typeof node === 'object' && 'link' in node;
const isFile = (node: MemoryNode | undefined): boolean =>
  node === 'file' || (typeof node === 'object' && 'text' in node);
const textOf = (node: MemoryNode | undefined): string =>
  typeof node === 'object' && 'text' in node ? node.text : '';

/**
 * An in-memory POSIX filesystem, so the policy is pinned on every OS — the
 * unit suite runs on Windows CI, where no path here exists — and so a path can
 * be reached through a symlink the way macOS reaches `/var` and `/tmp`. Every
 * ancestor of a listed path is a directory.
 */
function memoryHost(tree: Record<string, MemoryNode>, home = '/Users/book'): SandboxHost {
  const nodes = new Map<string, MemoryNode>(Object.entries(tree));
  for (const path of [...nodes.keys()]) {
    for (let parent = posix.dirname(path); !nodes.has(parent); parent = posix.dirname(parent)) {
      nodes.set(parent, 'dir');
      if (parent === '/') break;
    }
  }
  nodes.set('/', 'dir');
  const realpath = (path: string): string | null => {
    let current = '/';
    for (const part of posix.resolve(path).split('/').filter(Boolean)) {
      const next = posix.join(current, part);
      const node = nodes.get(next);
      if (node === undefined) return null;
      if (isLink(node)) {
        const resolved = realpath(posix.resolve(current, node.link));
        if (resolved === null) return null;
        current = resolved;
      } else {
        current = next;
      }
    }
    return current;
  };
  const kind = (path: string): MemoryNode | undefined => {
    const real = realpath(path);
    return real === null ? undefined : nodes.get(real);
  };
  /** The node at `path` without following its final component. */
  const own = (path: string): MemoryNode | undefined => {
    const absolute = posix.resolve(path);
    const parent = realpath(posix.dirname(absolute));
    return parent === null ? undefined : nodes.get(posix.join(parent, posix.basename(absolute)));
  };
  return {
    path: posix,
    exists: (path) => realpath(path) !== null,
    isDirectory: (path) => kind(path) === 'dir',
    readFile: (path) => (isFile(own(path)) ? textOf(own(path)) : null),
    fileSize: (path) => (isFile(own(path)) ? textOf(own(path)).length : null),
    readDir: (path) => {
      const real = realpath(path);
      if (real === null || nodes.get(real) !== 'dir') return [];
      return [...nodes.keys()]
        .filter((key) => key !== real && posix.dirname(key) === real)
        .map((key) => posix.basename(key));
    },
    entryKind: (path) => {
      const node = own(path);
      if (node === undefined) return null;
      if (isLink(node)) return 'symlink';
      return node === 'dir' ? 'directory' : 'file';
    },
    linkTarget: (path) => {
      const node = own(path);
      return isLink(node) ? node.link : null;
    },
    realpath,
    homedir: () => home,
  };
}

type FileOperation =
  Exclude<SeatbeltOperation, 'file-read*' | 'file-write*'> | 'file-read-data' | 'file-write-data';

/**
 * What Seatbelt decides for one operation on one canonical path, as observed
 * on macOS 26 (sandbox-probe runs for #616): the last matching rule wins, except
 * that a rule naming the operation itself beats a wildcard rule whatever their
 * order. The fixed preamble contributes the system read roots.
 */
function decide(policy: SeatbeltPolicy, operation: FileOperation, path: string): 'allow' | 'deny' {
  const bookTemp = new RegExp(`/(${BOOK_TEMP_PREFIXES.join('|')})[^/]*(/|$)`);
  const under = (root: string): boolean => path === root || path.startsWith(`${root}/`);
  let wildcard: 'allow' | 'deny' | undefined =
    operation.startsWith('file-read') && (path === '/' || SEATBELT_SYSTEM_READ_ROOTS.some(under))
      ? 'allow'
      : undefined;
  let specific: 'allow' | 'deny' | undefined;
  for (const rule of policy.rules) {
    const hit = rule.filters.some(
      (filter) =>
        (filter.match === 'literal' ? path === filter.path : under(filter.path)) &&
        (!rule.bookTempEntries || bookTemp.test(path)),
    );
    if (!hit) continue;
    for (const ruleOperation of rule.operations) {
      if (ruleOperation === operation) specific = rule.action;
      else if (ruleOperation.endsWith('*') && operation.startsWith(ruleOperation.slice(0, -1)))
        wildcard = rule.action;
    }
  }
  return specific ?? wildcard ?? 'deny';
}

const canRead = (policy: SeatbeltPolicy, path: string): boolean =>
  decide(policy, 'file-read-data', path) === 'allow';
const canWrite = (policy: SeatbeltPolicy, path: string): boolean =>
  decide(policy, 'file-write-data', path) === 'allow';
const canCreate = (policy: SeatbeltPolicy, path: string): boolean =>
  decide(policy, 'file-write-create', path) === 'allow';
const canRemove = (policy: SeatbeltPolicy, path: string): boolean =>
  decide(policy, 'file-write-unlink', path) === 'allow';

const HOME = '/Users/book';
const WS = `${HOME}/work`;
const USER_TEMP = '/private/var/folders/xy/abc/T';
const TEMP_ROOTS = [USER_TEMP, '/private/tmp'];

/** A plain repository with both workspace settings files, under a home with credentials. */
function repoTree(extra: Record<string, MemoryNode> = {}): Record<string, MemoryNode> {
  return {
    [`${WS}/src/index.ts`]: 'file',
    [`${WS}/.git/HEAD`]: 'file',
    [`${WS}/.git/objects`]: 'dir',
    [`${WS}/.git/hooks/pre-commit`]: 'file',
    [`${WS}/.git/config`]: 'file',
    [`${WS}/.book/settings.json`]: 'file',
    [`${WS}/.book/settings.local.json`]: 'file',
    [`${HOME}/.book/settings.json`]: 'file',
    [`${HOME}/.ssh/id_ed25519`]: 'file',
    [`${USER_TEMP}/book-rewind-a1/snapshots/1`]: 'file',
    '/private/tmp': 'dir',
    '/tmp': { link: '/private/tmp' },
    '/var': { link: '/private/var' },
    ...extra,
  };
}

function policyFor(
  overrides: SandboxTestOverrides = {},
  tree: Record<string, MemoryNode> = repoTree(),
  workspace = WS,
): SeatbeltPolicy {
  return buildSeatbeltPolicy(
    workspace,
    sandboxSettings(overrides),
    memoryHost(tree),
    undefined,
    TEMP_ROOTS,
  );
}

describe('buildSeatbeltPolicy', () => {
  it('writes the workspace and the temp roots, and nothing else', () => {
    const policy = policyFor();

    expect(canWrite(policy, `${WS}/src/index.ts`)).toBe(true);
    expect(canCreate(policy, `${WS}/src/new.ts`)).toBe(true);
    expect(canWrite(policy, `${USER_TEMP}/tmp.abc`)).toBe(true);
    expect(canWrite(policy, '/private/tmp/x')).toBe(true);
    expect(canWrite(policy, `${HOME}/other`)).toBe(false);
    expect(canWrite(policy, `${HOME}/workspace-sibling`)).toBe(false);
    expect(canWrite(policy, '/usr/local/bin/x')).toBe(false);
  });

  it('reads what bubblewrap mounts: system roots and the workspace, not the home directory', () => {
    const policy = policyFor();

    expect(canRead(policy, '/usr/bin/git')).toBe(true);
    expect(canRead(policy, '/System/Library/dyld/x')).toBe(true);
    expect(canRead(policy, `${WS}/src/index.ts`)).toBe(true);
    // The provider key and the user's credentials stay out of reach.
    expect(canRead(policy, `${HOME}/.book/settings.json`)).toBe(false);
    expect(canRead(policy, `${HOME}/.ssh/id_ed25519`)).toBe(false);
    // A path into the workspace still resolves: its ancestors' metadata only.
    expect(decide(policy, 'file-read-metadata', HOME)).toBe('allow');
    expect(canRead(policy, HOME)).toBe(false);
    expect(decide(policy, 'file-read-metadata', `${HOME}/.ssh`)).toBe('deny');
  });

  it('keeps the workspace control files read-only and the local settings unreadable', () => {
    const policy = policyFor();

    expect(canWrite(policy, `${WS}/.git/hooks/pre-commit`)).toBe(false);
    expect(canCreate(policy, `${WS}/.git/hooks/post-checkout`)).toBe(false);
    expect(canWrite(policy, `${WS}/.git/config`)).toBe(false);
    expect(canWrite(policy, `${WS}/.git/index`)).toBe(false);
    expect(canWrite(policy, `${WS}/.book/settings.json`)).toBe(false);
    expect(canRead(policy, `${WS}/.book/settings.json`)).toBe(true);
    expect(canRead(policy, `${WS}/.book/settings.local.json`)).toBe(false);
    expect(canWrite(policy, `${WS}/.book/settings.local.json`)).toBe(false);
  });

  it('denies an absent .book by path, so the command cannot create one', () => {
    const tree = repoTree();
    delete tree[`${WS}/.book/settings.json`];
    delete tree[`${WS}/.book/settings.local.json`];
    const policy = policyFor({}, tree);

    expect(canCreate(policy, `${WS}/.book`)).toBe(false);
    expect(canCreate(policy, `${WS}/.book/settings.local.json`)).toBe(false);
  });

  it('lets git write again only with allowGitWrites, keeping hooks and config read-only', () => {
    const policy = policyFor({ filesystem: { allowGitWrites: true } });

    expect(canWrite(policy, `${WS}/.git/index`)).toBe(true);
    expect(canWrite(policy, `${WS}/.git/hooks/pre-commit`)).toBe(false);
    expect(canWrite(policy, `${WS}/.git/config`)).toBe(false);
    // The top-level git dir is pinned, as bubblewrap pins it in this mode.
    expect(canRemove(policy, `${WS}/.git`)).toBe(false);
  });

  it('reopens what an allowWrite opt-in names, and only that', () => {
    const policy = policyFor({ filesystem: { allowWrite: [`${WS}/.git/hooks`] } });

    expect(canWrite(policy, `${WS}/.git/hooks/pre-commit`)).toBe(true);
    expect(canWrite(policy, `${WS}/.git/config`)).toBe(false);
  });

  it('keeps settings.local.json hidden under an opt-in for .book, and .book in place', () => {
    const policy = policyFor({ filesystem: { allowWrite: [`${WS}/.book`] } });

    expect(canWrite(policy, `${WS}/.book/settings.json`)).toBe(true);
    expect(canRead(policy, `${WS}/.book/settings.local.json`)).toBe(false);
    expect(canWrite(policy, `${WS}/.book/settings.local.json`)).toBe(false);
    // Renaming .book would carry the hidden file to a path nothing hides.
    expect(canRemove(policy, `${WS}/.book`)).toBe(false);
  });

  it("keeps Book's own temp entries out of reach in a writable temp root", () => {
    const policy = policyFor();

    expect(canRead(policy, `${USER_TEMP}/book-rewind-a1/snapshots/1`)).toBe(false);
    expect(canWrite(policy, `${USER_TEMP}/book-rewind-a1/snapshots/1`)).toBe(false);
    expect(canCreate(policy, `${USER_TEMP}/book-index-new`)).toBe(false);
    expect(canRemove(policy, `${USER_TEMP}/book-rewind-a1`)).toBe(false);
    expect(canWrite(policy, `${USER_TEMP}/book-sandbox-test/x`)).toBe(true);
  });

  it('writes a workspace inside a temp root whatever it is called', () => {
    const workspace = `${USER_TEMP}/book-rewind-like-ws`;
    const policy = policyFor({}, repoTree({ [`${workspace}/a`]: 'file' }), workspace);

    expect(canWrite(policy, `${workspace}/a`)).toBe(true);
  });

  // The same three shapes the bubblewrap builder is pinned for (#625).
  it.each([`${WS}/.book`, WS, `${WS}/.book/settings.local.json`])(
    'keeps settings.local.json masked under a denyWrite entry for %s',
    (denied) => {
      const policy = policyFor({ filesystem: { denyWrite: [denied] } });

      expect(canRead(policy, `${WS}/.book/settings.json`)).toBe(true);
      expect(canRead(policy, `${WS}/.book/settings.local.json`)).toBe(false);
      expect(canWrite(policy, `${WS}/.book/settings.local.json`)).toBe(false);
    },
  );

  it("keeps Book's home unreadable under a denyWrite entry above it", () => {
    const policy = buildSeatbeltPolicy(
      WS,
      sandboxSettings({ filesystem: { denyWrite: ['~'] } }),
      memoryHost(repoTree()),
      undefined,
      TEMP_ROOTS,
      `${HOME}/.book`,
    );

    expect(canRead(policy, `${HOME}/.ssh/id_ed25519`)).toBe(true);
    expect(canRead(policy, `${HOME}/.book/settings.json`)).toBe(false);
  });

  it('applies denyWrite as a readable, read-only path and denyRead as an unreadable one', () => {
    const tree = repoTree({
      [`${HOME}/.cargo/bin/rg`]: 'file',
      [`${WS}/conf/secrets/key`]: 'file',
    });
    const policy = policyFor(
      { filesystem: { denyWrite: ['~/.cargo'], denyRead: [`${WS}/conf/secrets`] } },
      tree,
    );

    expect(canRead(policy, `${HOME}/.cargo/bin/rg`)).toBe(true);
    expect(canWrite(policy, `${HOME}/.cargo/bin/rg`)).toBe(false);
    expect(canRead(policy, `${WS}/conf/secrets/key`)).toBe(false);
    expect(canWrite(policy, `${WS}/conf/secrets/key`)).toBe(false);
    // Moving the parent away would carry the secret to an unmasked path.
    expect(canRemove(policy, `${WS}/conf`)).toBe(false);
  });

  it('pins the workspace root and every directory above it', () => {
    const workspace = `${USER_TEMP}/projects/ws`;
    const policy = policyFor({}, repoTree({ [`${workspace}/a`]: 'file' }), workspace);

    expect(canRemove(policy, workspace)).toBe(false);
    expect(canCreate(policy, workspace)).toBe(false);
    // Inside a writable temp root, moving the parent would move the workspace.
    expect(canRemove(policy, `${USER_TEMP}/projects`)).toBe(false);
    expect(canRemove(policy, `${workspace}/a`)).toBe(true);
  });

  it('keeps the directories above a read-only path in place', () => {
    const tree = repoTree({ [`${WS}/a/b/c/file`]: 'file' });
    const policy = policyFor({ filesystem: { denyWrite: [`${WS}/a/b/c`] } }, tree);

    expect(canRemove(policy, `${WS}/a/b`)).toBe(false);
    expect(canRemove(policy, `${WS}/a`)).toBe(false);
    // Ordinary files beside it are unaffected.
    expect(canCreate(policy, `${WS}/a/b/other`)).toBe(true);
    expect(canRemove(policy, `${WS}/src/index.ts`)).toBe(true);
  });

  it('lets a work tree be removed with allowGitWrites, but nothing take its place', () => {
    // A submodule work tree: its `.git` is a pointer file into the parent's git dir.
    const tree = repoTree({
      [`${WS}/sub/.git`]: { text: 'gitdir: ../.git/modules/sub\n' },
      [`${WS}/sub/a.ts`]: 'file',
      [`${WS}/.git/modules/sub/HEAD`]: 'file',
      [`${WS}/.git/modules/sub/objects`]: 'dir',
    });
    const readOnly = policyFor({}, tree);
    const writable = policyFor({ filesystem: { allowGitWrites: true } }, tree);

    expect(canWrite(readOnly, `${WS}/sub/.git`)).toBe(false);
    expect(canWrite(writable, `${WS}/sub/.git`)).toBe(false);
    // Read-only mode pins the work tree, as bubblewrap does.
    expect(canRemove(readOnly, `${WS}/sub`)).toBe(false);
    // allowGitWrites leaves it removable, as bubblewrap does for `git worktree
    // remove`, but a removed one cannot come back as a symlink to another tree.
    expect(canRemove(writable, `${WS}/sub`)).toBe(true);
    expect(canCreate(writable, `${WS}/sub`)).toBe(false);
  });

  it('names every path canonically, as Seatbelt matches the resolved one', () => {
    const workspace = '/var/folders/xy/abc/T/ws';
    const tree = repoTree({ [`${USER_TEMP}/ws/a`]: 'file' });
    const policy = policyFor({}, tree, workspace);
    const paths = policy.rules.flatMap((rule) => rule.filters.map((filter) => filter.path));

    expect(paths).toContain(`${USER_TEMP}/ws`);
    expect(paths.some((path) => path.startsWith('/var/'))).toBe(false);
    expect(canWrite(policy, `${USER_TEMP}/ws/a`)).toBe(true);
  });

  describe("Book's own home", () => {
    const bookHomePolicy = (
      bookHome: string,
      tree: Record<string, MemoryNode>,
      workspace = WS,
    ): SeatbeltPolicy =>
      buildSeatbeltPolicy(
        workspace,
        sandboxSettings(),
        memoryHost(tree),
        undefined,
        TEMP_ROOTS,
        bookHome,
      );

    it('is unreadable and unwritable even inside a writable temp root', () => {
      const bookHome = `${USER_TEMP}/tmp.bookhome`;
      const policy = bookHomePolicy(bookHome, repoTree({ [`${bookHome}/settings.json`]: 'file' }));

      expect(canRead(policy, `${bookHome}/settings.json`)).toBe(false);
      expect(canWrite(policy, `${bookHome}/settings.json`)).toBe(false);
      expect(canRemove(policy, bookHome)).toBe(false);
      expect(canWrite(policy, `${USER_TEMP}/tmp.other`)).toBe(true);
    });

    it("leaves a managed agent's worktree inside it writable, and the rest of it denied", () => {
      const bookHome = `${HOME}/.book`;
      const worktree = `${bookHome}/worktrees/a1`;
      const policy = bookHomePolicy(
        bookHome,
        repoTree({ [`${worktree}/src/a.ts`]: 'file' }),
        worktree,
      );

      expect(canWrite(policy, `${worktree}/src/a.ts`)).toBe(true);
      expect(canRead(policy, `${bookHome}/settings.json`)).toBe(false);
      expect(canWrite(policy, `${bookHome}/worktrees/other/x`)).toBe(false);
    });

    it('stays unreadable when it sits inside the workspace', () => {
      const bookHome = `${WS}/state/.bookhome`;
      const policy = bookHomePolicy(bookHome, repoTree({ [`${bookHome}/settings.json`]: 'file' }));

      expect(canRead(policy, `${bookHome}/settings.json`)).toBe(false);
      expect(canWrite(policy, `${bookHome}/settings.json`)).toBe(false);
      // Moving its parent would carry it out from under the deny.
      expect(canRemove(policy, `${WS}/state`)).toBe(false);
    });
  });

  it('shares the host network with no domain rule, and fails closed to none with one', () => {
    expect(policyFor().network).toBe('host');
    expect(policyFor().unixSocketRoots).toContain(WS);
    expect(policyFor({ network: { allowedDomains: ['github.com'] } }).network).toBe('none');
    expect(policyFor({ network: { deniedDomains: ['evil.test'] } }).network).toBe('none');
  });
});

describe('renderSeatbeltProfile', () => {
  const policy = (paths: string[]): SeatbeltPolicy => ({
    rules: [
      {
        action: 'allow',
        operations: ['file-read*', 'file-write*'],
        filters: paths.map((path) => ({ match: 'subpath', path })),
      },
    ],
    network: 'host',
    unixSocketRoots: paths,
    unixSocketDenied: [],
  });

  it('passes every path as a parameter and never splices one into the profile', () => {
    const hostile = '/w") (allow file-write* (subpath "/';
    const newline = '/new\nline") (allow default)';
    const { profile, parameters } = renderSeatbeltProfile(policy([hostile, newline]));

    expect(profile).not.toContain('/w")');
    expect(profile).not.toContain('new\nline');
    expect(profile).not.toContain('(allow default)');
    expect(parameters).toEqual(['-D', `P0=${hostile}`, '-D', `P1=${newline}`]);
    expect(profile).toContain('(subpath (param "P0"))');
    // Every parenthesis in the text is the renderer's own, so they balance.
    expect(profile.split('(').length).toBe(profile.split(')').length);
  });

  it('gives a repeated path one parameter', () => {
    const { parameters } = renderSeatbeltProfile(policy(['/a', '/a']));

    expect(parameters).toEqual(['-D', 'P0=/a']);
  });

  it('refuses a relative path, which would match nothing while looking protected', () => {
    expect(() => renderSeatbeltProfile(policy(['relative/path']))).toThrow(/not absolute/);
  });

  it('refuses a NUL byte', () => {
    expect(() => renderSeatbeltProfile(policy(['/a\0b']))).toThrow(/NUL/);
  });

  it('starts from deny default and keeps the rule order', () => {
    const { profile } = renderSeatbeltProfile({
      rules: [
        {
          action: 'deny',
          operations: ['file-write*'],
          filters: [{ match: 'subpath', path: '/a' }],
        },
        { action: 'allow', operations: ['file-write*'], filters: [] },
        {
          action: 'allow',
          operations: ['file-write*'],
          filters: [{ match: 'literal', path: '/b' }],
        },
      ],
      network: 'none',
      unixSocketRoots: [],
      unixSocketDenied: [],
    });
    const lines = profile.split('\n');

    expect(lines[0]).toBe('(version 1)');
    expect(lines[1]).toBe('(deny default)');
    const deny = lines.indexOf('(deny file-write* (subpath (param "P0")))');
    const allow = lines.indexOf('(allow file-write* (literal (param "P1")))');
    expect(deny).toBeGreaterThan(1);
    expect(allow).toBeGreaterThan(deny);
    // A rule with no paths is not rendered as one that matches everything.
    expect(lines).not.toContain('(allow file-write* )');
    expect(lines).not.toContain('(allow file-write*)');
  });

  it('allows no network at all when the policy is none', () => {
    const { profile } = renderSeatbeltProfile({ ...policy(['/w']), network: 'none' });

    expect(profile).not.toMatch(/\(allow network/);
  });

  it('shares the network but refuses unix sockets outside the named roots', () => {
    const { profile } = renderSeatbeltProfile(policy(['/w']));
    const lines = profile.split('\n');
    const allowAll = lines.indexOf('(allow network*)');
    const denyUnix = lines.indexOf(
      '(deny network-outbound (remote unix-socket (path-regex #"^/")))',
    );

    expect(allowAll).toBeGreaterThan(-1);
    expect(denyUnix).toBeGreaterThan(allowAll);
    expect(
      lines.indexOf('(allow network-outbound (remote unix-socket (subpath (param "P0"))))'),
    ).toBeGreaterThan(denyUnix);
  });

  it("narrows a temp-root rule to Book's own entries", () => {
    const { profile } = renderSeatbeltProfile({
      rules: [
        {
          action: 'deny',
          operations: ['file-read*'],
          filters: [{ match: 'subpath', path: '/t' }],
          bookTempEntries: true,
        },
      ],
      network: 'none',
      unixSocketRoots: [],
      unixSocketDenied: [],
    });

    expect(profile).toContain(
      '(deny file-read* (require-all (subpath (param "P0")) (regex #"/(book-rewind-|book-index-|book-config-preflight-)[^/]*(/|$)")))',
    );
  });
});

describe('BOOK_TEMP_PREFIXES', () => {
  it('is spelled so it needs no regex escaping', () => {
    for (const prefix of BOOK_TEMP_PREFIXES) expect(prefix).toMatch(/^[a-z-]+$/);
  });

  /**
   * A temp entry Book trusts and this list does not name is one a sandboxed
   * command on macOS can rewrite. Production code that adds a `mkdtemp` under
   * `tmpdir()` has to add its prefix here.
   */
  it('names every prefix production code creates under tmpdir()', () => {
    const sourceRoot = fileURLToPath(new URL('.', import.meta.url));
    const prefixes = new Set<string>();
    for (const entry of readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' })) {
      const file = entry.split('\\').join('/');
      if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
      if (file.startsWith('test/') || file.includes('__benchmarks__/')) continue;
      const text = readFileSync(join(sourceRoot, entry), 'utf8');
      // Whatever the root expression is (`tmpdir()`, a `temporaryRoot` defaulting to
      // it): a `book-` prefix handed to mkdtemp is one this list has to name.
      for (const match of text.matchAll(/mkdtemp(?:Sync)?\(\s*join\([^']*'(book-[^']*)'/g)) {
        prefixes.add(match[1]);
      }
    }

    expect([...prefixes].sort()).toEqual([...BOOK_TEMP_PREFIXES].sort());
  });
});

describe('seatbeltExecution', () => {
  it('runs the command as one argument to the shell inside the sandbox', () => {
    const command = 'echo hi; touch /tmp/escaped && curl $(whoami).example.com';
    const exec = seatbeltExecution(
      SANDBOX_EXEC_PATH,
      { rules: [], network: 'host', unixSocketRoots: ['/w'], unixSocketDenied: [] },
      command,
    );

    expect(exec.file).toBe('/usr/bin/sandbox-exec');
    expect(exec.args.at(-1)).toBe(command);
    expect(exec.args.filter((arg) => arg.includes('whoami'))).toEqual([command]);
    expect(exec.args.slice(-6)).toEqual([
      '--',
      '/usr/bin/env',
      'GIT_CONFIG_GLOBAL=/dev/null',
      '/bin/bash',
      '-c',
      command,
    ]);
    const profileAt = exec.args.indexOf('-p');
    expect(exec.args.slice(0, profileAt)).toEqual(['-D', 'P0=/w']);
    expect(exec.args[profileAt + 2]).toBe('--');
  });

  it('builds from the workspace policy end to end', () => {
    const exec = buildSeatbeltExecution(
      SANDBOX_EXEC_PATH,
      'true',
      WS,
      sandboxSettings(),
      memoryHost(repoTree()),
      undefined,
      TEMP_ROOTS,
    );

    const profileAt = exec.args.indexOf('-p');
    const parameters = exec.args.slice(0, profileAt);
    expect(parameters.filter((_, index) => index % 2 === 0).every((flag) => flag === '-D')).toBe(
      true,
    );
    expect(parameters.some((arg) => arg.endsWith(`=${WS}`))).toBe(true);
    expect(exec.args[profileAt + 1]).not.toContain(WS);
  });
});

describe('sandbox backend selection', () => {
  it.each([
    ['darwin' as const, 'seatbelt'],
    ['linux' as const, 'bubblewrap'],
    ['freebsd' as const, 'bubblewrap'],
    ['win32' as const, null],
  ])('uses the right backend on %s', (os, backend) => {
    expect(sandboxBackendFor(os)).toBe(backend);
  });

  it('names the backend for book doctor', () => {
    expect(describeSandboxBackend('darwin')).toContain('Seatbelt');
    expect(describeSandboxBackend('darwin')).toContain('/usr/bin/sandbox-exec');
    expect(describeSandboxBackend('linux')).toBe('bubblewrap (bwrap)');
    expect(describeSandboxBackend('win32')).toMatch(/^none/);
  });

  it('drops a temp root that is or holds the home directory', () => {
    const roots = seatbeltTempRoots(
      memoryHost(
        { '/private/tmp/u/x': 'file', '/tmp': { link: '/private/tmp' } },
        '/private/tmp/u',
      ),
    );

    expect(roots).not.toContain('/private/tmp');
  });

  it('canonicalises the temp roots and drops a duplicate', () => {
    const roots = seatbeltTempRoots(
      memoryHost({ '/private/tmp': 'dir', '/tmp': { link: '/private/tmp' } }),
    );

    expect(roots).toContain('/private/tmp');
    expect(roots).not.toContain('/tmp');
    expect(new Set(roots).size).toBe(roots.length);
  });
});

/**
 * The profile is only a claim; this is the claim under a real `sandbox-exec`.
 * It runs on the macOS CI job (`sandbox-macos`), and asserts the backend exists
 * rather than skipping without it, so a green run cannot be one that ran nothing.
 */
describe.skipIf(process.platform !== 'darwin')('the Seatbelt sandbox on a real Mac', () => {
  let workspace: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    // tmpdir() is under /var, a symlink: the policy must canonicalise it.
    workspace = mkdtempSync(join(tmpdir(), 'book-seatbelt-'));
    cleanup.push(workspace);
    execFileSync('git', ['init', '--quiet'], { cwd: workspace });
    mkdirSync(join(workspace, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(workspace, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    mkdirSync(join(workspace, '.book'));
    writeFileSync(join(workspace, '.book', 'settings.json'), '{}\n');
    writeFileSync(join(workspace, '.book', 'settings.local.json'), '{"apiKey":"secret"}\n');
  });
  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  /** A file in the home directory, which no sandboxed command may read or write. */
  function homePath(name: string): string {
    const path = join(homedir(), `.book-seatbelt-${process.pid}-${name}`);
    cleanup.push(path);
    return path;
  }

  async function sandboxedBash(
    command: string,
    overrides: SandboxTestOverrides = {},
    root = workspace,
  ): Promise<{ status: string; content: string }> {
    const { createDefaultRegistry } = await import('./tools/registry.js');
    // Refusing unsandboxed commands means a missing backend fails these tests
    // instead of running the command on the host and passing.
    const result = await createDefaultRegistry().execute(
      { id: 'c1', name: 'Bash', arguments: { command } },
      {
        workspaceRoot: root,
        env: {},
        sandbox: sandboxSettings({ allowUnsandboxedCommands: false, ...overrides }),
      },
    );
    return {
      status: result.status,
      content: `${result.content}\n${result.structuredError?.message ?? ''}`,
    };
  }

  it('runs on a host whose sandbox-exec is present', () => {
    expect(existsSync(SANDBOX_EXEC_PATH)).toBe(true);
    expect(sandboxBackendFor()).toBe('seatbelt');
    expect(sandboxBackendAvailable()).toBe(true);
  });

  it('writes an ordinary workspace file, marked as sandboxed', async () => {
    const result = await sandboxedBash(`printf 'ok' > notes.txt && echo done`);

    expect(result.status).toBe('success');
    expect(result.content).toContain('[sandboxed]');
    expect(readFileSync(join(workspace, 'notes.txt'), 'utf8')).toBe('ok');
  });

  it('cannot write outside the workspace', async () => {
    const target = homePath('escape');
    const result = await sandboxedBash(`printf pwned > '${target}'`);

    expect(result.status).not.toBe('success');
    expect(result.content).toMatch(/Operation not permitted/);
    expect(existsSync(target)).toBe(false);
  });

  it('cannot write a git hook, directly or through a hard link', async () => {
    const hook = join(workspace, '.git', 'hooks', 'pre-commit');
    const direct = await sandboxedBash(`printf evil >> .git/hooks/pre-commit`);
    const linked = await sandboxedBash(`ln .git/hooks/pre-commit h && printf evil >> h`);

    expect(direct.status).not.toBe('success');
    expect(linked.status).not.toBe('success');
    expect(readFileSync(hook, 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    expect(existsSync(join(workspace, 'h'))).toBe(false);
  });

  it('runs git read-only, and explains a git write the read-only git directory refuses', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'a\n');
    const status = await sandboxedBash('git status --short');
    const add = await sandboxedBash('git add a.txt');

    expect(status.status).toBe('success');
    expect(status.content).toContain('a.txt');
    expect(add.status).not.toBe('success');
    expect(add.content).toContain("the repository's git directory is read-only inside the sandbox");
  });

  it('cannot read the home directory or the local settings file', async () => {
    const secret = homePath('secret');
    writeFileSync(secret, 'home-secret\n');
    const home = await sandboxedBash(`cat '${secret}'`);
    const local = await sandboxedBash('cat .book/settings.local.json');
    const shared = await sandboxedBash('cat .book/settings.json');

    expect(home.status).not.toBe('success');
    expect(home.content).not.toContain('home-secret');
    expect(local.status).not.toBe('success');
    expect(local.content).not.toContain('secret');
    expect(shared.status).toBe('success');
  });

  it('cannot rename the git directory or the workspace root', async () => {
    const moved = `${workspace}-moved`;
    cleanup.push(moved);
    const gitDir = await sandboxedBash('mv .git .git-old');
    const root = await sandboxedBash(`mv '${workspace}' '${moved}'`);

    expect(gitDir.status).not.toBe('success');
    expect(root.status).not.toBe('success');
    expect(existsSync(join(workspace, '.git', 'HEAD'))).toBe(true);
    expect(existsSync(moved)).toBe(false);
  });

  it("keeps Book's own temp entries out of reach", async () => {
    const entry = mkdtempSync(join(tmpdir(), 'book-rewind-'));
    cleanup.push(entry);
    writeFileSync(join(entry, 'snapshot'), 'host\n');
    const read = await sandboxedBash(`cat '${join(entry, 'snapshot')}'`);
    const write = await sandboxedBash(`printf x > '${join(entry, 'snapshot')}'`);

    expect(read.status).not.toBe('success');
    expect(write.status).not.toBe('success');
    expect(readFileSync(join(entry, 'snapshot'), 'utf8')).toBe('host\n');
  });

  it('denies a case variant of a protected path, as APFS resolves it to the same one', async () => {
    const hook = join(workspace, '.git', 'hooks', 'pre-commit');
    rmSync(join(workspace, '.book'), { recursive: true, force: true });
    const existing = await sandboxedBash(`printf evil >> .GIT/HOOKS/pre-commit`);
    const absent = await sandboxedBash(`mkdir .BOOK && printf '{}' > .BOOK/settings.local.json`);

    expect(existing.status).not.toBe('success');
    expect(readFileSync(hook, 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    expect(absent.status).not.toBe('success');
    expect(existsSync(join(workspace, '.book'))).toBe(false);
  });

  it('keeps a core.hooksPath directory read-only, present or not yet created', async () => {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: workspace });
    const absent = await sandboxedBash(`mkdir -p .githooks && printf evil > .githooks/pre-commit`);
    mkdirSync(join(workspace, '.husky'));
    execFileSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: workspace });
    const present = await sandboxedBash(`printf evil > .husky/pre-commit`);

    expect(absent.status).not.toBe('success');
    expect(existsSync(join(workspace, '.githooks'))).toBe(false);
    expect(present.status).not.toBe('success');
    expect(existsSync(join(workspace, '.husky', 'pre-commit'))).toBe(false);
  });

  it('lets git write with allowGitWrites, keeping hooks and config read-only', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'a\n');
    const overrides = { filesystem: { allowGitWrites: true } };
    const commit = await sandboxedBash(
      'git add a.txt && git -c user.name=book -c user.email=book@example.test commit -qm a && echo committed',
      overrides,
    );
    const hook = await sandboxedBash('printf evil >> .git/hooks/pre-commit', overrides);
    const config = await sandboxedBash('git config core.hooksPath /tmp/evil', overrides);
    const moved = await sandboxedBash('mv .git .git-old', overrides);

    expect(commit.status).toBe('success');
    expect(commit.content).toContain('committed');
    expect(hook.status).not.toBe('success');
    expect(config.status).not.toBe('success');
    // `git config --get` exits 1 for a key that is not set: the write never landed.
    expect(spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: workspace }).status).toBe(
      1,
    );
    expect(moved.status).not.toBe('success');
  });

  it('reopens what an allowWrite opt-in names, and keeps the local settings hidden', async () => {
    const overrides = { filesystem: { allowWrite: [join(workspace, '.book')] } };
    const write = await sandboxedBash(`printf '{"a":1}' > .book/settings.json`, overrides);
    const read = await sandboxedBash('cat .book/settings.local.json', overrides);
    const move = await sandboxedBash('mv .book .book-moved', overrides);

    expect(write.status).toBe('success');
    expect(readFileSync(join(workspace, '.book', 'settings.json'), 'utf8')).toBe('{"a":1}');
    expect(read.status).not.toBe('success');
    expect(read.content).not.toContain('secret');
    expect(move.status).not.toBe('success');
  });

  it('keeps the local settings hidden under a denyWrite entry for .book', async () => {
    const result = await sandboxedBash('cat .book/settings.local.json', {
      filesystem: { denyWrite: [join(workspace, '.book')] },
    });

    expect(result.status).not.toBe('success');
    expect(result.content).not.toContain('secret');
  });

  it('applies denyWrite and denyRead, and keeps a denied path from being moved out', async () => {
    mkdirSync(join(workspace, 'vendor'));
    writeFileSync(join(workspace, 'vendor', 'lib.js'), 'lib\n');
    mkdirSync(join(workspace, 'conf', 'secrets'), { recursive: true });
    writeFileSync(join(workspace, 'conf', 'secrets', 'key'), 'denied-key\n');
    const overrides = {
      filesystem: {
        denyWrite: [join(workspace, 'vendor')],
        denyRead: [join(workspace, 'conf', 'secrets')],
      },
    };
    const readVendor = await sandboxedBash('cat vendor/lib.js', overrides);
    const writeVendor = await sandboxedBash('printf x > vendor/lib.js', overrides);
    const readKey = await sandboxedBash('cat conf/secrets/key', overrides);
    const moveOut = await sandboxedBash(
      'mv conf conf-moved && cat conf-moved/secrets/key',
      overrides,
    );

    expect(readVendor.content).toContain('lib');
    expect(writeVendor.status).not.toBe('success');
    expect(readFileSync(join(workspace, 'vendor', 'lib.js'), 'utf8')).toBe('lib\n');
    expect(readKey.content).not.toContain('denied-key');
    expect(moveOut.content).not.toContain('denied-key');
    expect(existsSync(join(workspace, 'conf', 'secrets', 'key'))).toBe(true);
  });

  it("keeps a linked worktree's .git pointer read-only", async () => {
    execFileSync(
      'git',
      [
        '-c',
        'user.name=b',
        '-c',
        'user.email=b@example.test',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
      {
        cwd: workspace,
      },
    );
    execFileSync('git', ['worktree', 'add', '-q', join(workspace, 'wt')], { cwd: workspace });
    const pointer = join(workspace, 'wt', '.git');
    const before = readFileSync(pointer, 'utf8');
    const result = await sandboxedBash(`printf 'gitdir: /tmp/evil\n' > wt/.git`);

    expect(result.status).not.toBe('success');
    expect(readFileSync(pointer, 'utf8')).toBe(before);
  });

  it('cannot move the directory that holds the workspace', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'book-seatbelt-parent-'));
    cleanup.push(parent, `${parent}-moved`);
    const nested = join(parent, 'ws');
    mkdirSync(nested);
    execFileSync('git', ['init', '--quiet'], { cwd: nested });
    const result = await sandboxedBash(`mv '${parent}' '${parent}-moved'`, {}, nested);

    expect(result.status).not.toBe('success');
    expect(existsSync(join(nested, '.git'))).toBe(true);
  });

  it('works in a workspace under the home directory, the usual Mac layout', async () => {
    const home = mkdtempSync(join(homedir(), '.book-seatbelt-ws-'));
    cleanup.push(home);
    execFileSync('git', ['init', '--quiet'], { cwd: home });
    mkdirSync(join(home, 'sub', 'deeper'), { recursive: true });
    const sibling = homePath('sibling');
    writeFileSync(sibling, 'sibling\n');

    const result = await sandboxedBash(
      `cd sub/deeper && pwd -P && git rev-parse --show-toplevel && git status --short && printf ok > ../../w.txt && cat '${sibling}'`,
      {},
      home,
    );

    expect(result.content).toContain(join('sub', 'deeper'));
    expect(result.content).toMatch(/Operation not permitted/);
    expect(result.content).not.toContain('sibling\n');
    expect(readFileSync(join(home, 'w.txt'), 'utf8')).toBe('ok');
  });

  it('cannot have launchd run a command outside the sandbox', async () => {
    const marker = homePath('launchd');
    const label = `book.seatbelt.test.${process.pid}`;
    try {
      await sandboxedBash(`/bin/launchctl submit -l ${label} -- /usr/bin/touch '${marker}'`);
      await new Promise((resolve) => setTimeout(resolve, 2000));

      expect(existsSync(marker)).toBe(false);
    } finally {
      spawnSync('/bin/launchctl', ['remove', label]);
    }
  });

  it('cannot reach the keychain, even through a keychain file it can read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-seatbelt-keychain-'));
    cleanup.push(dir);
    const keychain = join(dir, 'probe.keychain-db');
    const service = `book-seatbelt-${process.pid}`;
    execFileSync('/usr/bin/security', ['create-keychain', '-p', 'pw', keychain]);
    try {
      execFileSync('/usr/bin/security', ['unlock-keychain', '-p', 'pw', keychain]);
      // -A: any application may read it, so only the sandbox stands in the way.
      execFileSync('/usr/bin/security', [
        'add-generic-password',
        '-s',
        service,
        '-a',
        'book',
        '-w',
        'keychain-secret',
        '-A',
        keychain,
      ]);

      const result = await sandboxedBash(
        `/usr/bin/security find-generic-password -s ${service} -w '${keychain}'`,
      );

      expect(result.content).not.toContain('keychain-secret');
    } finally {
      spawnSync('/usr/bin/security', ['delete-keychain', keychain]);
    }
  });

  it('runs mktemp and /tmp writes, which macOS tools need', async () => {
    const result = await sandboxedBash(
      'f=$(mktemp) && printf x > "$f" && rm "$f" && touch /tmp/book-seatbelt-$$ && rm /tmp/book-seatbelt-$$ && echo tmp-ok',
    );

    expect(result.status).toBe('success');
    expect(result.content).toContain('tmp-ok');
  });

  describe('network', () => {
    let server: HttpServer;
    let port: number;

    beforeEach(async () => {
      server = createHttpServer((_request, response) => response.end('reached'));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as { port: number }).port;
    });
    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('shares the host network when no domain rule is declared', async () => {
      const result = await sandboxedBash(`/usr/bin/curl -sS -m 5 http://127.0.0.1:${port}/`);

      expect(result.status).toBe('success');
      expect(result.content).toContain('reached');
    });

    it('denies the network entirely when a domain rule is declared', async () => {
      const result = await sandboxedBash(`/usr/bin/curl -sS -m 5 http://127.0.0.1:${port}/`, {
        network: { allowedDomains: ['example.com'] },
      });

      expect(result.status).not.toBe('success');
      expect(result.content).not.toContain('reached');
    });

    it('refuses a unix socket outside the workspace', async () => {
      const socketPath = join(mkdtempSync(join(tmpdir(), 'book-seatbelt-sock-')), 's.sock');
      cleanup.push(join(socketPath, '..'));
      let connections = 0;
      const socketServer = createNetServer((socket) => {
        connections += 1;
        socket.end();
      });
      await new Promise<void>((resolve) => socketServer.listen(socketPath, resolve));
      try {
        const result = await sandboxedBash(
          `printf hi | /usr/bin/nc -U '${socketPath}' -w 2; echo "nc=$?"`,
        );

        expect(result.content).toMatch(/nc=[1-9]/);
        expect(connections).toBe(0);
      } finally {
        await new Promise<void>((resolve) => socketServer.close(() => resolve()));
      }
    });
  });

  it('treats a workspace path that reads as SBPL as a path', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'book-seatbelt-sbpl-'));
    cleanup.push(parent);
    const hostile = join(parent, 'ws") (allow file-write* (subpath "');
    mkdirSync(hostile);
    const target = homePath('sbpl');
    // The refused write first, so the command still exits 0 and is reported as sandboxed.
    const result = await sandboxedBash(
      `printf pwned > '${target}'; printf ok > inside.txt`,
      {},
      hostile,
    );

    expect(result.status).toBe('success');
    expect(result.content).toContain('[sandboxed]');
    expect(readFileSync(join(hostile, 'inside.txt'), 'utf8')).toBe('ok');
    expect(existsSync(target)).toBe(false);
  });

  it('does not run a command whose profile sandbox-exec rejects', () => {
    const marker = join(workspace, 'marker');
    const exec = buildSeatbeltExecution(
      SANDBOX_EXEC_PATH,
      `touch '${marker}'`,
      workspace,
      sandboxSettings(),
      realSandboxHost,
      undefined,
      seatbeltTempRoots(),
    );
    const args = [...exec.args];
    const profileAt = args.indexOf('-p') + 1;
    args[profileAt] = `${args[profileAt]}(allow file-write* (subpath`;

    const run = spawnSync(exec.file, args, { cwd: workspace, encoding: 'utf8' });

    expect(run.status).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});
