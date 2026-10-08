import { describe, expect, it } from 'vitest';
import {
  canonicalConfigKey,
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

  it('throws and fails closed on unexpected exit code', async () => {
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
});
