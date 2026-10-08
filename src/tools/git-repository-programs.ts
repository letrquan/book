import { execFile } from 'node:child_process';
import { buildChildEnv } from '../child-env.js';

/**
 * Base -c overrides the Git tools and the managed-agent subsystem carry, so a checkout's own
 * configuration cannot turn a git call into something that runs a program.
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
 * pages its output with, and a credential prompt it cannot sit waiting on.
 */
export function hardenedGitEnv(): Record<string, string> {
  return { GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' };
}

/**
 * The hardening flags in front of a caller's own arguments. Note that guarded callers pass
 * repository program pins after these base flags (`hardenedGitArgs([...pins, ...args])`) so
 * operator values and neutralized pins override them.
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
  },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/**
 * The config pattern that matches all repository-level programs: fsmonitor, filters, and merge drivers.
 */
export const REPOSITORY_PROGRAM_CONFIG_PATTERN =
  '^(core\\.fsmonitor|filter\\..+\\.(clean|smudge|process|required)|merge\\..+\\.driver)$';

const OPERATOR_SCOPES: ReadonlySet<string> = new Set(['system', 'global', 'command']);
const REPOSITORY_SCOPES: ReadonlySet<string> = new Set(['local', 'worktree']);

/**
 * Parse `git config --show-scope -z --get-regexp` output.
 *
 * The `-z` layout is a NUL-separated stream of pairs: `scope\0key\nvalue\0` (or `scope\0key\0` for
 * a key written without a value).
 */
export function parseGitConfig(stdout: string): GitConfigEntry[] {
  const fields = stdout.split('\0');
  const entries: GitConfigEntry[] = [];
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
 * Parse `git config -z --get-regexp` output when `--show-scope` is unavailable.
 *
 * The layout is `key\nvalue\0` or `key\0`.
 */
function parseUnscopedConfig(stdout: string, scope = 'local'): GitConfigEntry[] {
  const fields = stdout.split('\0');
  const entries: GitConfigEntry[] = [];
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
 * - core.fsmonitor: if effective value is boolean true, pin -c core.fsmonitor=true. Otherwise nothing.
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
  const repoMergeDriverNames = new Set<string>();

  let lastFsmonitor: string | undefined;

  for (const entry of entries) {
    const isRepo = REPOSITORY_SCOPES.has(entry.scope);
    const isOperator = OPERATOR_SCOPES.has(entry.scope);

    if (entry.key === 'core.fsmonitor') {
      lastFsmonitor = entry.value;
    } else if (entry.key.startsWith('filter.')) {
      const lastDot = entry.key.lastIndexOf('.');
      if (lastDot > 7) {
        const prop = entry.key.slice(lastDot + 1);
        const name = entry.key.slice(7, lastDot);
        if (prop === 'clean' || prop === 'smudge' || prop === 'process' || prop === 'required') {
          if (isRepo) {
            repoFilterNames.add(name);
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
      if (name.length > 0) {
        if (isRepo) {
          repoMergeDriverNames.add(name);
        }
        if (isOperator) {
          operatorMergeDrivers.set(name, entry.value);
        }
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

    pins.push(
      '-c',
      `filter.${name}.clean=${clean}`,
      '-c',
      `filter.${name}.smudge=${smudge}`,
      '-c',
      `filter.${name}.process=${process}`,
      '-c',
      `filter.${name}.required=${required}`,
    );
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

async function defaultGitRunner(
  args: string[],
  options: {
    cwd: string;
    allowExitCodes?: number[];
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 30_000,
        signal: options.signal,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
        env: buildChildEnv(
          process.env,
          options.env ? { ...hardenedGitEnv(), ...options.env } : hardenedGitEnv(),
        ),
      },
      (error, stdout, stderr) => {
        const code = typeof error?.code === 'number' ? error.code : error ? 1 : 0;
        if (!error || options.allowExitCodes?.includes(code)) {
          resolvePromise({ stdout, stderr, code });
          return;
        }
        reject(new Error(stderr.trim() || stdout.trim() || error.message));
      },
    );
  });
}

/**
 * Read repository program pins for a directory by inspecting git config.
 */
export async function readRepositoryProgramPins(
  cwd: string,
  exec?: RepositoryProgramRunner,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<string[]> {
  const runner = exec ?? defaultGitRunner;
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const signal = options?.signal;

  const showScopeArgs = hardenedGitArgs([
    'config',
    '--show-scope',
    '-z',
    '--get-regexp',
    REPOSITORY_PROGRAM_CONFIG_PATTERN,
  ]);

  const result = await runner(showScopeArgs, {
    cwd,
    allowExitCodes: [1, 129],
    timeoutMs,
    signal,
  });

  if (result.code === 0) {
    const entries = parseGitConfig(result.stdout);
    return repositoryProgramPins(entries);
  }

  if (result.code === 1) {
    return [];
  }

  if (result.code === 129 || /unknown option/i.test(result.stderr)) {
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
    });
    if (localResult.code !== 0 && localResult.code !== 1) {
      throw new Error(
        localResult.stderr.trim() ||
          localResult.stdout.trim() ||
          `git config --local failed (${localResult.code})`,
      );
    }

    const entries: GitConfigEntry[] =
      localResult.code === 0 ? parseUnscopedConfig(localResult.stdout, 'local') : [];

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
      });
      if (wtResult.code === 0) {
        entries.push(...parseUnscopedConfig(wtResult.stdout, 'worktree'));
      }
    } catch {
      // Worktree config not supported or absent; ignore when that fails
    }

    return repositoryProgramPins(entries, { allowFsmonitor: false });
  }

  throw new Error(
    result.stderr.trim() || result.stdout.trim() || `git config failed (${result.code})`,
  );
}
