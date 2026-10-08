import { execFile } from 'node:child_process';
import { buildChildEnv } from '../child-env.js';

/**
 * Base -c overrides the Git tools and the managed-agent subsystem carry, so a checkout's own
 * configuration cannot turn a git call into something that runs a program.
 *
 * The configuration belongs to the checkout, and a checkout may have come from an archive, a
 * shared directory, or someone else's machine, so any of these can be set without the operator
 * having made that choice themselves:
 *
 * - `core.fsmonitor` — default off. A command `git status` executes to check whether the tree
 *   changed. This is the sharpest one: a status call is supposed to be inert and it will happily
 *   run whatever the repository named. `GIT_HARDENING_ARGS` turns it off by default; git's
 *   built-in daemon (`core.fsmonitor=true`) is allowed back by `readRepositoryProgramPins` for
 *   read-only callers when configured, while hook paths remain disabled (#357).
 * - `log.showSignature` — `git log` then verifies every signature it prints, and verification
 *   runs `gpg.program`, another program the repository names. `GitDiff` and `GitStatus` do not
 *   reach it, but `GitLog` does on every commit that carries a `gpgsig` header.
 * - `core.pager` — a command Git runs to page its output. `execFile` never allocates a TTY, so
 *   git normally skips it, but the setting is read before that decision.
 * - `core.hooksPath` — where hooks live, and where most of the effect of this list lands: a
 *   `post-checkout` on `worktree add`, a `pre-commit` on an agent's commit, a
 *   `reference-transaction` on every ref Book moves, a `prepare-commit-msg` on the
 *   `cherry-pick` that applies a candidate. The four read-only tools here run no hook at all, so
 *   for them this is belt and braces against a future subcommand; for
 *   `src/agents/git-isolation.ts`, whose calls are writes nothing asks about (#348), switching
 *   them off is the decision. It is **not** applied to `GitCommit` or to `runGit` generally: on
 *   the operator's own commit it would silently disable a hook they installed, and their code
 *   silently not running is a worse failure than the one this list prevents.
 * - `core.untrackedCache`, `gc.auto`, `maintenance.auto` — background writers. `gc.auto=0` is not
 *   the whole of it: `maintenance.auto` is separately on by default, so every commit spawns
 *   `git maintenance run --auto`, which repacks and can run whatever strategies the configuration
 *   registers while Book is moving refs. `--no-optional-locks` below covers the index lock these
 *   need.
 *
 * `--no-optional-locks` is a top-level flag, not a config key, so it is added separately: it stops
 * Git taking `.git/index.lock` for a call that only reads, which a read-only worktree and a
 * concurrent `book` session would otherwise fight over.
 *
 * Each of these was checked against a real `git`, not read off this list — see
 * `git.test.ts`. Anything not reached through a non-TTY `execFile` (`column.ui`, `pager.log`,
 * `diff.external`) is not here either, because the flags that close those are per-command and
 * belong in `HARDENED_DIFF_ARGS`, which every hardened caller that runs `git diff` uses.
 */
export const GIT_HARDENING_ARGS: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.pager=cat',
  '-c',
  'core.hooksPath=',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
  '-c',
  'log.showSignature=false',
  '--no-optional-locks',
];

/**
 * The environment every hardened call carries: a pager, so a checkout cannot name a program git
 * pages its output with, and a credential prompt it cannot sit waiting on. Callers that have an
 * environment of their own to merge (a tool's `ToolContext.env`, a temporary `GIT_INDEX_FILE`,
 * git isolation's commit identity) spread this into it; the pager and the prompt are the floor,
 * not a replacement.
 *
 * The return type is `Record<string, string>` rather than `NodeJS.ProcessEnv`: a caller's
 * environment is `Record<string, string>` too, and spreading a wider one into it would make the
 * whole object `string | undefined` where nothing may be undefined.
 */
export function hardenedGitEnv(): Record<string, string> {
  return { GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' };
}

/**
 * The hardening flags in front of a caller's own arguments; see {@link GIT_HARDENING_ARGS}.
 *
 * Four callers, and they read this differently. The read-only Git tools (`readOnlyGit`) take
 * it because nothing asks before they run, so a checkout must not be able to start a program
 * through one. `/review`'s target (`src/review/target.ts`) and the TUI status poll
 * (`src/tui/hooks/useGitStatus.ts`) are the same: reports and background polls that fire with no
 * prompt. Git isolation (`src/agents/git-isolation.ts`) is the one that takes it on writes as
 * well — the agent's commit, the cherry-pick, `worktree add`, `update-ref` — where hooks being
 * off is a decision (#348) rather than a consequence: that work is Book's, in Book's worktree,
 * and a hook the operator installed is theirs to decide when it runs. The operator's own commits
 * keep their hooks, through `runGit`.
 *
 * Note that guarded callers pass repository program pins after these base flags
 * (`hardenedGitArgs([...pins, ...args])`) so operator values and neutralized pins override them (#357).
 */
export function hardenedGitArgs(args: readonly string[]): string[] {
  return [...GIT_HARDENING_ARGS, ...args];
}

/**
 * One `git config` entry, in the order git reported it.
 */
export interface GitConfigEntry {
  /**
   * Git's own name for where the value came from: `system`, `global`, `local`, `worktree` or
   * `command`.
   */
  scope: string;
  /**
   * The key as git canonicalized it: section and variable name lower-cased, subsection left
   * exactly as written.
   */
  key: string;
  /** The value, or `true` for a key written without one. */
  value: string;
}

export type RepositoryProgramRunner = (
  args: string[],
  options: {
    cwd: string;
    allowExitCodes?: number[];
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    windowsHide?: boolean;
  },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/**
 * The config pattern that matches all repository-level programs: fsmonitor, filters, and merge drivers.
 * Note: subsection name matching uses `.*` rather than `.+` to match empty subsection names (e.g. `[filter ""]`).
 */
export const REPOSITORY_PROGRAM_CONFIG_PATTERN =
  '^(core\\.fsmonitor|filter\\..*\\.(clean|smudge|process|required)|merge\\..*\\.driver)$';

const OPERATOR_SCOPES: ReadonlySet<string> = new Set(['system', 'global', 'command']);
const REPOSITORY_SCOPES: ReadonlySet<string> = new Set(['local', 'worktree']);

/**
 * Parse `git config -z --get-regexp` output.
 *
 * With `--show-scope`, the layout is pairs: `scope\0key\nvalue\0` (or `scope\0key\0`).
 * Without `--show-scope` (passing `{ scope }`), the layout is entries: `key\nvalue\0` (or `key\0`).
 */
export function parseGitConfig(stdout: string, options?: { scope?: string }): GitConfigEntry[] {
  const fields = stdout.split('\0');
  const entries: GitConfigEntry[] = [];

  if (options?.scope !== undefined) {
    const scope = options.scope.toLowerCase();
    for (const field of fields) {
      if (!field) continue;
      const separator = field.indexOf('\n');
      entries.push({
        scope,
        key: canonicalConfigKey(separator === -1 ? field : field.slice(0, separator)),
        value: separator === -1 ? 'true' : field.slice(separator + 1),
      });
    }
    return entries;
  }

  for (let index = 0; index + 1 < fields.length; index += 2) {
    const separator = fields[index + 1].indexOf('\n');
    entries.push({
      scope: fields[index].toLowerCase(),
      key: canonicalConfigKey(
        separator === -1 ? fields[index + 1] : fields[index + 1].slice(0, separator),
      ),
      value: separator === -1 ? 'true' : fields[index + 1].slice(separator + 1),
    });
  }
  return entries;
}

/**
 * Canonicalize a config key the way git does: section and variable lower-cased, subsection
 * preserved as-is.
 */
export function canonicalConfigKey(raw: string): string {
  const nameStart = raw.lastIndexOf('.');
  if (nameStart === -1) return raw.toLowerCase();
  const head = raw.slice(0, nameStart);
  const name = raw.slice(nameStart + 1).toLowerCase();
  const subsectionStart = head.indexOf('.');
  if (subsectionStart === -1) return `${head.toLowerCase()}.${name}`;
  const section = head.slice(0, subsectionStart).toLowerCase();
  return `${section}.${head.slice(subsectionStart + 1)}.${name}`;
}

/**
 * Build `-c key=value` pins from git config entries.
 *
 * - Filter names defined in repository scope: clean/smudge/process pinned to operator value or empty;
 *   required pinned to operator value or false.
 * - Merge drivers defined in repository scope: driver pinned to operator value or empty.
 * - If any repository-scope filter or merge driver has `=` in its name, throws because git `-c`
 *   splits on `=` and cannot neutralize such a program.
 * - core.fsmonitor: if allowFsmonitor is true and effective value is boolean true, pin -c core.fsmonitor=true.
 *   Otherwise nothing.
 */
export function repositoryProgramPins(
  entries: readonly GitConfigEntry[],
  options: { allowFsmonitor?: boolean } = {},
): string[] {
  const allowFsmonitor = options.allowFsmonitor ?? true;

  const operatorFilters = new Map<
    string,
    { clean?: string; smudge?: string; process?: string; required?: string }
  >();
  const operatorMergeDrivers = new Map<string, string>();
  const repoFilterNames = new Set<string>();
  const repoFiltersWithProcess = new Set<string>();
  const repoMergeDriverNames = new Set<string>();

  let lastFsmonitor: string | undefined;

  for (const entry of entries) {
    const isRepo = REPOSITORY_SCOPES.has(entry.scope);
    const isOperator = OPERATOR_SCOPES.has(entry.scope);

    if (entry.key === 'core.fsmonitor') {
      if (entry.scope !== 'command') {
        lastFsmonitor = entry.value;
      }
    } else if (entry.key.startsWith('filter.')) {
      const lastDot = entry.key.lastIndexOf('.');
      if (lastDot >= 7) {
        const prop = entry.key.slice(lastDot + 1);
        const name = entry.key.slice(7, lastDot);
        if (prop === 'clean' || prop === 'smudge' || prop === 'process' || prop === 'required') {
          if (isRepo) {
            if (name.includes('=')) {
              throw new Error(
                `the repository's configuration defines a filter or merge driver named ${JSON.stringify(name)}, which Book cannot neutralize, so it will not run git here`,
              );
            }
            repoFilterNames.add(name);
            if (prop === 'process') {
              repoFiltersWithProcess.add(name);
            }
          }
          if (isOperator) {
            let op = operatorFilters.get(name);
            if (!op) {
              op = {};
              operatorFilters.set(name, op);
            }
            op[prop] = entry.value;
          }
        }
      }
    } else if (entry.key.startsWith('merge.') && entry.key.endsWith('.driver')) {
      const name = entry.key.slice(6, -7);
      if (isRepo) {
        if (name.includes('=')) {
          throw new Error(
            `the repository's configuration defines a filter or merge driver named ${JSON.stringify(name)}, which Book cannot neutralize, so it will not run git here`,
          );
        }
        repoMergeDriverNames.add(name);
      }
      if (isOperator) {
        operatorMergeDrivers.set(name, entry.value);
      }
    }
  }

  const pins: string[] = [];

  for (const name of repoFilterNames) {
    const op = operatorFilters.get(name);
    const clean = op?.clean ?? '';
    const smudge = op?.smudge ?? '';
    const process = op?.process ?? '';
    const required = op?.required ?? 'false';

    pins.push('-c', `filter.${name}.clean=${clean}`, '-c', `filter.${name}.smudge=${smudge}`);

    const hasOperator = op !== undefined;
    const repoHasProcess = repoFiltersWithProcess.has(name);
    const opHasProcess = op?.process !== undefined;
    if (!hasOperator || repoHasProcess || opHasProcess) {
      pins.push('-c', `filter.${name}.process=${process}`);
    }

    pins.push('-c', `filter.${name}.required=${required}`);
  }

  for (const name of repoMergeDriverNames) {
    const driver = operatorMergeDrivers.get(name) ?? '';
    pins.push('-c', `merge.${name}.driver=${driver}`);
  }

  if (allowFsmonitor && lastFsmonitor !== undefined) {
    const trimmed = lastFsmonitor.trim().toLowerCase();
    if (['true', 'yes', 'on', '1'].includes(trimmed)) {
      pins.push('-c', 'core.fsmonitor=true');
    }
  }

  return pins;
}

export async function defaultGitRunner(
  args: string[],
  options: {
    cwd: string;
    allowExitCodes?: number[];
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    windowsHide?: boolean;
  },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const timeout = options.timeoutMs === 0 ? 0 : (options.timeoutMs ?? 30_000);
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: options.cwd,
        timeout,
        signal: options.signal,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
        windowsHide: options.windowsHide ?? true,
        env: buildChildEnv(
          process.env,
          options.env ? { ...hardenedGitEnv(), ...options.env } : hardenedGitEnv(),
        ),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ stdout, stderr, code: 0 });
          return;
        }

        const isKilled = Boolean(error.killed || error.signal);

        if (
          !isKilled &&
          typeof error.code === 'number' &&
          options.allowExitCodes?.includes(error.code)
        ) {
          resolvePromise({ stdout, stderr, code: error.code });
          return;
        }

        let failureReason: string;
        if (error.killed) {
          failureReason =
            timeout > 0
              ? `git timed out after ${timeout}ms and was killed`
              : 'git timed out and was killed';
        } else if (error.signal) {
          failureReason = `git was killed with ${error.signal}`;
        } else if (
          error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
          /maxBuffer/i.test(error.message)
        ) {
          failureReason = 'git output too large (maxBuffer exceeded)';
        } else if (typeof error.code === 'string') {
          failureReason = `git failed: ${error.code}`;
        } else {
          failureReason = stderr.trim() || stdout.trim() || error.message || 'git failed';
        }

        reject(new Error(failureReason));
      },
    );
  });
}

export interface ReadPinsOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  allowFsmonitor?: boolean;
}

/**
 * Read repository program pins for a directory by inspecting git config.
 */
export async function readRepositoryProgramPins(
  cwd: string,
  exec?: RepositoryProgramRunner,
  options?: ReadPinsOptions,
): Promise<string[]> {
  const runner = exec ?? defaultGitRunner;
  const timeoutMs = options?.timeoutMs === 0 ? 0 : (options?.timeoutMs ?? 30_000);
  const signal = options?.signal;
  const env = options?.env;
  const allowFsmonitor = options?.allowFsmonitor ?? true;

  const showScopeArgs = hardenedGitArgs([
    'config',
    '--show-scope',
    '-z',
    '--get-regexp',
    REPOSITORY_PROGRAM_CONFIG_PATTERN,
  ]);

  let isUnknownOption = false;
  let showScopeResult: { stdout: string; stderr: string; code: number } | undefined;

  try {
    showScopeResult = await runner(showScopeArgs, {
      cwd,
      allowExitCodes: [1, 129],
      timeoutMs,
      signal,
      env,
    });
    if (showScopeResult.code === 129 || /unknown option/i.test(showScopeResult.stderr)) {
      isUnknownOption = true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unknown option/i.test(message)) {
      isUnknownOption = true;
    } else {
      throw error;
    }
  }

  if (!isUnknownOption && showScopeResult) {
    if (showScopeResult.code === 0) {
      const entries = parseGitConfig(showScopeResult.stdout);
      return repositoryProgramPins(entries, { allowFsmonitor });
    }

    if (showScopeResult.code === 1) {
      return [];
    }

    throw new Error(
      showScopeResult.stderr.trim() ||
        showScopeResult.stdout.trim() ||
        `git config failed (${showScopeResult.code})`,
    );
  }

  // Fallback for older git without --show-scope: read system, global, local, worktree in order.
  const entries: GitConfigEntry[] = [];

  const systemArgs = hardenedGitArgs([
    'config',
    '--system',
    '--includes',
    '-z',
    '--get-regexp',
    REPOSITORY_PROGRAM_CONFIG_PATTERN,
  ]);
  try {
    const sysResult = await runner(systemArgs, {
      cwd,
      allowExitCodes: [1],
      timeoutMs,
      signal,
      env,
    });
    if (sysResult.code === 0) {
      entries.push(...parseGitConfig(sysResult.stdout, { scope: 'system' }));
    }
  } catch {
    // System config not present or unreadable; ignore
  }

  const globalArgs = hardenedGitArgs([
    'config',
    '--global',
    '--includes',
    '-z',
    '--get-regexp',
    REPOSITORY_PROGRAM_CONFIG_PATTERN,
  ]);
  const globalResult = await runner(globalArgs, {
    cwd,
    allowExitCodes: [1],
    timeoutMs,
    signal,
    env,
  });
  if (globalResult.code === 0) {
    entries.push(...parseGitConfig(globalResult.stdout, { scope: 'global' }));
  } else if (globalResult.code !== 1) {
    throw new Error(
      globalResult.stderr.trim() ||
        globalResult.stdout.trim() ||
        `git config --global failed (${globalResult.code})`,
    );
  }

  const localArgs = hardenedGitArgs([
    'config',
    '--local',
    '--includes',
    '-z',
    '--get-regexp',
    REPOSITORY_PROGRAM_CONFIG_PATTERN,
  ]);
  const localResult = await runner(localArgs, {
    cwd,
    allowExitCodes: [1],
    timeoutMs,
    signal,
    env,
  });
  if (localResult.code === 0) {
    entries.push(...parseGitConfig(localResult.stdout, { scope: 'local' }));
  } else if (localResult.code !== 1) {
    throw new Error(
      localResult.stderr.trim() ||
        localResult.stdout.trim() ||
        `git config --local failed (${localResult.code})`,
    );
  }

  const worktreeArgs = hardenedGitArgs([
    'config',
    '--worktree',
    '--includes',
    '-z',
    '--get-regexp',
    REPOSITORY_PROGRAM_CONFIG_PATTERN,
  ]);
  try {
    const wtResult = await runner(worktreeArgs, {
      cwd,
      allowExitCodes: [1, 128],
      timeoutMs,
      signal,
      env,
    });
    if (wtResult.code === 0) {
      entries.push(...parseGitConfig(wtResult.stdout, { scope: 'worktree' }));
    }
  } catch {
    // Worktree config not supported or absent; ignore when that fails
  }

  return repositoryProgramPins(entries, { allowFsmonitor: false });
}
