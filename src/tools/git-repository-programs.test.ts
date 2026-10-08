import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalConfigKey,
  defaultGitRunner,
  parseGitConfig,
  readRepositoryProgramPins,
  repositoryProgramPins,
  type GitConfigEntry,
  type RepositoryProgramRunner,
} from './git-repository-programs.js';

describe('repositoryProgramPins (pure)', () => {
  it('pins all four filter keys (empty / false) for a repository-local filter', () => {
    const entries: GitConfigEntry[] = [
      { scope: 'local', key: 'filter.lfs.clean', value: 'git-lfs clean -- %f' },
    ];
    const pins = repositoryProgramPins(entries);
    expect(pins).toEqual([
      '-c',
      'filter.lfs.clean=',
      '-c',
      'filter.lfs.smudge=',
      '-c',
      'filter.lfs.process=',
      '-c',
      'filter.lfs.required=false',
    ]);
  });

  it('leaves an operator-only filter untouched (no pins)', () => {
    const entries: GitConfigEntry[] = [
      { scope: 'global', key: 'filter.lfs.clean', value: 'git-lfs clean -- %f' },
      { scope: 'system', key: 'filter.lfs.smudge', value: 'git-lfs smudge -- %f' },
      { scope: 'command', key: 'filter.lfs.process', value: 'git-lfs filter-process' },
      { scope: 'global', key: 'filter.lfs.required', value: 'true' },
    ];
    const pins = repositoryProgramPins(entries);
    expect(pins).toEqual([]);
  });

  it('pins a repository override of a global filter back to the global value', () => {
    const entries: GitConfigEntry[] = [
      { scope: 'global', key: 'filter.lfs.clean', value: 'global-lfs clean -- %f' },
      { scope: 'global', key: 'filter.lfs.smudge', value: 'global-lfs smudge -- %f' },
      { scope: 'global', key: 'filter.lfs.process', value: 'global-lfs filter-process' },
      { scope: 'global', key: 'filter.lfs.required', value: 'true' },
      // Local repo overrides clean and smudge with hostile scripts
      { scope: 'local', key: 'filter.lfs.clean', value: '/tmp/evil-clean.sh' },
      { scope: 'local', key: 'filter.lfs.smudge', value: '/tmp/evil-smudge.sh' },
    ];
    const pins = repositoryProgramPins(entries);
    expect(pins).toEqual([
      '-c',
      'filter.lfs.clean=global-lfs clean -- %f',
      '-c',
      'filter.lfs.smudge=global-lfs smudge -- %f',
      '-c',
      'filter.lfs.process=global-lfs filter-process',
      '-c',
      'filter.lfs.required=true',
    ]);
  });

  it('does not pin process when operator defines clean-only filter and repository overrides clean-only', () => {
    const entries: GitConfigEntry[] = [
      { scope: 'global', key: 'filter.cleanonly.clean', value: 'op-clean -- %f' },
      { scope: 'local', key: 'filter.cleanonly.clean', value: '/tmp/evil-clean.sh' },
    ];
    const pins = repositoryProgramPins(entries);
    expect(pins).toEqual([
      '-c',
      'filter.cleanonly.clean=op-clean -- %f',
      '-c',
      'filter.cleanonly.smudge=',
      '-c',
      'filter.cleanonly.required=false',
    ]);
    expect(pins.includes('filter.cleanonly.process=')).toBe(false);
  });

  it('pins process empty when operator defines filter without process but repository sets process', () => {
    const entries: GitConfigEntry[] = [
      { scope: 'global', key: 'filter.proc.clean', value: 'op-clean -- %f' },
      { scope: 'local', key: 'filter.proc.clean', value: '/tmp/evil-clean.sh' },
      { scope: 'local', key: 'filter.proc.process', value: '/tmp/evil-process.sh' },
    ];
    const pins = repositoryProgramPins(entries);
    expect(pins).toEqual([
      '-c',
      'filter.proc.clean=op-clean -- %f',
      '-c',
      'filter.proc.smudge=',
      '-c',
      'filter.proc.process=',
      '-c',
      'filter.proc.required=false',
    ]);
  });

  it('pins a repository merge driver empty', () => {
    const entries: GitConfigEntry[] = [
      { scope: 'local', key: 'merge.custom.driver', value: '/tmp/evil-driver.sh %O %A %B' },
    ];
    const pins = repositoryProgramPins(entries);
    expect(pins).toEqual(['-c', 'merge.custom.driver=']);
  });

  it('leaves an operator merge driver untouched', () => {
    const entries: GitConfigEntry[] = [
      { scope: 'global', key: 'merge.custom.driver', value: 'custom-driver %O %A %B' },
    ];
    const pins = repositoryProgramPins(entries);
    expect(pins).toEqual([]);
  });

  it('pins a repository override of an operator merge driver back to the operator value', () => {
    const entries: GitConfigEntry[] = [
      { scope: 'global', key: 'merge.custom.driver', value: 'operator-driver %O %A %B' },
      { scope: 'local', key: 'merge.custom.driver', value: 'evil-driver %O %A %B' },
    ];
    const pins = repositoryProgramPins(entries);
    expect(pins).toEqual(['-c', 'merge.custom.driver=operator-driver %O %A %B']);
  });

  it('pins an include-scope entry reported as local', () => {
    const entries: GitConfigEntry[] = [
      { scope: 'local', key: 'filter.inc.clean', value: '/tmp/included-clean.sh' },
    ];
    const pins = repositoryProgramPins(entries);
    expect(pins).toEqual([
      '-c',
      'filter.inc.clean=',
      '-c',
      'filter.inc.smudge=',
      '-c',
      'filter.inc.process=',
      '-c',
      'filter.inc.required=false',
    ]);
  });

  it('adds core.fsmonitor=true pin for boolean true values: true, YES, on, 1, and no-value', () => {
    for (const val of ['true', 'YES', 'on', '1']) {
      const entries: GitConfigEntry[] = [{ scope: 'local', key: 'core.fsmonitor', value: val }];
      expect(repositoryProgramPins(entries)).toEqual(['-c', 'core.fsmonitor=true']);
    }

    // Bare key with no value parses to 'true'
    const noValEntries: GitConfigEntry[] = [
      { scope: 'global', key: 'core.fsmonitor', value: 'true' },
    ];
    expect(repositoryProgramPins(noValEntries)).toEqual(['-c', 'core.fsmonitor=true']);
  });

  it('does not pin core.fsmonitor for a hook path or false value', () => {
    const hookEntries: GitConfigEntry[] = [
      { scope: 'local', key: 'core.fsmonitor', value: '/usr/local/bin/fsmonitor-watchman' },
    ];
    expect(repositoryProgramPins(hookEntries)).toEqual([]);

    const falseEntries: GitConfigEntry[] = [
      { scope: 'local', key: 'core.fsmonitor', value: 'false' },
    ];
    expect(repositoryProgramPins(falseEntries)).toEqual([]);
  });

  it('preserves subsection case so filter.X.clean is not filter.x.clean', () => {
    const entries: GitConfigEntry[] = [
      { scope: 'global', key: 'filter.X.clean', value: 'upper-clean' },
      { scope: 'local', key: 'filter.x.clean', value: 'lower-evil' },
    ];
    const pins = repositoryProgramPins(entries);
    // Only filter.x has repository scope, so only filter.x is pinned (clean empty, smudge empty, process empty, required false)
    // filter.X has no repository scope, so it is untouched
    expect(pins).toEqual([
      '-c',
      'filter.x.clean=',
      '-c',
      'filter.x.smudge=',
      '-c',
      'filter.x.process=',
      '-c',
      'filter.x.required=false',
    ]);
  });

  it('fails closed when a repository-scope filter has = in its name (Fix 1)', () => {
    const entries: GitConfigEntry[] = [
      { scope: 'local', key: 'filter.a=b.clean', value: '/tmp/evil.sh' },
    ];
    expect(() => repositoryProgramPins(entries)).toThrow(
      'the repository\'s configuration defines a filter or merge driver named "a=b", which Book cannot neutralize, so it will not run git here',
    );
  });

  it('fails closed when a repository-scope merge driver has = in its name (Fix 1)', () => {
    const entries: GitConfigEntry[] = [
      { scope: 'worktree', key: 'merge.custom=driver.driver', value: '/tmp/evil.sh' },
    ];
    expect(() => repositoryProgramPins(entries)).toThrow(
      'the repository\'s configuration defines a filter or merge driver named "custom=driver", which Book cannot neutralize, so it will not run git here',
    );
  });

  it('escapes control characters and ANSI escape sequences in refused name error (Fix 4)', () => {
    const hostileName = '\u001b[31m=';
    const entries: GitConfigEntry[] = [
      { scope: 'local', key: `filter.${hostileName}.clean`, value: '/tmp/evil.sh' },
    ];
    let thrownError: Error | undefined;
    try {
      repositoryProgramPins(entries);
    } catch (err) {
      thrownError = err as Error;
    }
    expect(thrownError).toBeDefined();
    expect(thrownError?.message).toContain(JSON.stringify(hostileName));
    expect(thrownError?.message.includes('\u001b')).toBe(false);
  });

  it('does not throw when an operator-scope filter has = in its name (Fix 1)', () => {
    const entries: GitConfigEntry[] = [
      { scope: 'global', key: 'filter.a=b.clean', value: '/usr/bin/op.sh' },
    ];
    expect(() => repositoryProgramPins(entries)).not.toThrow();
    expect(repositoryProgramPins(entries)).toEqual([]);
  });

  it('pins all four filter keys for an empty subsection filter (Fix 2)', () => {
    const entries: GitConfigEntry[] = [
      { scope: 'local', key: 'filter..clean', value: '/tmp/evil.sh' },
    ];
    const pins = repositoryProgramPins(entries);
    expect(pins).toEqual([
      '-c',
      'filter..clean=',
      '-c',
      'filter..smudge=',
      '-c',
      'filter..process=',
      '-c',
      'filter..required=false',
    ]);
  });

  it('pins an empty subsection merge driver (Fix 2)', () => {
    const entries: GitConfigEntry[] = [
      { scope: 'local', key: 'merge..driver', value: '/tmp/evil-merge.sh' },
    ];
    const pins = repositoryProgramPins(entries);
    expect(pins).toEqual(['-c', 'merge..driver=']);
  });

  it('does not pin core.fsmonitor when allowFsmonitor is false (Fix 5)', () => {
    const entries: GitConfigEntry[] = [{ scope: 'local', key: 'core.fsmonitor', value: 'true' }];
    expect(repositoryProgramPins(entries, { allowFsmonitor: false })).toEqual([]);
  });
});

describe('readRepositoryProgramPins', () => {
  it('returns no pins when git config exits 1 (no match)', async () => {
    const runner: RepositoryProgramRunner = async () => ({
      stdout: '',
      stderr: '',
      code: 1,
    });
    const pins = await readRepositoryProgramPins('/tmp/repo', runner);
    expect(pins).toEqual([]);
  });

  it('parses config stream and returns pins on exit 0', async () => {
    const runner: RepositoryProgramRunner = async () => ({
      stdout: 'local\0filter.evil.clean\n/tmp/evil.sh\0',
      stderr: '',
      code: 0,
    });
    const pins = await readRepositoryProgramPins('/tmp/repo', runner);
    expect(pins).toEqual([
      '-c',
      'filter.evil.clean=',
      '-c',
      'filter.evil.smudge=',
      '-c',
      'filter.evil.process=',
      '-c',
      'filter.evil.required=false',
    ]);
  });

  it('falls back to --local --includes and --worktree --includes when --show-scope is unknown (exit 129)', async () => {
    const calls: string[][] = [];
    const runner: RepositoryProgramRunner = async (args) => {
      calls.push(args);
      if (args.includes('--show-scope')) {
        return { stdout: '', stderr: 'error: unknown option `show-scope`', code: 129 };
      }
      if (args.includes('--local')) {
        // Output from git config without --show-scope is key\nvalue\0
        return {
          stdout: 'filter.fallback.clean\n/tmp/clean.sh\0core.fsmonitor\ntrue\0',
          stderr: '',
          code: 0,
        };
      }
      if (args.includes('--worktree')) {
        return { stdout: '', stderr: '', code: 1 };
      }
      return { stdout: '', stderr: '', code: 0 };
    };

    const pins = await readRepositoryProgramPins('/tmp/repo', runner);
    // In fallback: all entries are treated as repository scope, and fsmonitor is NEVER allowed
    expect(pins).toEqual([
      '-c',
      'filter.fallback.clean=',
      '-c',
      'filter.fallback.smudge=',
      '-c',
      'filter.fallback.process=',
      '-c',
      'filter.fallback.required=false',
    ]);
    expect(calls.some((args) => args.includes('--local'))).toBe(true);
    expect(calls.some((args) => args.includes('--worktree'))).toBe(true);
  });

  it('reads system and global operator values in fallback so local overrides are pinned back to operator values (Fix 7)', async () => {
    const runner: RepositoryProgramRunner = async (args) => {
      if (args.includes('--show-scope')) {
        // Test reachable unknown option when runner throws/rejects (Fix 7)
        throw new Error('error: unknown option `show-scope`');
      }
      if (args.includes('--system')) {
        return {
          stdout: 'filter.sys.clean\nsystem-clean\0',
          stderr: '',
          code: 0,
        };
      }
      if (args.includes('--global')) {
        return {
          stdout: 'filter.foo.clean\nglobal-clean\0filter.foo.required\ntrue\0',
          stderr: '',
          code: 0,
        };
      }
      if (args.includes('--local')) {
        return {
          stdout:
            'filter.foo.clean\nevil-clean\0filter.bar.clean\nevil-bar\0merge.driver1.driver\nevil-driver\0',
          stderr: '',
          code: 0,
        };
      }
      if (args.includes('--worktree')) {
        return { stdout: '', stderr: '', code: 1 };
      }
      return { stdout: '', stderr: '', code: 0 };
    };

    const pins = await readRepositoryProgramPins('/tmp/repo', runner);
    // filter.foo was in global, so local override is pinned back to global values
    // filter.bar was local only, so pinned empty
    // merge.driver1 was local only, so pinned empty
    // filter.sys was system only (not overridden locally), so not pinned
    expect(pins).toEqual([
      '-c',
      'filter.foo.clean=global-clean',
      '-c',
      'filter.foo.smudge=',
      '-c',
      'filter.foo.required=true',
      '-c',
      'filter.bar.clean=',
      '-c',
      'filter.bar.smudge=',
      '-c',
      'filter.bar.process=',
      '-c',
      'filter.bar.required=false',
      '-c',
      'merge.driver1.driver=',
    ]);
  });

  it('detects core.fsmonitor=true in a real git repository and ignores command scope (Fix 2)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'book-fsm-real-'));
    try {
      execFileSync('git', ['init', '-q', repo]);
      execFileSync('git', ['-C', repo, 'config', 'core.fsmonitor', 'true']);
      const pins = await readRepositoryProgramPins(repo);
      expect(pins).toEqual(['-c', 'core.fsmonitor=true']);

      const pinsNoAllow = await readRepositoryProgramPins(repo, undefined, {
        allowFsmonitor: false,
      });
      expect(pinsNoAllow).toEqual([]);

      execFileSync('git', ['-C', repo, 'config', 'core.fsmonitor', '/usr/local/bin/hook']);
      const pinsHook = await readRepositoryProgramPins(repo);
      expect(pinsHook).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects when its runner reports a kill or timeout (Fix 1)', async () => {
    const runner: RepositoryProgramRunner = async () => {
      throw new Error('git timed out after 30000ms and was killed');
    };
    await expect(readRepositoryProgramPins('/tmp/repo', runner)).rejects.toThrow(
      'git timed out after 30000ms and was killed',
    );
  });

  it('throws and fails closed on unexpected exit code (exit 128) (Fix 1)', async () => {
    const runner: RepositoryProgramRunner = async () => ({
      stdout: '',
      stderr: 'fatal: corrupt repository',
      code: 128,
    });
    await expect(readRepositoryProgramPins('/tmp/repo', runner)).rejects.toThrow(
      'fatal: corrupt repository',
    );
  });
});

describe('defaultGitRunner (Fix 1, Fix 3)', () => {
  it('defaultGitRunner with a real git and a 1 ms timeout rejects (Fix 1)', async () => {
    await expect(
      defaultGitRunner(['-c', 'core.fsmonitor=sleep 2', 'status'], {
        cwd: process.cwd(),
        timeoutMs: 1,
        allowExitCodes: [1],
      }),
    ).rejects.toThrow(/timed out.*killed/);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects with a real git and a hanging config read (FIFO include)',
    async () => {
      const repo = mkdtempSync(join(tmpdir(), 'book-fifo-runner-'));
      const fifo = join(repo, 'fifo');
      try {
        execFileSync('mkfifo', [fifo]);
        execFileSync('git', ['init', '-q', repo]);
        execFileSync('git', ['-C', repo, 'config', 'include.path', fifo]);

        await expect(
          defaultGitRunner(['config', '--show-scope', '--get-regexp', '.*'], {
            cwd: repo,
            allowExitCodes: [1],
            timeoutMs: 50,
          }),
        ).rejects.toThrow(/timed out.*killed/);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );
});

describe('canonicalConfigKey and parseGitConfig', () => {
  it('canonicalConfigKey lowercases section and variable name but preserves subsection case', () => {
    expect(canonicalConfigKey('FILTER.LFS.CLEAN')).toBe('filter.LFS.clean');
    expect(canonicalConfigKey('CORE.FSMONITOR')).toBe('core.fsmonitor');
    expect(canonicalConfigKey('single')).toBe('single');
  });

  it('parseGitConfig parses NUL-delimited stream with scope, key, value', () => {
    const raw = 'local\0FILTER.X.CLEAN\nclean-cmd\0global\0CORE.FSMONITOR\0';
    expect(parseGitConfig(raw)).toEqual([
      { scope: 'local', key: 'filter.X.clean', value: 'clean-cmd' },
      { scope: 'global', key: 'core.fsmonitor', value: 'true' },
    ]);
  });

  it('parseGitConfig parses unscoped NUL-delimited stream with a fixed scope (Fix 9)', () => {
    const raw = 'FILTER.X.CLEAN\nclean-cmd\0CORE.FSMONITOR\0';
    expect(parseGitConfig(raw, { scope: 'local' })).toEqual([
      { scope: 'local', key: 'filter.X.clean', value: 'clean-cmd' },
      { scope: 'local', key: 'core.fsmonitor', value: 'true' },
    ]);
  });
});
