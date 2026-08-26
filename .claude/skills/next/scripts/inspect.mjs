#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = resolve(HERE, '..', '..', '..', '..');
const MAX_BUFFER = 16 * 1024 * 1024;
const MODES = new Set(['all', 'state', 'branches', 'plans']);
const PLAN_STATUS_PATTERN = /^\s*-?\s*\*{0,2}(?:current )?status\*{0,2}\s*:\s*\*{0,2}\s*/i;

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: MAX_BUFFER,
    env: options.env ?? process.env,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? '').trimEnd(),
    stderr: (result.stderr ?? result.error?.message ?? '').trimEnd(),
  };
}

function git(repoRoot, args, options) {
  return run('git', args, repoRoot, options);
}

function requireGit(repoRoot, args) {
  const result = git(repoRoot, args);
  if (!result.ok) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
  return result.stdout;
}

function lines(text) {
  return text ? text.split(/\r?\n/).filter(Boolean) : [];
}

function countPair(text) {
  const [left = '0', right = '0'] = text.trim().split(/\s+/);
  return { left: Number(left), right: Number(right) };
}

function isTestSource(path) {
  return /(?:^|\/)__tests__\//.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function newestOriginDate(repoRoot) {
  const result = git(repoRoot, [
    'for-each-ref',
    '--sort=-committerdate',
    '--count=1',
    '--format=%(committerdate:iso8601-strict)',
    'refs/remotes/origin',
  ]);
  return result.ok && result.stdout ? result.stdout : null;
}

export function resolveRepository(candidate = DEFAULT_REPO) {
  const requested = resolve(candidate);
  const result = git(requested, ['rev-parse', '--show-toplevel']);
  if (!result.ok || !result.stdout) {
    throw new Error(result.stderr || `${requested} is not inside a Git repository`);
  }
  return resolve(result.stdout);
}

export function inspectState(repoRoot) {
  const mainCommit = requireGit(repoRoot, ['rev-parse', '--verify', 'main^{commit}']);
  const currentBranch = requireGit(repoRoot, ['branch', '--show-current']) || null;
  const workingTreeChanges = lines(requireGit(repoRoot, ['status', '--short']));
  const snapshotPath = join(repoRoot, 'docs', 'current-state.md');
  let snapshot = null;

  if (existsSync(snapshotPath)) {
    const content = readFileSync(snapshotPath, 'utf8');
    const snapshotDate = content.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ?? null;
    const log = git(repoRoot, [
      'log',
      '-1',
      '--format=%H%x09%cI',
      'main',
      '--',
      'docs/current-state.md',
    ]);

    if (log.ok && log.stdout) {
      const [commit, committedAt] = log.stdout.split('\t');
      const range = `${commit}..main`;
      const changedSourceFiles = lines(
        requireGit(repoRoot, ['diff', '--name-only', range, '--', 'src/']),
      );
      const changedNonTestSourceFiles = changedSourceFiles.filter((path) => !isTestSource(path));
      const hotspots = new Map();
      for (const path of changedNonTestSourceFiles) {
        const parts = path.split('/');
        const area = parts.length >= 3 ? `${parts[0]}/${parts[1]}` : path;
        hotspots.set(area, (hotspots.get(area) ?? 0) + 1);
      }
      const shortStat = git(repoRoot, [
        'diff',
        '--shortstat',
        range,
        '--',
        'src/',
        'docs/',
        'README.md',
      ]);
      snapshot = {
        path: 'docs/current-state.md',
        proseDate: snapshotDate,
        commit,
        committedAt: committedAt || null,
        commitsSince: Number(requireGit(repoRoot, ['rev-list', '--count', range])),
        changedSourceFiles,
        changedNonTestSourceFiles,
        changedNonTestSourceFileCount: changedNonTestSourceFiles.length,
        hotspots: [...hotspots.entries()]
          .map(([area, count]) => ({ area, count }))
          .sort((a, b) => b.count - a.count || a.area.localeCompare(b.area)),
        shortStat: shortStat.ok ? shortStat.stdout : null,
        audit: {
          useSnapshotWithoutSurfaceAudit: changedNonTestSourceFiles.length === 0,
          maximumSurfacesToVerify: changedNonTestSourceFiles.length === 0 ? 0 : 3,
        },
      };
    }
  }

  return {
    mainCommit,
    currentBranch,
    workingTree: {
      dirty: workingTreeChanges.length > 0,
      changes: workingTreeChanges,
    },
    snapshot,
  };
}

function planFiles(repoRoot) {
  const roots = [join(repoRoot, 'plans'), join(repoRoot, 'plans', 'adaptive-harness')];
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) found.push(join(root, entry.name));
    }
  }
  return found.sort();
}

function planStatus(firstTenLines) {
  const statusIndex = firstTenLines.findIndex((line) => PLAN_STATUS_PATTERN.test(line));
  if (statusIndex === -1) return null;

  const statusParts = [firstTenLines[statusIndex].replace(PLAN_STATUS_PATTERN, '')];
  for (const line of firstTenLines.slice(statusIndex + 1)) {
    if (!line.trim() || /^\s*(?:#{1,6}\s|[-+*]\s+)/.test(line)) break;
    statusParts.push(line.trim());
  }
  return statusParts.filter(Boolean).join(' ');
}

export function inspectPlans(repoRoot) {
  const milestonePath = join(repoRoot, 'MILESTONES.md');
  const uncheckedMilestones = [];
  if (existsSync(milestonePath)) {
    const milestoneLines = readFileSync(milestonePath, 'utf8').split(/\r?\n/);
    milestoneLines.forEach((line, index) => {
      const match = line.match(/^\s*- \[ \] (.+)$/);
      if (!match) return;

      const text = [match[1]];
      for (const continuation of milestoneLines.slice(index + 1)) {
        if (!continuation.trim() || /^\s*(?:#{1,6}\s|[-+*]\s+)/.test(continuation)) break;
        if (!/^\s+/.test(continuation)) break;
        text.push(continuation.trim());
      }
      uncheckedMilestones.push({ line: index + 1, text: text.join(' ') });
    });
  }

  const statuses = planFiles(repoRoot).map((path) => {
    const relativePath = path.slice(repoRoot.length + 1).replaceAll('\\', '/');
    const firstTen = readFileSync(path, 'utf8').split(/\r?\n/).slice(0, 10);
    return {
      path: relativePath,
      status: planStatus(firstTen),
    };
  });

  return {
    uncheckedMilestones,
    uncheckedMilestoneCount: uncheckedMilestones.length,
    plans: statuses,
  };
}

function parseWorktrees(repoRoot) {
  const output = requireGit(repoRoot, ['worktree', 'list', '--porcelain']);
  const blocks = output.split(/\r?\n\r?\n/).filter(Boolean);
  return blocks.map((block) => {
    const record = {};
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(' ');
      const key = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? true : line.slice(separator + 1);
      record[key] = value;
    }
    const path = resolve(String(record.worktree));
    const status = git(path, ['status', '--short']);
    const changes = status.ok ? lines(status.stdout) : [];
    return {
      path,
      head: typeof record.HEAD === 'string' ? record.HEAD : null,
      branch:
        typeof record.branch === 'string' ? record.branch.replace(/^refs\/heads\//, '') : null,
      detached: record.detached === true,
      locked: record.locked === true || typeof record.locked === 'string',
      prunable: record.prunable === true || typeof record.prunable === 'string',
      dirty: status.ok ? changes.length > 0 : null,
      changes,
      statusError: status.ok ? null : status.stderr || 'git status failed',
    };
  });
}

function readRefs(repoRoot) {
  const output = requireGit(repoRoot, [
    'for-each-ref',
    '--format=%(refname)%09%(objectname)',
    'refs/heads',
    'refs/remotes/origin',
  ]);
  const groups = new Map();

  for (const line of lines(output)) {
    const [fullName, objectName] = line.split('\t');
    let name;
    let kind;
    if (fullName.startsWith('refs/heads/')) {
      name = fullName.slice('refs/heads/'.length);
      kind = 'local';
    } else if (fullName.startsWith('refs/remotes/origin/')) {
      name = fullName.slice('refs/remotes/origin/'.length);
      kind = 'remote';
    } else {
      continue;
    }
    if (name === 'main' || name === 'HEAD') continue;
    const group = groups.get(name) ?? { name, local: null, remote: null };
    group[kind] = { fullName, shortName: kind === 'local' ? name : `origin/${name}`, objectName };
    groups.set(name, group);
  }

  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function conflictFile(message) {
  const direct = message.match(/Merge conflict in (.+)$/);
  if (direct) return direct[1];
  const structural = message.match(
    /^CONFLICT \([^)]+\):\s+(.+?)(?: deleted| renamed| modified| added|$)/,
  );
  return structural?.[1] ?? null;
}

function dryMerge(repoRoot, ref) {
  const commonDirValue = requireGit(repoRoot, ['rev-parse', '--git-common-dir']);
  const commonDir = resolve(repoRoot, commonDirValue);
  const temporaryObjects = mkdtempSync(join(tmpdir(), 'book-next-merge-'));
  try {
    const result = git(
      repoRoot,
      ['merge-tree', '--write-tree', '--name-only', '--messages', 'main', ref],
      {
        env: {
          ...process.env,
          GIT_OBJECT_DIRECTORY: temporaryObjects,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: join(commonDir, 'objects'),
        },
      },
    );
    const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
    const conflictMessages = lines(combined).filter((line) => line.startsWith('CONFLICT '));
    if (result.status === 0) {
      return { supported: true, mergeable: true, conflictFiles: [], conflictMessages: [] };
    }
    if (result.status === 1 && conflictMessages.length > 0) {
      return {
        supported: true,
        mergeable: false,
        conflictFiles: [...new Set(conflictMessages.map(conflictFile).filter(Boolean))],
        conflictMessages,
      };
    }
    return {
      supported: false,
      mergeable: null,
      conflictFiles: [],
      conflictMessages: [],
      error: result.stderr || result.stdout || 'git merge-tree failed',
    };
  } finally {
    rmSync(temporaryObjects, { recursive: true, force: true });
  }
}

function branchVerdict({ checkedOut, dirty, ahead, behind, cherry, mergeCheck }) {
  if (dirty || checkedOut === 'current') return 'IN PROGRESS';
  if (checkedOut) return 'CHECKED OUT';
  if (ahead === 0) return 'CONTAINED';
  if (!cherry.includes('+') && cherry.includes('-')) return 'PATCH ALREADY APPLIED';
  if (mergeCheck?.mergeable === false) return 'CONFLICTS';
  if (cherry.includes('+') && behind >= 10) return 'STALE - REBASE OR DROP';
  if (cherry.includes('+') && mergeCheck?.mergeable === true) return 'READY FOR PR';
  return 'REVIEW';
}

function inspectBranch(repoRoot, group, worktrees) {
  const preferred = group.local ?? group.remote;
  const relation = countPair(
    requireGit(repoRoot, ['rev-list', '--left-right', '--count', `main...${preferred.shortName}`]),
  );
  const cherryResult =
    relation.right > 0 ? git(repoRoot, ['cherry', 'main', preferred.shortName]) : null;
  const cherry = cherryResult?.ok
    ? [
        ...new Set(
          lines(cherryResult.stdout)
            .map((line) => line[0])
            .filter(Boolean),
        ),
      ]
        .sort()
        .join('')
    : '';
  const checked = group.local ? worktrees.filter((worktree) => worktree.branch === group.name) : [];
  const current = checked.find((worktree) => resolve(worktree.path) === resolve(repoRoot));
  const dirty = checked.some((worktree) => worktree.dirty === true);
  const mergeCheck = cherry.includes('+') ? dryMerge(repoRoot, preferred.shortName) : null;
  let tracking = null;
  if (group.local && group.remote) {
    const remoteRelation = countPair(
      requireGit(repoRoot, [
        'rev-list',
        '--left-right',
        '--count',
        `${group.remote.shortName}...${group.local.shortName}`,
      ]),
    );
    tracking = { behindRemote: remoteRelation.left, aheadOfRemote: remoteRelation.right };
  }
  const checkedOut = current ? 'current' : checked.length > 0;

  return {
    name: group.local ? group.name : group.remote.shortName,
    localRef: group.local?.shortName ?? null,
    remoteRef: group.remote?.shortName ?? null,
    remoteOnly: !group.local,
    behindMain: relation.left,
    aheadOfMain: relation.right,
    cherry,
    tracking,
    checkedOutWorktrees: checked.map((worktree) => worktree.path),
    dirty,
    mergeCheck,
    verdict: branchVerdict({
      checkedOut,
      dirty,
      ahead: relation.right,
      behind: relation.left,
      cherry,
      mergeCheck,
    }),
  };
}

function checkSummary(rollup) {
  return (rollup ?? []).map((check) => ({
    name: check.name ?? check.context ?? check.workflowName ?? 'check',
    conclusion: check.conclusion ?? null,
  }));
}

function prVerdict(pr, branch) {
  if (pr.isDraft) return 'DRAFT';
  if (branch?.verdict === 'IN PROGRESS' || branch?.verdict === 'CHECKED OUT') {
    return branch.verdict;
  }
  const checks = checkSummary(pr.statusCheckRollup);
  if (checks.length === 0) return 'CI NOT RUN';
  const failed = checks.filter((check) => check.conclusion !== 'SUCCESS');
  if (failed.length > 0) return 'CI BLOCKED';
  if (pr.mergeable !== 'MERGEABLE') return 'NOT MERGEABLE';
  return 'MERGE';
}

function inspectGitHub(repoRoot, branches) {
  const prResult = run(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,title,headRefName,isDraft,mergeable,statusCheckRollup,url',
    ],
    repoRoot,
  );
  const issueResult = run(
    'gh',
    ['issue', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,labels,url'],
    repoRoot,
  );
  if (!prResult.ok || !issueResult.ok) {
    return {
      available: false,
      error: prResult.stderr || issueResult.stderr || 'gh is unavailable',
      pullRequests: [],
      issues: [],
    };
  }

  const branchByName = new Map();
  for (const branch of branches) {
    branchByName.set(branch.name.replace(/^origin\//, ''), branch);
  }
  const pullRequests = JSON.parse(prResult.stdout || '[]').map((pr) => {
    const branch = branchByName.get(pr.headRefName);
    const checks = checkSummary(pr.statusCheckRollup);
    return {
      number: pr.number,
      title: pr.title,
      headRefName: pr.headRefName,
      url: pr.url,
      isDraft: pr.isDraft,
      mergeable: pr.mergeable,
      checks,
      branchVerdict: branch?.verdict ?? null,
      verdict: prVerdict(pr, branch),
    };
  });
  const issues = JSON.parse(issueResult.stdout || '[]').map((issue) => ({
    number: issue.number,
    title: issue.title,
    url: issue.url,
    labels: (issue.labels ?? []).map((label) => label.name),
  }));

  return { available: true, error: null, pullRequests, issues };
}

export function inspectBranches(repoRoot, options = {}) {
  const fetch = options.fetch === true;
  let fetchResult = {
    attempted: fetch,
    ok: null,
    error: null,
    remoteAsOf: newestOriginDate(repoRoot),
  };
  if (fetch) {
    const result = git(repoRoot, ['fetch', '--prune']);
    fetchResult = {
      attempted: true,
      ok: result.ok,
      error: result.ok ? null : result.stderr || 'git fetch --prune failed',
      remoteAsOf: newestOriginDate(repoRoot),
    };
  }

  const worktrees = parseWorktrees(repoRoot);
  const branches = readRefs(repoRoot).map((group) => inspectBranch(repoRoot, group, worktrees));
  const github =
    options.github === false
      ? { available: false, error: 'skipped', pullRequests: [], issues: [] }
      : inspectGitHub(repoRoot, branches);

  return { fetch: fetchResult, worktrees, branches, github };
}

export function inspectRepository(options = {}) {
  const repoRoot = resolveRepository(options.repoRoot ?? DEFAULT_REPO);
  const mode = options.mode ?? 'all';
  if (!MODES.has(mode)) throw new Error(`Unknown inspection mode: ${mode}`);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repoRoot,
    mode,
    ...(mode === 'all' || mode === 'state' ? { state: inspectState(repoRoot) } : {}),
    ...(mode === 'all' || mode === 'branches'
      ? { branches: inspectBranches(repoRoot, options) }
      : {}),
    ...(mode === 'all' || mode === 'plans' ? { plans: inspectPlans(repoRoot) } : {}),
  };
}

function usage() {
  return [
    'Usage: node inspect.mjs [all|state|branches|plans] [options]',
    '',
    'Options:',
    '  --repo <path>  Inspect another repository',
    '  --fetch        Run git fetch --prune before branch inspection',
    '  --no-gh        Skip GitHub PR and issue inspection',
    '  --pretty       Pretty-print JSON',
  ].join('\n');
}

function parseArguments(argv) {
  let mode = 'all';
  let repoRoot = DEFAULT_REPO;
  let fetch = false;
  let github = true;
  let pretty = false;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (MODES.has(argument)) mode = argument;
    else if (argument === '--repo') repoRoot = argv[++index];
    else if (argument === '--fetch') fetch = true;
    else if (argument === '--no-gh') github = false;
    else if (argument === '--pretty') pretty = true;
    else if (argument === '--help' || argument === '-h') return { help: true };
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!repoRoot) throw new Error('--repo requires a path');
  return { mode, repoRoot, fetch, github, pretty };
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      const result = inspectRepository(options);
      console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
