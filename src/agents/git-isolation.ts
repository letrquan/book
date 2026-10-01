import { createHash, randomUUID } from 'crypto';
import { execFile, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import type { AgentApplyResult, AgentRecord, AgentSnapshot, PatchCandidate } from './types.js';
import { buildChildEnv } from '../child-env.js';
import { resolveBookHome } from '../book-home.js';
import { hardenedGitArgs, hardenedGitEnv, HARDENED_DIFF_ARGS } from '../tools/git.js';
import {
  signingPinArgs,
  type HardenedRunner,
  type RunOptions,
  type RunResult,
} from './git-signing.js';

/**
 * Every git command this module runs: a synthetic snapshot, an agent's worktree, the agent's
 * commit, and the cherry-pick or patch that applies the result.
 *
 * The argv goes through {@link hardenedGitArgs} and the environment carries a pager and a
 * credential prompt it cannot wait on, here as in the read-only Git tools. What is different is
 * the one that matters for this module: several of these are writes — `commit`, `cherry-pick`,
 * `worktree add`, `update-ref` — and a checkout could own a hook, an `fsmonitor`, or a diff driver
 * for any of them. None of this is the operator's work, and none of it is a call anything asks
 * before, so a repository can run a program by delegating an agent (#348). Turning hooks off for
 * it is the decision here; the operator's own commits, `GitCommit` included, keep theirs.
 *
 * It is applied inside {@link run} rather than at each call site, so a new call site cannot forget
 * it, and `git-signing.ts` is given that function rather than a runner of its own for the same
 * reason: a fix here reaches every read that decides how a commit is signed.
 *
 * **What is still followed, deliberately (#357).** Hooks, `core.fsmonitor` and the diff drivers
 * are off, and the agent's own commit is unsigned, but three routes a checkout owns remain open,
 * because closing them would change the content Book manages:
 *
 * - **`.gitattributes` clean/smudge and process filters.** They rewrite the bytes on checkout and
 *   on add, and a process filter is a program the checkout names. `git-lfs` needs them: without
 *   them a pointer file is a pointer file rather than the large blob it stands for.
 * - **`.gitattributes` merge drivers.** The cherry-pick that applies an agent's result merges
 *   through whatever the checkout names, for the same reason.
 * - **Lazy fetch in a partial clone.** `--filter=blob:none` means a missing blob is fetched on
 *   demand, through the `credential.helper` and `core.sshCommand` that fetch needs.
 *
 * So a checkout can still have Book run a program through one of those three, and that is a known
 * gap rather than an oversight: it is tracked as issue 357, and the decision belongs to whoever
 * clones a repository that carries a `.gitattributes` naming a program.
 *
 * Three properties of a child are load-bearing for the reads this module makes, and all three
 * live here rather than at the call sites because each one has a way of failing *open*:
 *
 * - **A non-numeric error never resolves.** `allowExitCodes` names real exit codes, so only a real
 *   exit code can satisfy it. A `maxBuffer` overrun, a missing `git`, a signal or a timeout all
 *   arrive with a string code, a null code, or no code at all, and each of them used to be read as
 *   exit 1 — which `git config --get-regexp` uses for "no match". A signing read that resolved on a
 *   truncated answer would pin nothing and let a repository's configuration through untouched. A
 *   child killed by an abort or by the timeout below has no exit code at all, which is a failure
 *   and not a 1: `removeAgentWorktree` accepts 1 and 128 as "already gone", and reading a kill as
 *   either would report a cleanup that never happened as one that did.
 * - **stdin is closed, not an open pipe.** A signer that reads stdin — an ssh key with a
 *   passphrase and no agent, a loopback pinentry — otherwise waits on a pipe nobody will ever
 *   write to, for as long as the session lasts. Only the calls that write a patch get one.
 * - **A call that can start a program is bounded, and can be stopped.** A signing program that
 *   never returns is the same hang from the other side, so every call carries
 *   {@link DEFAULT_GIT_TIMEOUT_MS} unless it names its own, and the agent controller's signal is
 *   threaded through the calls that have one so a stopped agent stops its git too (#357).
 *
 * And the environment is not the operator's shell environment: an ambient `GIT_DIR` or
 * `GIT_INDEX_FILE` would redirect Book's own writes into another checkout, which is a write
 * nobody asked about in a repository nobody named. See {@link internalGitEnv}.
 */
function run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  const env = internalGitEnv(options.env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const signal = options.signal;
  if (options.input !== undefined) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      // `close` and a stdin write can both report the same failed command, and a spawn that
      // never happened reports twice. One outcome, whichever arrives first (#351).
      let settled = false;
      const settle = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        outcome();
      };
      // How this child was stopped, when it was: the reason is what the message says, and a
      // `close` handler that only sees `signal: SIGTERM` cannot tell a timeout from an abort.
      let stoppedBy: 'timeout' | 'aborted' | undefined;
      const stopChild = (reason: 'timeout' | 'aborted') => {
        if (stoppedBy === undefined) stoppedBy = reason;
        child.kill('SIGTERM');
      };
      const onAbort = () => stopChild('aborted');
      const timer = timeoutMs > 0 ? setTimeout(() => stopChild('timeout'), timeoutMs) : undefined;
      timer?.unref?.();
      // An already-aborted signal must not start the child at all: the work it was asked to do is
      // over, and a child started now would outlive the abort that was supposed to stop it.
      if (signal?.aborted) {
        stopChild('aborted');
      } else {
        signal?.addEventListener('abort', onAbort, { once: true });
      }
      // A stdin failure worth acting on is remembered rather than acted on, because `close` is
      // the only event that knows the exit code, and the exit code is what decides. Settling here
      // instead would reject before git had written the stderr that explains the failure.
      let stdinError: Error | undefined;
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      // A read stream can fail on its own — a pipe closed as the child goes, a host under
      // pressure — and a stream with no `error` listener raises that on the host's event loop,
      // which takes down whatever session was mid-flow. Remembered and weighed by `close` for the
      // same reason the stdin error is: the exit code is the thing that decides.
      let outputError: Error | undefined;
      child.stdout.on('error', (error: Error) => (outputError ??= error));
      child.stderr.on('error', (error: Error) => (outputError ??= error));
      child.on('error', (error) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        settle(() => reject(error));
      });
      child.on('close', (codeValue, closedBySignal) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        settle(() => {
          // A child with no exit code has none to reason about, so it is a failure whatever
          // `allowExitCodes` names — including the timeout this call set for it and the abort
          // that stopped it. `codeValue ?? 1` made every kill indistinguishable from the exit 1
          // git uses for "no such branch" (#357).
          const code = typeof codeValue === 'number' ? codeValue : undefined;
          if (code === undefined) {
            reject(
              new Error(
                stderr.trim() ||
                  stdout.trim() ||
                  outputError?.message ||
                  stdinError?.message ||
                  stoppedDescription(command, args, stoppedBy, closedBySignal, timeoutMs),
              ),
            );
            return;
          }
          if (code === 0 || options.allowExitCodes?.includes(code)) {
            resolvePromise({ stdout, stderr, code });
            return;
          }
          // What git said comes first: a stdin error on a failed command is a consequence of it,
          // and its own message is the one with no information in it. The stdin error is the
          // fallback for a git that exited without a word.
          reject(
            new Error(
              stderr.trim() ||
                stdout.trim() ||
                stdinError?.message ||
                `${command} ${subcommandOf(args)} failed (${code})`,
            ),
          );
        });
      });
      // Never removed, and attached before the write: git that exits without reading the patch —
      // not a repository, a rejected argument — leaves that write to fail with EPIPE, and a
      // stream carrying no `error` listener raises the failure on the host's event loop instead
      // of on this promise. `EPIPE` and `EOF` mean git was gone before it read, which the exit
      // code has already accounted for and is not news; anything else is a real failure, and is
      // kept for `close` to weigh.
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EPIPE' || error.code === 'EOF') return;
        stdinError ??= error;
      });
      child.stdin.end(options.input);
    });
  }

  return new Promise((resolvePromise, reject) => {
    let settled = false;
    // Both closures below read `timer`, which is assigned after `child`: `execFile`'s callback is
    // always asynchronous, so nothing settles before there is a timer to clear.
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      outcome();
    };
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env,
        encoding: 'utf8',
        // One buffer for every call: a signing read that overruns it has to fail rather than
        // resolve on a prefix, and this size is what makes that impractical rather than what makes
        // it correct.
        maxBuffer: 50 * 1024 * 1024,
        // No `timeout` option here. `execFile`'s own timeout kills the child but still waits for
        // its output to close, and a grandchild holding that pipe — a shell script, a
        // `credential.helper` that started something of its own — means it never does, so the
        // callback that would report the timeout may never arrive. The timer below is the one that
        // both kills and settles.
        signal,
      },
      (error, stdout, stderr) => {
        // Node reports a failure three ways and only one of them is an exit code: `killed` and
        // `signal` cover a timeout and a signal, and a `maxBuffer` overrun or a missing binary
        // arrives as a string in `code`. None of those may resolve as if it were the "no match"
        // that exit 1 means, so an exit code is used only where there is one.
        const code = exitCodeOf(error);
        if (code === undefined) {
          settle(() =>
            reject(
              new Error(
                failureDescription(
                  error,
                  stderr || stdout,
                  command,
                  args,
                  timeoutMs,
                  signal?.aborted === true,
                ),
              ),
            ),
          );
          return;
        }
        if (code === 0 || options.allowExitCodes?.includes(code)) {
          settle(() => resolvePromise({ stdout, stderr, code }));
          return;
        }
        settle(() =>
          reject(
            new Error(
              // git's own words first, because they are the ones that say what went wrong. Then the
              // composed message, and not Node's: with no output to prefer, Node's is the whole argv
              // — hardening pairs included — which names `-c` where a reader needs the subcommand,
              // and says nothing that the exit code does not (#357).
              stderr.trim() || stdout.trim() || `${command} ${subcommandOf(args)} failed (${code})`,
            ),
          ),
        );
      },
    );
    // The call this timer bounds, settled by the timer itself: the child is killed outright, so
    // nothing it started survives it, and the promise rejects without waiting for output that may
    // never close (#357).
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            child.kill('SIGKILL');
            settle(() =>
              reject(
                new Error(
                  failureDescription({ killed: true }, '', command, args, timeoutMs, false),
                ),
              ),
            );
          }, timeoutMs)
        : undefined;
    timer?.unref?.();
    // `execFile` leaves the child's stdin an open pipe that nothing will ever write to, and a
    // child that reads it waits for an end that never comes: an ssh signer asking for a passphrase,
    // a pinentry on a loopback socket. Closing it now is what makes such a read fail, which is
    // what a command Book did not choose to read input from should do. (Checked against a real
    // git: a program that reads stdin to the end otherwise holds its call open indefinitely.)
    child.stdin?.end();
  });
}

/**
 * How long any call in this module may take before it is killed.
 *
 * Generous on purpose: the longest call here is the cherry-pick that applies an agent's result, on
 * a large repository, and killing it costs the operator a re-apply. What this buys is that a git
 * which never exits — a signing program waiting on an agent that is not there, a filesystem that
 * has stopped answering, a `credential.helper` prompt Book cannot see — cannot hold a call, and
 * through it a session, open forever (#357). The cherry-pick still names its own, longer budget.
 */
const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/**
 * The subcommand an argv actually runs, for a message that has to name it.
 *
 * Every argv here arrives with the hardening's `-c key=value` pairs in front of it, and a message
 * built from `args[0]` therefore names `-c`: the manifest read reported `git -c failed`, which
 * names a flag and tells a reader nothing about which command died (#357).
 */
function subcommandOf(args: readonly string[]): string {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    // `-c key=value` and `-C <path>` each take the next argument as their value, so the value is
    // not mistaken for the subcommand. `--key=value` carries its own.
    if (arg === '-c' || arg === '-C') {
      index++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return '(no subcommand)';
}

/** What a child that produced no exit code is reported as, naming the command that produced it. */
function stoppedDescription(
  command: string,
  args: readonly string[],
  stoppedBy: 'timeout' | 'aborted' | undefined,
  closedBySignal: NodeJS.Signals | null,
  timeoutMs: number,
): string {
  const invocation = `${command} ${subcommandOf(args)}`;
  if (stoppedBy === 'timeout') {
    return `${invocation} timed out after ${timeoutMs}ms and was killed`;
  }
  if (stoppedBy === 'aborted') return `${invocation} was cancelled`;
  if (closedBySignal) return `${invocation} was killed with ${closedBySignal}`;
  return `${invocation} was killed and produced no result`;
}

/**
 * How a child process can fail without ever producing an exit code.
 *
 * Every field is optional because each shape arrives from somewhere different: Node's own failure
 * object, a spawn that never happened, and the placeholder this module builds when its own timer
 * fires and settles the promise before Node reports anything.
 */
interface ProcessFailure {
  name?: string;
  message?: string;
  code?: number | string;
  killed?: boolean;
  signal?: string | null;
}

/** A child's exit code, or `undefined` for anything that is not one — which is a failure, not a 1. */
function exitCodeOf(error: ProcessFailure | null): number | undefined {
  // No error at all is the success case, and it is the one shape of "no exit code" that is not a
  // failure: `execFile` reports it by passing `null`, not by passing a code.
  if (!error) return 0;
  if (error.killed || error.signal) return undefined;
  // An abort arrives as an `AbortError` with no code at all, which is not an exit code either.
  if (isAbortError(error)) return undefined;
  return typeof error.code === 'number' ? error.code : undefined;
}

/** Whether a failure is the one Node raises for an aborted call, which carries no exit code. */
function isAbortError(error: ProcessFailure | null): boolean {
  return error?.name === 'AbortError' || (error as { code?: unknown } | null)?.code === 'ABORT_ERR';
}

function failureDescription(
  error: ProcessFailure | null,
  output: string,
  command: string,
  args: readonly string[],
  timeoutMs: number,
  aborted: boolean,
): string {
  const invocation = `${command} ${subcommandOf(args)}`;
  if (aborted || isAbortError(error)) return `${invocation} was cancelled`;
  if (error?.killed) return `${invocation} timed out after ${timeoutMs}ms and was killed`;
  if (error?.signal) return `${invocation} was killed with ${error.signal}`;
  if (typeof error?.code === 'string') return `${invocation} failed: ${error.code}`;
  return output.trim() || error?.message || `${invocation} failed`;
}

/**
 * The environment Book's own git runs with, which is not the operator's shell environment.
 *
 * `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_COMMON_DIR` and the
 * rest of git's repository-selection variables outrank the directory a call is started in: a
 * shell that exported `GIT_DIR` to work inside a bare repository, a CI step, a hook, or a CI job
 * that shares a runner is enough. Every call in this module is *Book's* write to a repository the
 * caller named — a snapshot object, a worktree, a branch, a commit on the operator's branch — so
 * an ambient one of those would send those writes somewhere nobody asked about, and a stray
 * `GIT_INDEX_FILE` would stage an agent's work into the wrong index.
 *
 * What is kept is the two kinds that are not a repository pointer:
 *
 * - **`GIT_AUTHOR_*` and `GIT_COMMITTER_*`**, which are identity rather than location. They are
 *   how a caller names the author of a commit Book is about to make on its behalf, and
 *   {@link gitIdentityEnv} sets the same four for Book's own commits.
 * - **`GIT_CONFIG_*`**, which choose *which configuration* git reads rather than *what it
 *   operates on*. This module reads configuration on purpose — that is what decides how the
 *   cherry-pick signs — so an operator who points `GIT_CONFIG_GLOBAL` at their own file, or a
 *   hermetic test that points it at an empty one, is being obeyed rather than overridden.
 */
function internalGitEnv(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const ambient = buildChildEnv(process.env);
  for (const name of Object.keys(ambient)) {
    if (!name.startsWith('GIT_')) continue;
    if (name.startsWith('GIT_AUTHOR_') || name.startsWith('GIT_COMMITTER_')) continue;
    if (name.startsWith('GIT_CONFIG_')) continue;
    delete ambient[name];
  }
  // The call site's own environment is spread last, so a `GIT_INDEX_FILE` naming a temporary
  // index — the snapshot's, the pre-check's — is Book's own decision and outranks the ambient one
  // it has just removed.
  return { ...ambient, ...hardenedGitEnv(), ...overrides };
}

/** git, with the argv hardening that belongs to git and not to {@link run}. */
function git(
  cwd: string,
  args: string[],
  options: Omit<RunOptions, 'cwd'> = {},
): Promise<RunResult> {
  return run('git', hardenedGitArgs(args), { ...options, cwd });
}

/**
 * {@link git}, exported for tests only, and reached through `git-isolation-internal.ts` rather than
 * from here: see that module for why.
 *
 * No exported path reaches `git()`'s `input` branch without a real snapshot, and #351 needs a patch
 * git exits on before reading it.
 */
export const gitForTest = git;

/** The runner `git-signing.ts` reads the signing configuration through; see {@link HardenedRunner}. */
const hardenedRunner: HardenedRunner = run;

/**
 * What Book reports about a cherry-pick that failed, given what the pick left behind and what the
 * rollback itself did.
 *
 * Two questions have separate answers and used to share one sentence. **Was it rolled back?** only
 * the `cherry-pick --abort` that ran afterwards can say, and that call can fail — a repository
 * that is no longer one, a lock it cannot take — so a swallowed abort turned a pick that is still
 * in progress into "rolled back", and an operator reading that would commit their next change into
 * the agent's pick (#357). **Was it a conflict?** only the working tree can say: unmerged paths and
 * markers are a conflict, while a signing failure, a filter that would not run, or a repository
 * that is read-only is the machinery failing, and calling those conflicts sends the reader looking
 * for markers that are not there.
 *
 * Reached through `git-isolation-internal.ts`, which is where the test-only exports live; see that
 * module for why this one is among them.
 */
export function cherryPickFailureResult(facts: {
  /** What the cherry-pick said when it failed. */
  pickError: string;
  /** What `cherry-pick --abort` said, when it failed rather than rolling the pick back. */
  abortError?: string;
  /** The paths the pick left unmerged, read before the abort removed them. */
  unmergedPaths: readonly string[];
}): AgentApplyResult {
  const conflicted = facts.unmergedPaths.length > 0;
  if (facts.abortError) {
    return {
      status: conflicted ? 'conflicted' : 'not_applied',
      error: `Cherry-pick failed (${facts.pickError}) and the rollback did not complete (${facts.abortError}), so this repository may be left mid-cherry-pick: finish it with git cherry-pick --continue or undo it with git cherry-pick --abort.`,
    };
  }
  return {
    status: conflicted ? 'conflicted' : 'not_applied',
    error: `Cherry-pick failed and was rolled back: ${facts.pickError}`,
  };
}

function gitIdentityEnv(): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: 'Book Agent',
    GIT_AUTHOR_EMAIL: 'agents@book.local',
    GIT_COMMITTER_NAME: 'Book Agent',
    GIT_COMMITTER_EMAIL: 'agents@book.local',
  };
}

function tempIndex(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'book-index-'));
  return { dir, path: join(dir, 'index') };
}

export async function findGitRoot(
  workspace: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    return (await git(workspace, ['rev-parse', '--show-toplevel'], { signal })).stdout.trim();
  } catch {
    return undefined;
  }
}

export function repositoryHash(repoRoot: string): string {
  return createHash('sha256').update(resolve(repoRoot).toLowerCase()).digest('hex').slice(0, 20);
}

async function writeWorkspaceTree(
  repoRoot: string,
  includeUntracked: boolean,
  signal?: AbortSignal,
): Promise<{ head: string; tree: string; status: string }> {
  const index = tempIndex();
  try {
    const env = { GIT_INDEX_FILE: index.path };
    const head = (await git(repoRoot, ['rev-parse', 'HEAD'], { signal })).stdout.trim();
    await git(repoRoot, ['read-tree', head], { env, signal });
    await git(repoRoot, includeUntracked ? ['add', '-A', '--', '.'] : ['add', '-u', '--', '.'], {
      env,
      signal,
    });
    const tree = (await git(repoRoot, ['write-tree'], { env, signal })).stdout.trim();
    const status = (
      await git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'], { signal })
    ).stdout;
    return { head, tree, status };
  } finally {
    rmSync(index.dir, { recursive: true, force: true });
  }
}

export async function currentWorkspaceFingerprint(
  repoRoot: string,
  includeUntracked: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const { head, tree } = await writeWorkspaceTree(repoRoot, includeUntracked, signal);
  return `${head}:${tree}`;
}

/**
 * The caller's own signal, threaded through every git this snapshot makes.
 *
 * A stopped agent still has this snapshot to finish, and `git status` over a large checkout is
 * exactly the call that takes minutes: without the signal the stop is a request that the snapshot
 * only hears when it is over. The per-call {@link DEFAULT_GIT_TIMEOUT_MS} remains the floor, for a
 * caller with no signal to pass.
 */
export async function createSyntheticSnapshot(
  workspace: string,
  includeUntracked = true,
  signal?: AbortSignal,
): Promise<AgentSnapshot> {
  const repoRoot = await findGitRoot(workspace, signal);
  if (!repoRoot) {
    throw new Error(
      'Managed agents require a Git workspace with at least one commit. Use --agents off for this workspace.',
    );
  }
  const id = randomUUID();
  const { head, tree, status } = await writeWorkspaceTree(repoRoot, includeUntracked, signal);
  const commit = (
    await git(repoRoot, ['commit-tree', tree, '-p', head, '-m', `book synthetic snapshot ${id}`], {
      env: gitIdentityEnv(),
      signal,
    })
  ).stdout.trim();
  const repoHash = repositoryHash(repoRoot);
  const ref = `refs/book/snapshots/${repoHash}/${id}`;
  await git(repoRoot, ['update-ref', ref, commit], { signal });

  const manifestOutput = (
    await git(
      repoRoot,
      [
        '-c',
        'core.quotepath=false',
        'diff-tree',
        '--no-commit-id',
        '--name-status',
        '-r',
        '-M',
        head,
        commit,
      ],
      { signal },
    )
  ).stdout;
  const manifest = manifestOutput
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [statusCode, ...paths] = line.split('\t');
      return { status: statusCode, path: paths.join(' -> ') };
    });

  return {
    id,
    repoRoot,
    repoHash,
    baseHead: head,
    commit,
    tree,
    ref,
    fingerprint: `${head}:${tree}`,
    dirty: status.trim().length > 0,
    includeUntracked,
    manifest,
    createdAt: Date.now(),
  };
}

/** Where agent worktrees live when a host does not override the root. */
export function defaultWorktreeRoot(): string {
  return join(resolveBookHome(), 'worktrees');
}

/** Whether a branch is already in the repository, which decides who may delete it afterwards. */
async function branchExists(
  repoRoot: string,
  branch: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await git(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    allowExitCodes: [1],
    signal,
  });
  return result.code === 0;
}

/**
 * Delete a branch Book created, best effort, and only one Book created.
 *
 * `worktree add -b` creates the branch before it checks out, so a checkout that is refused after
 * that point — a path that is already a file, a directory that is not empty, a start commit that
 * does not resolve — leaves the branch behind and every retry fails with `already exists`, which
 * reads like the agent's work is still there rather than like a branch Book leaked (#357). The
 * caller checks whether the branch was there first: a branch that already existed is the
 * operator's, with their commits on it, and `branch -D` on it would destroy work Book never made.
 */
async function deleteBranchBookCreated(
  repoRoot: string,
  branch: string,
  existed: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (existed) return;
  await git(repoRoot, ['branch', '-D', branch], { allowExitCodes: [1, 128], signal }).catch(
    () => {},
  );
}

export async function createAgentWorktree(
  snapshot: AgentSnapshot,
  agentId: string,
  worktreeRoot = defaultWorktreeRoot(),
  startCommit = snapshot.commit,
  signal?: AbortSignal,
): Promise<{ path: string; branch: string }> {
  const path = join(worktreeRoot, snapshot.repoHash, agentId);
  const branch = `book-agent/${snapshot.repoHash}/${agentId}`;
  // A worktree Book already made is adopted as it is, so a run that finds its own directory from a
  // previous attempt does not fail on it. Anything else at that path is git's business: a file, or
  // a directory with something in it, is refused by `worktree add` with a real error, which is the
  // only outcome that says the worktree does not exist rather than reporting one that does (#357).
  if (existsSync(join(path, '.git'))) return { path, branch };
  mkdirSync(dirname(path), { recursive: true });
  // Read before the add, because it is what the add's own branch is worth cleaning up: only a
  // branch that did not exist before this call is one this call created.
  const existed = await branchExists(snapshot.repoRoot, branch, signal);
  try {
    await git(snapshot.repoRoot, ['worktree', 'add', '-b', branch, path, startCommit], { signal });
  } catch (error) {
    await deleteBranchBookCreated(snapshot.repoRoot, branch, existed, signal);
    throw error;
  }
  return { path, branch };
}

/**
 * Where the cleanup git runs from, which is never the directory it is deleting.
 *
 * `worktree remove` deletes the directory it is told to, and a process whose working directory is
 * a directory that is being removed is in a state the platform does not always allow to finish:
 * Windows will not delete a directory that is a process's cwd, and a `branch -D` that follows from
 * inside it fails too, which leaves the branch behind on every cleanup (#357).
 *
 * So the repository is named, not guessed: the caller's own `repoRoot` when it has one, and
 * otherwise the repository the worktree belongs to, which is outside it — its `.git` file points at
 * `<repo>/.git/worktrees/<name>`, and git runs from there as well as from `<repo>/.git`, which is
 * the directory that survives the removal the cleanup is doing. Only a worktree with no pointer left
 * is a fallback to its parent, and that is the case this is for: a directory that is no longer a
 * repository at all, where running from inside it finds nothing and both calls fail silently.
 */
function removalRoot(record: AgentRecord, repoRoot: string | undefined): string {
  if (repoRoot && resolve(repoRoot) !== resolve(record.worktree!)) return repoRoot;
  const pointed = repositoryOfWorktree(record.worktree!);
  if (pointed && existsSync(pointed)) return pointed;
  return dirname(record.worktree!);
}

/**
 * The repository a worktree belongs to, which lives outside the worktree.
 *
 * A linked worktree has no `.git` directory of its own: its `.git` is a file whose one line names
 * the administrative directory git keeps for it, `<repo>/.git/worktrees/<name>`. Reading that
 * pointer is what lets a cleanup run from the repository instead of from the checkout it is about
 * to delete. It is not the administrative directory itself that is used, because `worktree remove`
 * deletes that along with the checkout — a process whose working directory has just been removed
 * fails to start anything at all, on every platform, so the second call would never run. Two levels
 * up is `<repo>/.git` for an ordinary repository and the bare repository itself for a bare one, and
 * git resolves a repository from both.
 */
function repositoryOfWorktree(worktree: string): string | undefined {
  try {
    const pointer = readFileSync(join(worktree, '.git'), 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/m.exec(pointer);
    return match?.[1]?.trim() ? dirname(dirname(match[1].trim())) : undefined;
  } catch {
    return undefined;
  }
}

export async function removeAgentWorktree(record: AgentRecord, repoRoot?: string): Promise<void> {
  if (!record.worktree || !record.branch) return;
  const root = removalRoot(record, repoRoot);
  await git(root, ['worktree', 'remove', '--force', record.worktree], {
    allowExitCodes: [128],
  }).catch(() => {});
  await git(root, ['branch', '-D', record.branch], { allowExitCodes: [1, 128] }).catch(() => {});
}

export async function removeSnapshotRef(snapshot: AgentSnapshot): Promise<void> {
  await git(snapshot.repoRoot, ['update-ref', '-d', snapshot.ref], { allowExitCodes: [1] }).catch(
    () => {},
  );
}

export async function checkoutAgentCommit(worktree: string, commit: string): Promise<void> {
  await git(worktree, ['reset', '--hard', commit]);
}

export async function commitAgentWork(
  record: AgentRecord,
  snapshot: AgentSnapshot,
): Promise<PatchCandidate | undefined> {
  if (!record.worktree || !record.branch) return undefined;
  await git(record.worktree, ['add', '-A', '--', '.']);
  const diff = await git(record.worktree, ['diff', ...HARDENED_DIFF_ARGS, '--cached', '--quiet'], {
    allowExitCodes: [1],
  });
  if (diff.code === 0) return undefined;
  // Belt and braces on both counts. `core.hooksPath=` already leaves `pre-commit` and `commit-msg`
  // nothing to find, and this commit is Book's work in Book's worktree rather than the
  // operator's own, so neither of them should decide whether it happens. `--no-gpg-sign` is not
  // belt and braces: `commit.gpgSign` and `gpg.program` are configuration this commit would
  // otherwise honor, and the identity it commits under — `Book Agent <agents@book.local>` — has
  // no key on any machine, so every patcher commit would fail outright, or hang a headless run on
  // pinentry, or start whatever program the configuration names. The cherry-pick that applies this
  // work to the operator's branch is a different question: that commit is the operator's own, in
  // their history, under their identity, so it still signs — and `git-signing.ts` is what decides
  // which configuration that signing reads.
  await git(
    record.worktree,
    ['commit', '--no-verify', '--no-gpg-sign', '-m', `book agent ${record.id}: ${record.name}`],
    {
      env: gitIdentityEnv(),
    },
  );
  const headCommit = (await git(record.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
  return {
    baseCommit: snapshot.commit,
    headCommit,
    branch: record.branch,
    agentId: record.id,
  };
}

async function candidateDelta(
  snapshot: AgentSnapshot,
  candidate: PatchCandidate,
  signal?: AbortSignal,
): Promise<string> {
  return (
    await git(
      snapshot.repoRoot,
      [
        'diff',
        ...HARDENED_DIFF_ARGS,
        '--binary',
        '--full-index',
        candidate.baseCommit,
        candidate.headCommit,
        '--',
      ],
      { signal },
    )
  ).stdout;
}

async function precheckDelta(
  snapshot: AgentSnapshot,
  patch: string,
  signal?: AbortSignal,
): Promise<void> {
  const index = tempIndex();
  try {
    const env = { GIT_INDEX_FILE: index.path };
    await git(snapshot.repoRoot, ['read-tree', snapshot.commit], { env, signal });
    await git(snapshot.repoRoot, ['apply', '--3way', '--check', '--cached', '-'], {
      env,
      input: patch,
      signal,
    });
    await git(snapshot.repoRoot, ['apply', '--check', '-'], { input: patch, signal });
  } finally {
    rmSync(index.dir, { recursive: true, force: true });
  }
}

/** How long the cherry-pick may take before it is killed and the pick it started is aborted. */
const CHERRY_PICK_TIMEOUT_MS = 300_000;

/**
 * Whether the repository is in the middle of a cherry-pick somebody else started.
 *
 * `CHERRY_PICK_HEAD` is git's own record of one, and `rev-parse --verify` answers "no" with exit
 * 1 rather than an error, which is why this asks for it and reads the answer rather than trusting
 * a quiet repository to mean no pick. It is checked before anything is written, and the `--abort`
 * in {@link applyVerifiedCandidate} runs only for a pick that call started.
 */
async function hasPendingCherryPick(repoRoot: string, signal?: AbortSignal): Promise<boolean> {
  const result = await git(repoRoot, ['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'], {
    allowExitCodes: [1],
    signal,
  });
  return result.code === 0;
}

/**
 * The paths a failed cherry-pick left unmerged, which is what makes a failure a conflict.
 *
 * Read before the abort, because the abort is what removes them: afterwards there is nothing left
 * to distinguish a conflict from a signing failure that left the same `CHERRY_PICK_HEAD` behind.
 * Read with the diff drivers off, so this never starts the program a checkout names to produce it.
 */
async function unmergedPathsAfterFailure(repoRoot: string): Promise<string[]> {
  try {
    const result = await git(repoRoot, [
      'diff',
      ...HARDENED_DIFF_ARGS,
      '--name-only',
      '--diff-filter=U',
    ]);
    return result.stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    // A read that failed cannot say there was no conflict, and it must not turn a known failure
    // into an unknown status either: the caller reports the pick failure, and the conflict claim
    // is left out rather than invented.
    return [];
  }
}

export async function applyVerifiedCandidate(
  snapshot: AgentSnapshot,
  candidate: PatchCandidate,
  signal?: AbortSignal,
): Promise<AgentApplyResult> {
  if (candidate.baseCommit !== snapshot.commit) {
    return {
      status: 'conflicted',
      error: 'Patch candidate base does not match the task snapshot.',
    };
  }
  const actualHead = (
    await git(snapshot.repoRoot, ['rev-parse', candidate.headCommit])
  ).stdout.trim();
  if (actualHead !== candidate.headCommit) {
    return { status: 'conflicted', error: 'Patch candidate commit no longer resolves exactly.' };
  }

  // Somebody else's interrupted cherry-pick is the operator's, and it owns the working tree this
  // would write to. Book starts a cherry-pick only to be able to abort the one it started, so a
  // pick it did not start is a pick it must leave exactly as it found it.
  if (await hasPendingCherryPick(snapshot.repoRoot, signal)) {
    return {
      status: 'conflicted',
      error:
        'A cherry-pick is already in progress in this repository. Book did not start it and will not abort it; finish it (git cherry-pick --continue) or undo it (git cherry-pick --abort), then apply the agent result again.',
    };
  }

  const current = await currentWorkspaceFingerprint(
    snapshot.repoRoot,
    snapshot.includeUntracked,
    signal,
  );
  if (current !== snapshot.fingerprint) {
    return {
      status: 'conflicted',
      error: 'Parent workspace drifted after the agent snapshot; no changes were applied.',
    };
  }

  const patch = await candidateDelta(snapshot, candidate, signal);
  try {
    await precheckDelta(snapshot, patch, signal);
  } catch (error) {
    return {
      status: 'conflicted',
      error: `Patch pre-check failed; no changes were applied: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!snapshot.dirty) {
    // Signing is what this closes for the cherry-pick: it is the only call here that writes a
    // commit into the operator's history, so it is the only one that signs, and a
    // repository-local `commit.gpgSign` with a `gpg.program` of its own is a program Book would
    // start, in a flow nothing asked about (#348). The commit still signs, and signs as the
    // operator configured, because the pins carry their own value forward — see `git-signing.ts`
    // for what is read, from where, and the one signing shape that cannot be carried over.
    // Filters and merge drivers still run on this checkout, deliberately, because git-lfs depends
    // on them (#357); they are configuration a repository can own in a way signing now is not.
    //
    // The read is a separate step, before the `try` below, because it is not a cherry-pick: a
    // failure here means no pick has started, and reporting it as a rolled-back pick would be
    // wrong twice over — it would blame the pick for a read that never reached one, and the
    // `--abort` would follow to a repository that has nothing to abort.
    let signingPins: string[];
    try {
      signingPins = await signingPinArgs(snapshot.repoRoot, hardenedRunner);
    } catch (error) {
      return {
        status: 'conflicted',
        error: `Could not read the signing configuration for the cherry-pick: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    try {
      // Bounded because this is the one call that can start a program the operator named: a
      // signer waiting on a passphrase it will never be given is a hang, and an unbounded one
      // would outlive the session. The abort below then cleans up the pick this call started.
      await git(snapshot.repoRoot, [...signingPins, 'cherry-pick', candidate.headCommit], {
        timeoutMs: CHERRY_PICK_TIMEOUT_MS,
        signal,
      });
      const appliedCommit = (
        await git(snapshot.repoRoot, ['rev-parse', 'HEAD'], { signal })
      ).stdout.trim();
      return { status: 'applied', commit: appliedCommit };
    } catch (error) {
      // Read what the pick left behind before the rollback removes it, and report whether the
      // rollback actually ran: see {@link cherryPickFailureResult} for why those are two
      // questions and not one.
      const unmergedPaths = await unmergedPathsAfterFailure(snapshot.repoRoot);
      let abortError: string | undefined;
      try {
        // Exit 128 is `no cherry-pick in progress`, which for a pick that just failed is a
        // rollback that had nothing to do rather than one that failed. Anything else is a real
        // failure and is reported as one.
        await git(snapshot.repoRoot, ['cherry-pick', '--abort'], { allowExitCodes: [128] });
      } catch (abortFailure) {
        abortError = abortFailure instanceof Error ? abortFailure.message : String(abortFailure);
      }
      return cherryPickFailureResult({
        pickError: error instanceof Error ? error.message : String(error),
        abortError,
        unmergedPaths,
      });
    }
  }

  try {
    await git(snapshot.repoRoot, ['apply', '-'], { input: patch, signal });
    return { status: 'applied', commit: candidate.headCommit };
  } catch (error) {
    return {
      status: 'conflicted',
      error: `Patch application failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
