import { createHash, randomUUID } from 'crypto';
import { execFile, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import type { AgentApplyResult, AgentRecord, AgentSnapshot, PatchCandidate } from './types.js';
import { buildChildEnv } from '../child-env.js';
import { resolveBookHome } from '../book-home.js';
import { hardenedGitArgs, hardenedGitEnv, HARDENED_DIFF_ARGS } from '../tools/git.js';

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

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
 * It is applied inside `git()` rather than at each call site, on both the `execFile` and the
 * `spawn` path, so a new call site cannot forget it.
 */
function git(
  cwd: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; allowExitCodes?: number[]; input?: string },
): Promise<GitResult> {
  const argv = hardenedGitArgs(args);
  const env = buildChildEnv(process.env, { ...hardenedGitEnv(), ...options?.env });
  if (options?.input !== undefined) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn('git', argv, {
        cwd,
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
      child.on('close', (codeValue) => {
        const code = codeValue ?? 1;
        settle(() => {
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
    execFile(
      'git',
      argv,
      {
        cwd,
        env,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = typeof error?.code === 'number' ? error.code : error ? 1 : 0;
        if (!error || options?.allowExitCodes?.includes(code)) {
          resolvePromise({ stdout, stderr, code });
          return;
        }
        reject(new Error(stderr.trim() || stdout.trim() || error.message));
      },
    );
  });
}

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
  // pinentry, or start whatever program the configuration names. The cherry-pick that applies
  // this work to the operator's branch is left signing as they configured: that commit lands in
  // their history under their committer identity.
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
    try {
      await git(snapshot.repoRoot, ['cherry-pick', candidate.headCommit]);
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
