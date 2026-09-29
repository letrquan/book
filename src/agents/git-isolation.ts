import { createHash, randomUUID } from 'crypto';
import { execFile, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
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
 * Three properties of a child are load-bearing for the reads this module makes, and all three
 * live here rather than at the call sites because each one has a way of failing *open*:
 *
 * - **A non-numeric error never resolves.** `allowExitCodes` names real exit codes, so only a real
 *   exit code can satisfy it. A `maxBuffer` overrun, a missing `git`, a signal or a timeout all
 *   arrive with a string code, a null code, or no code at all, and each of them used to be read as
 *   exit 1 — which `git config --get-regexp` uses for "no match". A signing read that resolved on a
 *   truncated answer would pin nothing and let a repository's configuration through untouched.
 * - **stdin is closed, not an open pipe.** A signer that reads stdin — an ssh key with a
 *   passphrase and no agent, a loopback pinentry — otherwise waits on a pipe nobody will ever
 *   write to, for as long as the session lasts. Only the calls that write a patch get one.
 * - **A call that can start a program is bounded.** A signing program that never returns is the
 *   same hang from the other side.
 */
function run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  const env = buildChildEnv(process.env, { ...hardenedGitEnv(), ...options.env });
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
      // A stdin failure worth acting on is remembered rather than acted on, because `close` is
      // the only event that knows the exit code, and the exit code is what decides. Settling here
      // instead would reject before git had written the stderr that explains the failure.
      let stdinError: Error | undefined;
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      child.on('error', (error) => settle(() => reject(error)));
      child.on('close', (codeValue, signal) => {
        settle(() => {
          // A signalled child has no exit code to reason about, so it is a failure whatever
          // `allowExitCodes` names — including the timeout this call set for it.
          if (signal !== null) {
            reject(
              new Error(stderr.trim() || stdinError?.message || `git was killed with ${signal}`),
            );
            return;
          }
          const code = codeValue ?? 1;
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
                `git ${args[0]} failed (${code})`,
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
        timeout: options.timeoutMs,
      },
      (error, stdout, stderr) => {
        // Node reports a failure three ways and only one of them is an exit code: `killed` and
        // `signal` cover a timeout and a signal, and a `maxBuffer` overrun or a missing binary
        // arrives as a string in `code`. None of those may resolve as if it were the "no match"
        // that exit 1 means, so an exit code is used only where there is one.
        const code = exitCodeOf(error);
        if (code === undefined) {
          reject(new Error(failureDescription(error, stderr, command)));
          return;
        }
        if (code === 0 || options.allowExitCodes?.includes(code)) {
          resolvePromise({ stdout, stderr, code });
          return;
        }
        reject(
          new Error(
            stderr.trim() || stdout.trim() || error?.message || `${command} failed (${code})`,
          ),
        );
      },
    );
    // `execFile` leaves the child's stdin an open pipe that nothing will ever write to, and a
    // child that reads it waits for an end that never comes: an ssh signer asking for a passphrase,
    // a pinentry on a loopback socket. Closing it now is what makes such a read fail, which is
    // what a command Book did not choose to read input from should do. (Checked against a real
    // git: a program that reads stdin to the end otherwise holds its call open indefinitely.)
    child.stdin?.end();
  });
}

/** How a child process can fail without ever producing an exit code. */
interface ProcessFailure extends Error {
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
  return typeof error.code === 'number' ? error.code : undefined;
}

function failureDescription(error: ProcessFailure | null, stderr: string, command: string): string {
  if (error?.killed) return `${command} was killed after its timeout and produced no result`;
  if (error?.signal) return `${command} was killed with ${error.signal}`;
  if (typeof error?.code === 'string') return `${command} failed: ${error.code}`;
  return stderr.trim() || error?.message || `${command} failed`;
}

/** git, with the argv hardening that belongs to git and not to {@link run}. */
function git(
  cwd: string,
  args: string[],
  options: Omit<RunOptions, 'cwd'> = {},
): Promise<RunResult> {
  return run('git', hardenedGitArgs(args), { ...options, cwd });
}

/** The runner `git-signing.ts` reads the signing configuration through; see {@link HardenedRunner}. */
const hardenedRunner: HardenedRunner = run;

/** Exported only for `git-isolation.test.ts`: no exported path reaches `git()`'s `input` branch
 * without a real snapshot, and #351 needs a patch git exits on before reading. */
export const gitForTest = git;

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

export async function findGitRoot(workspace: string): Promise<string | undefined> {
  try {
    return (await git(workspace, ['rev-parse', '--show-toplevel'])).stdout.trim();
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
): Promise<{ head: string; tree: string; status: string }> {
  const index = tempIndex();
  try {
    const env = { GIT_INDEX_FILE: index.path };
    const head = (await git(repoRoot, ['rev-parse', 'HEAD'])).stdout.trim();
    await git(repoRoot, ['read-tree', head], { env });
    await git(repoRoot, includeUntracked ? ['add', '-A', '--', '.'] : ['add', '-u', '--', '.'], {
      env,
    });
    const tree = (await git(repoRoot, ['write-tree'], { env })).stdout.trim();
    const status = (await git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']))
      .stdout;
    return { head, tree, status };
  } finally {
    rmSync(index.dir, { recursive: true, force: true });
  }
}

export async function currentWorkspaceFingerprint(
  repoRoot: string,
  includeUntracked: boolean,
): Promise<string> {
  const { head, tree } = await writeWorkspaceTree(repoRoot, includeUntracked);
  return `${head}:${tree}`;
}

export async function createSyntheticSnapshot(
  workspace: string,
  includeUntracked = true,
): Promise<AgentSnapshot> {
  const repoRoot = await findGitRoot(workspace);
  if (!repoRoot) {
    throw new Error(
      'Managed agents require a Git workspace with at least one commit. Use --agents off for this workspace.',
    );
  }
  const id = randomUUID();
  const { head, tree, status } = await writeWorkspaceTree(repoRoot, includeUntracked);
  const commit = (
    await git(repoRoot, ['commit-tree', tree, '-p', head, '-m', `book synthetic snapshot ${id}`], {
      env: gitIdentityEnv(),
    })
  ).stdout.trim();
  const repoHash = repositoryHash(repoRoot);
  const ref = `refs/book/snapshots/${repoHash}/${id}`;
  await git(repoRoot, ['update-ref', ref, commit]);

  const manifestOutput = (
    await git(repoRoot, [
      '-c',
      'core.quotepath=false',
      'diff-tree',
      '--no-commit-id',
      '--name-status',
      '-r',
      '-M',
      head,
      commit,
    ])
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

export async function createAgentWorktree(
  snapshot: AgentSnapshot,
  agentId: string,
  worktreeRoot = defaultWorktreeRoot(),
  startCommit = snapshot.commit,
): Promise<{ path: string; branch: string }> {
  const path = join(worktreeRoot, snapshot.repoHash, agentId);
  const branch = `book-agent/${snapshot.repoHash}/${agentId}`;
  if (existsSync(path)) return { path, branch };
  mkdirSync(dirname(path), { recursive: true });
  await git(snapshot.repoRoot, ['worktree', 'add', '-b', branch, path, startCommit]);
  return { path, branch };
}

export async function removeAgentWorktree(
  record: AgentRecord,
  repoRoot = record.worktree,
): Promise<void> {
  if (!record.worktree || !record.branch) return;
  const root = repoRoot ?? record.worktree;
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

async function candidateDelta(snapshot: AgentSnapshot, candidate: PatchCandidate): Promise<string> {
  return (
    await git(snapshot.repoRoot, [
      'diff',
      ...HARDENED_DIFF_ARGS,
      '--binary',
      '--full-index',
      candidate.baseCommit,
      candidate.headCommit,
      '--',
    ])
  ).stdout;
}

async function precheckDelta(snapshot: AgentSnapshot, patch: string): Promise<void> {
  const index = tempIndex();
  try {
    const env = { GIT_INDEX_FILE: index.path };
    await git(snapshot.repoRoot, ['read-tree', snapshot.commit], { env });
    await git(snapshot.repoRoot, ['apply', '--3way', '--check', '--cached', '-'], {
      env,
      input: patch,
    });
    await git(snapshot.repoRoot, ['apply', '--check', '-'], { input: patch });
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
async function hasPendingCherryPick(repoRoot: string): Promise<boolean> {
  const result = await git(repoRoot, ['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'], {
    allowExitCodes: [1],
  });
  return result.code === 0;
}

export async function applyVerifiedCandidate(
  snapshot: AgentSnapshot,
  candidate: PatchCandidate,
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
  if (await hasPendingCherryPick(snapshot.repoRoot)) {
    return {
      status: 'conflicted',
      error:
        'A cherry-pick is already in progress in this repository. Book did not start it and will not abort it; finish it (git cherry-pick --continue) or undo it (git cherry-pick --abort), then apply the agent result again.',
    };
  }

  const current = await currentWorkspaceFingerprint(snapshot.repoRoot, snapshot.includeUntracked);
  if (current !== snapshot.fingerprint) {
    return {
      status: 'conflicted',
      error: 'Parent workspace drifted after the agent snapshot; no changes were applied.',
    };
  }

  const patch = await candidateDelta(snapshot, candidate);
  try {
    await precheckDelta(snapshot, patch);
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
      });
      const appliedCommit = (await git(snapshot.repoRoot, ['rev-parse', 'HEAD'])).stdout.trim();
      return { status: 'applied', commit: appliedCommit };
    } catch (error) {
      await git(snapshot.repoRoot, ['cherry-pick', '--abort'], { allowExitCodes: [128] }).catch(
        () => {},
      );
      return {
        status: 'conflicted',
        error: `Cherry-pick failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  try {
    await git(snapshot.repoRoot, ['apply', '-'], { input: patch });
    return { status: 'applied', commit: candidate.headCommit };
  } catch (error) {
    return {
      status: 'conflicted',
      error: `Patch application failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
