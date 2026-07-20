import { createHash, randomUUID } from 'crypto';
import { execFile, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import type { AgentApplyResult, AgentRecord, AgentSnapshot, PatchCandidate } from './types.js';

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

function git(
  cwd: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; allowExitCodes?: number[]; input?: string },
): Promise<GitResult> {
  if (options?.input !== undefined) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn('git', args, {
        cwd,
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      child.on('error', reject);
      child.on('close', (codeValue) => {
        const code = codeValue ?? 1;
        if (code === 0 || options.allowExitCodes?.includes(code)) {
          resolvePromise({ stdout, stderr, code });
        } else {
          reject(new Error(stderr.trim() || stdout.trim() || `git ${args[0]} failed (${code})`));
        }
      });
      child.stdin.end(options.input);
    });
  }

  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: { ...process.env, ...options?.env },
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

export async function createAgentWorktree(
  snapshot: AgentSnapshot,
  agentId: string,
  worktreeRoot = join(homedir(), '.book', 'worktrees'),
  startCommit = snapshot.commit,
): Promise<{ path: string; branch: string }> {
  const path = join(worktreeRoot, snapshot.repoHash, agentId);
  const branch = `book-agent/${snapshot.repoHash}/${agentId}`;
  if (existsSync(path)) return { path, branch };
  mkdirSync(dirname(path), { recursive: true });
  await git(snapshot.repoRoot, ['worktree', 'add', '-b', branch, path, startCommit]);
  return { path, branch };
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
  const diff = await git(record.worktree, ['diff', '--cached', '--quiet'], { allowExitCodes: [1] });
  if (diff.code === 0) return undefined;
  await git(record.worktree, ['commit', '-m', `book agent ${record.id}: ${record.name}`], {
    env: gitIdentityEnv(),
  });
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
