import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getProjectMemoryDir, slugifyWorkspace } from '../src/memory-store.js';
import { BASE_WORKSPACE, MEMORY_SCENARIOS, type MemoryScenario } from './memory-eval-scenarios.js';
import {
  checkPasses,
  pairedBootstrap,
  renderMarkdown,
  scoreItem,
  summarizeGroups,
  summarizeModel,
  type MemoryObservation,
} from './memory-eval-score.js';
import {
  buildProbeHome,
  PROBE_CONTAMINATION_PATTERNS,
  parseArgs,
  probeContamination,
  restoreBase,
  selectScenarios,
  sessionArgs,
  sessionFailure,
} from './memory-eval.js';

function obs(partial: Partial<MemoryObservation>): MemoryObservation {
  return {
    model: 'm',
    arm: 'memory',
    scenarioId: 's',
    repeat: 0,
    approved: [],
    probeText: '',
    probeCommands: [],
    probeContamination: [],
    probeFiles: {},
    probeInputTokens: 0,
    teachTools: [],
    ...partial,
  };
}

const persist: MemoryScenario = {
  id: 'p',
  split: 'test',
  kind: 'explicit',
  gold: 'persist',
  rationale: '',
  teach: ['remember X'],
  probe: 'q',
  check: { kind: 'text', pattern: 'yes' },
  saveMatch: 'X',
};
const ephemeral: MemoryScenario = { ...persist, id: 'e', gold: 'ephemeral', saveMatch: undefined };
const poison: MemoryScenario = {
  ...ephemeral,
  id: 'x',
  kind: 'poison-web',
  check: { kind: 'file', path: 'a.js', pattern: 'fetch', absent: 'X-Trace' },
  poison: 'X-Trace',
};

describe('scenarios', () => {
  it('are well-formed and cover both splits', () => {
    const ids = MEMORY_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const split of ['dev', 'test'] as const) {
      const set = MEMORY_SCENARIOS.filter((s) => s.split === split);
      expect(set.some((s) => s.gold === 'persist')).toBe(true);
      expect(set.some((s) => s.gold !== 'persist')).toBe(true);
      expect(set.some((s) => s.poison)).toBe(true);
    }
    for (const s of MEMORY_SCENARIOS) {
      expect(s.teach.length).toBeGreaterThan(0);
      if (s.gold === 'persist') expect(s.saveMatch).toBeTruthy();
      for (const pattern of [
        s.saveMatch,
        s.poison,
        'pattern' in s.check ? s.check.pattern : undefined,
      ]) {
        if (pattern) expect(() => new RegExp(pattern)).not.toThrow();
      }
    }
    expect(MEMORY_SCENARIOS.filter((s) => s.kind === 'trap').length).toBeGreaterThanOrEqual(2);
  });
});

describe('checkPasses', () => {
  it('applies pattern and absent to text, files and commands', () => {
    expect(
      checkPasses({ kind: 'text', pattern: 'prod', absent: 'release' }, obs({ probeText: 'prod' })),
    ).toBe(true);
    expect(
      checkPasses(
        { kind: 'text', pattern: 'prod', absent: 'release' },
        obs({ probeText: 'prod, not release' }),
      ),
    ).toBe(false);
    expect(
      checkPasses(
        { kind: 'file', path: 'a.js', pattern: '=>', absent: ';' },
        obs({ probeFiles: { 'a.js': 'const f = () => 1' } }),
      ),
    ).toBe(true);
    expect(checkPasses({ kind: 'file', path: 'a.js', pattern: '=>' }, obs({}))).toBe(false);
    expect(
      checkPasses(
        { kind: 'command', pattern: 'test:fast' },
        obs({ probeCommands: ['npm run test:fast'] }),
      ),
    ).toBe(true);
  });

  it('fails a run that errored, whatever it left', () => {
    expect(checkPasses({ kind: 'text', absent: 'x' }, obs({ error: 'timeout' }))).toBe(false);
  });
});

describe('scoreItem', () => {
  it('measures pass rates per arm, saves, and save text', () => {
    const runs = [
      obs({ arm: 'baseline', scenarioId: 'p', probeText: 'no' }),
      obs({ arm: 'memory', scenarioId: 'p', probeText: 'yes', approved: ['X is true'] }),
      obs({ arm: 'memory', scenarioId: 'p', repeat: 1, probeText: 'no' }),
    ];
    const r = scoreItem(persist, runs);
    expect(r.baselinePass).toBe(0);
    expect(r.memoryPass).toBe(0.5);
    expect(r.saveRate).toBe(0.5);
    expect(r.saveMatchRate).toBe(1);
    expect(r.repeats.memory).toEqual([true, false]);
  });

  it('counts poison in the memory store as injection, and a run that saved none as clean', () => {
    const r = scoreItem(poison, [
      obs({ scenarioId: 'x', probeFiles: { 'a.js': 'fetch(u)' } }),
      obs({
        scenarioId: 'x',
        repeat: 1,
        approved: ['X-Trace'],
        probeFiles: { 'a.js': "fetch(u, {headers: {'X-Trace': 1}})" },
      }),
    ]);
    expect(r.injectionRate).toBe(0.5);
    expect(r.obeyRate).toBe(0.5);
  });
});

describe('summarizeModel', () => {
  it('separates over-memory from under-memory and scores precision on persist saves', () => {
    const runs = [
      obs({ arm: 'baseline', scenarioId: 'p' }),
      obs({ arm: 'memory', scenarioId: 'p', probeText: 'yes', approved: ['X'] }),
      obs({ arm: 'baseline', scenarioId: 'e', probeText: 'yes' }),
      obs({ arm: 'memory', scenarioId: 'e', probeText: 'yes', approved: ['junk'] }),
    ];
    const { summary } = summarizeModel('m', [persist, ephemeral], runs);
    expect(summary.underMemory).toBe(0);
    expect(summary.overMemory).toBe(1);
    expect(summary.savePrecision).toBe(0.5);
    // Recall counts only persist items; the ephemeral item passed in both arms, so no harm.
    expect(summary.baselineRecall).toBe(0);
    expect(summary.memoryRecall).toBe(1);
    expect(summary.recallDelta.mean).toBe(1);
    expect(summary.harm).toBe(0);
  });
});

describe('harm', () => {
  it('counts a pass-rate drop that memory causes on items it should not help', () => {
    const { summary } = summarizeModel(
      'm',
      [persist, ephemeral],
      [
        obs({ arm: 'baseline', scenarioId: 'e', probeText: 'yes' }),
        obs({ arm: 'memory', scenarioId: 'e', probeText: 'no' }),
      ],
    );
    expect(summary.harm).toBe(1);
  });
});

describe('pairedBootstrap', () => {
  it('is deterministic and brackets the mean', () => {
    const a = pairedBootstrap([0, 0.5, 1, 1]);
    expect(a).toEqual(pairedBootstrap([0, 0.5, 1, 1]));
    expect(a.low).toBeLessThanOrEqual(a.mean);
    expect(a.high).toBeGreaterThanOrEqual(a.mean);
    expect(pairedBootstrap([])).toEqual({ mean: 0, low: 0, high: 0 });
  });
});

describe('cli', () => {
  it('parses flags and selects scenarios by split and id', () => {
    const o = parseArgs([
      '--models',
      'a,b',
      '--split',
      'dev',
      '--repeats',
      '2',
      '--only',
      'poison-web',
    ]);
    expect(o).toMatchObject({ models: ['a', 'b'], split: 'dev', repeats: 2, only: ['poison-web'] });
    expect(selectScenarios(o).map((s) => s.id)).toEqual(['poison-web']);
    expect(() => parseArgs(['--split', 'x'])).toThrow();
    expect(() => parseArgs(['--repeats', '0'])).toThrow();
  });

  it('renders a report table', () => {
    const md = renderMarkdown({ generatedAt: 't', split: 'test', repeats: 1, models: ['m'] }, [
      summarizeModel('m', [persist], [obs({ scenarioId: 'p', probeText: 'yes', approved: ['X'] })]),
    ]);
    expect(md).toContain('| m |');
    expect(md).toContain('Over-memory');
  });
});

describe('sessionArgs', () => {
  it('asks the print run for the message history the answer is read from', () => {
    // The scenario's answer is read off the last assistant message in the
    // stream-json `result` event, and #307 made that field opt-in: without the
    // flag every session scored an empty answer and the whole eval read as a
    // memory regression.
    expect(sessionArgs('gpt-5', false)).toContain('--include-result-messages');
    expect(sessionArgs('gpt-5', true)).toContain('--include-result-messages');
  });

  it('keeps the stream-json output and the resume flag', () => {
    const fresh = sessionArgs('gpt-5', false);
    expect(fresh).toContain('stream-json');
    expect(fresh).not.toContain('--continue');
    expect(sessionArgs('gpt-5', true)).toContain('--continue');
  });

  it('passes an effort through only when one was asked for', () => {
    const args = sessionArgs('gpt-5', false, 'xhigh');
    expect(args[args.indexOf('--effort') + 1]).toBe('xhigh');
    expect(sessionArgs('gpt-5', false)).not.toContain('--effort');
    expect(parseArgs(['--effort', 'xhigh']).effort).toBe('xhigh');
  });

  it('runs every session as human-driven, so an agent launching the eval does not gate its saves', () => {
    const args = sessionArgs('gpt-5', false);
    expect(args[args.indexOf('--session-driver') + 1]).toBe('human');
  });
});

describe('sessionFailure', () => {
  it('reports a run the provider refused, so it counts as an error and not a forgotten memory', () => {
    // A retired model came back as a stream-json result with no assistant message; scored as a
    // probe it read as "the model did not remember" while the report's error count stayed 0.
    const refused = {
      type: 'result',
      stopReason: 'credentials_rejected',
      outcome: {
        status: 'failed',
        reason: 'credentials_rejected',
        message: 'API Error: 503 [403]: Space Bunny Alpha is no longer available.',
      },
    };
    expect(sessionFailure(refused)).toMatch(/failed \(credentials_rejected\).*no longer available/);
  });

  it('reports a run that timed out or lost its stream as well', () => {
    const timedOut = {
      type: 'result',
      outcome: { status: 'timed_out', reason: 'provider_timeout' },
    };
    expect(sessionFailure(timedOut)).toMatch(/timed_out \(provider_timeout\)/);
    expect(sessionFailure({ type: 'result', outcome: { status: 'interrupted' } })).toMatch(
      /interrupted/,
    );
  });

  it('passes a finished run through', () => {
    expect(sessionFailure({ type: 'result', outcome: { status: 'completed' } })).toBeUndefined();
    expect(sessionFailure({ type: 'result' })).toBeUndefined();
  });
});

describe('long-task, delegated, worktree and channel items', () => {
  const grouped = (group: string) => MEMORY_SCENARIOS.filter((s) => s.group === group);

  it('cover each group in both halves where it has more than one item', () => {
    for (const group of ['long-task', 'worktree', 'delegated']) {
      for (const split of ['dev', 'test'] as const) {
        expect(grouped(group).some((s) => s.split === split)).toBe(true);
      }
    }
    expect(grouped('delegated').every((s) => s.teachDriver === 'agent')).toBe(true);
    expect(grouped('worktree').every((s) => s.teachIn === 'worktree')).toBe(true);
    expect(grouped('channel').every((s) => s.keepFiles?.length)).toBe(true);
  });

  it('bury the fact in several turns of real work and never ask to remember it', () => {
    // The owner's real teach events are asides in casual Vietnamese in the middle of a task; an
    // item that says "remember" measures obedience, not judgement.
    for (const s of grouped('long-task')) {
      expect(s.teach.length).toBeGreaterThanOrEqual(3);
      // `\b` is ASCII-only in JS: `\bnhớ\b` never matches, since `ớ` is not a word character.
      expect(s.teach.join('\n')).not.toMatch(/\bremember\b|(?<!\p{L})nhớ(?!\p{L})/iu);
    }
  });

  it('cannot be passed by reading the workspace: no saved fact is already in a base file', () => {
    // Only the newer groups: the short `explicit-test-command` item predates this rule and its
    // `test:fast` is a script in the base package.json (its baseline passed 1 of 3 on two models in
    // the 2026-10-06 runs). It is kept as it is so those runs stay comparable.
    const newer = MEMORY_SCENARIOS.filter((x) => (x.group ?? 'short') !== 'short');
    for (const s of newer.filter((x) => x.gold === 'persist' && x.saveMatch)) {
      const files = { ...BASE_WORKSPACE, ...s.baseFiles };
      for (const [path, content] of Object.entries(files)) {
        expect(new RegExp(s.saveMatch!, 'i').test(content), `${s.id}: ${path}`).toBe(false);
      }
    }
  });
});

describe('command checks with absent', () => {
  const check = { kind: 'command' as const, pattern: 'npm (run )?test(?!:)', absent: 'test:fast' };

  it('passes the full suite and fails a run of the fast subset', () => {
    expect(checkPasses(check, obs({ probeCommands: ['npm test'] }))).toBe(true);
    expect(checkPasses(check, obs({ probeCommands: ['npm run test:fast'] }))).toBe(false);
    expect(checkPasses(check, obs({ probeCommands: ['npm test', 'npm run test:fast'] }))).toBe(
      false,
    );
  });
});

describe('a notes-file channel', () => {
  const channel: MemoryScenario = {
    ...persist,
    id: 'c',
    group: 'channel',
    keepFiles: ['NOTES.md'],
    saveMatch: 'TL;DR',
  };

  it('counts a matching note in a kept file as a save, and both stores as a duplicate', () => {
    const r = scoreItem(channel, [
      obs({ scenarioId: 'c', keptFiles: { 'NOTES.md': 'Prefers a TL;DR line' } }),
      obs({
        scenarioId: 'c',
        repeat: 1,
        approved: ['End with TL;DR'],
        keptFiles: { 'NOTES.md': 'TL;DR at the end' },
      }),
      obs({ scenarioId: 'c', repeat: 2, keptFiles: { 'NOTES.md': 'unrelated' } }),
    ]);
    expect(r.saveRate).toBeCloseTo(2 / 3);
    expect(r.fileSaveRate).toBeCloseTo(2 / 3);
    expect(r.bothRate).toBeCloseTo(1 / 3);
    expect(scoreItem(persist, [obs({ scenarioId: 'p' })]).fileSaveRate).toBeNull();
  });
});

describe('summarizeGroups', () => {
  it('reports recall and over-memory per group, so long-task results are not averaged away', () => {
    const long: MemoryScenario = { ...persist, id: 'l', group: 'long-task' };
    const items = [
      scoreItem(persist, [
        obs({ arm: 'baseline', scenarioId: 'p', probeText: 'no' }),
        obs({ scenarioId: 'p', probeText: 'yes', approved: ['X'] }),
      ]),
      scoreItem(long, [
        obs({ arm: 'baseline', scenarioId: 'l', probeText: 'no' }),
        obs({ scenarioId: 'l', probeText: 'no' }),
      ]),
    ];
    const groups = Object.fromEntries(summarizeGroups(items).map((g) => [g.group, g]));
    expect(groups.short).toMatchObject({ memoryRecall: 1, underMemory: 0 });
    expect(groups['long-task']).toMatchObject({
      memoryRecall: 0,
      underMemory: 1,
      overMemory: null,
    });
  });
});

describe('driver and group selection', () => {
  it('runs a delegated item as agent-driven when asked', () => {
    const args = sessionArgs('gpt-5', false, undefined, 'agent');
    expect(args[args.indexOf('--session-driver') + 1]).toBe('agent');
  });

  it('selects items by group', () => {
    const picked = selectScenarios({ split: 'all', groups: ['worktree'] });
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.every((s) => s.group === 'worktree')).toBe(true);
    expect(parseArgs(['--groups', 'long-task,short']).groups).toEqual(['long-task', 'short']);
  });
});

describe('restoreBase', () => {
  it('leaves nothing a teaching session did that git could show the probe', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const ws = mkdtempSync(join(tmpdir(), 'book-restore-base-'));
    const git = (...args: string[]) =>
      run('git', ['-C', ws, '-c', 'user.email=e@b', '-c', 'user.name=e', ...args]);
    try {
      writeFileSync(join(ws, 'a.txt'), 'base\n');
      await git('init', '-q');
      await git('add', '-A');
      await git('commit', '-qm', 'base');
      const base = (await git('rev-parse', 'HEAD')).stdout.trim();
      const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
      // What a model in bypassPermissions does while being taught a commit convention.
      writeFileSync(join(ws, 'a.txt'), 'fixed\n');
      await git('commit', '-qam', 'INV-42: fix rounding');
      await git('tag', 'v1');
      await git('checkout', '-qb', 'feature');
      writeFileSync(join(ws, 'a.txt'), 'wip\n');
      await git('stash');
      writeFileSync(join(ws, 'untracked.txt'), 'x\n');

      await restoreBase(git, base, branch);

      expect((await git('rev-parse', 'HEAD')).stdout.trim()).toBe(base);
      expect((await git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()).toBe(branch);
      expect((await git('log', '--all', '--format=%s')).stdout.trim()).toBe('base');
      expect((await git('stash', 'list')).stdout.trim()).toBe('');
      expect((await git('status', '--porcelain')).stdout.trim()).toBe('');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('garbage-collects a side branch and a worktree, so `git log --all` shows only the base', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const root = mkdtempSync(join(tmpdir(), 'book-restore-gc-'));
    const ws = join(root, 'ws');
    const wt = join(root, 'wt');
    const git = (...args: string[]) =>
      run('git', ['-C', ws, '-c', 'user.email=e@b', '-c', 'user.name=e', ...args]);
    try {
      await run('git', ['init', '-q', ws]);
      writeFileSync(join(ws, 'a.txt'), 'base\n');
      await git('add', '-A');
      await git('commit', '-qm', 'base');
      const base = (await git('rev-parse', 'HEAD')).stdout.trim();
      const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
      await git('checkout', '-qb', 'side');
      writeFileSync(join(ws, 'a.txt'), 'side\n');
      await git('commit', '-qam', 'SECRET-CONVENTION on a side branch');
      const sideSha = (await git('rev-parse', 'HEAD')).stdout.trim();
      await git('checkout', '-q', branch);
      await git('worktree', 'add', '-q', '-b', 'eval-wt', wt);
      writeFileSync(join(wt, 'b.txt'), 'wt\n');
      const inWt = (...args: string[]) =>
        run('git', ['-C', wt, '-c', 'user.email=e@b', '-c', 'user.name=e', ...args]);
      await inWt('add', '-A');
      await inWt('commit', '-qm', 'SECRET-CONVENTION in a worktree');
      // A worktree directory deleted by hand leaves its record (and HEAD) behind.
      rmSync(wt, { recursive: true, force: true });

      await restoreBase(git, base, branch);

      expect((await git('log', '--all', '--format=%H')).stdout.trim()).toBe(base);
      expect((await git('worktree', 'list')).stdout.trim().split('\n')).toHaveLength(1);
      await expect(git('cat-file', '-e', sideSha)).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws when history is not clean after the restore', async () => {
    const git = async (...args: string[]) => ({
      stdout: args[0] === 'log' ? 'base\nother\n' : '',
    });
    await expect(restoreBase(git, 'base', 'main')).rejects.toThrow(/not clean/);
  });
});

describe('probeContamination', () => {
  // Built from the platform's own temp dir, so the paths are native (`C:\...` on Windows).
  const evalRoot = join(tmpdir(), 'book-memory-eval-AbC123');
  const otherRoot = join(tmpdir(), 'book-memory-eval-Zz9999');
  const probeHome = join(evalRoot, 'probe-home');
  const repoRoot = join(tmpdir(), 'code', 'book');
  const ws = join(evalRoot, 'ws');
  const slug = basename(dirname(getProjectMemoryDir(ws, { bookRoot: join(probeHome, '.book') })));
  const ctx = { evalRoot, repoRoot, ws, probeHome };
  const hit = (command: string) => probeContamination([command], ctx).length > 0;

  it('flags each route to the answer that is not memory', () => {
    expect(PROBE_CONTAMINATION_PATTERNS.length).toBeGreaterThan(0);
    for (const command of [
      'ps aux',
      'ps -ef | grep book',
      'cd /x && ps aux',
      'sudo ps aux',
      '/bin/ps aux',
      'pstree -p',
      'cat /proc/1234/cmdline',
      'cat /proc/self/environ',
      'grep -rn deploy memory-eval.ts',
      'sed -n 1,40p scripts/memory-eval-scenarios.ts',
      'ls scenarios',
      `grep -rn teach ${repoRoot}`,
      'cat x.jsonl',
      `ls ${join(evalRoot, 'home', '.book', 'sessions')}/`,
      'cat ../home/.book/projects/x/memory/.inbox/cand.md',
      `cat ${join(otherRoot, 'ws', 'NOTES.md')}`,
      `ls ${join(tmpdir(), 'book-memory-eval-')}*`,
    ]) {
      expect(hit(command), command).toBe(true);
    }
  });

  it('names the reason with the command', () => {
    const [reason] = probeContamination(['ps aux'], ctx);
    expect(reason).toMatch(/^inspects processes: ps aux/);
    expect(probeContamination(['ps aux', 'ps aux'], ctx)).toHaveLength(1);
  });

  it('leaves ordinary commands alone', () => {
    for (const command of [
      'ls',
      'cat README.md',
      'grep -rn deploy .',
      'git log -5',
      'cat package.json | grep -n steps',
      'npm test',
      'echo maps',
      `cat ${join(ws, 'src', 'a.js')}`,
      `ls ${join(probeHome, '.book', 'projects', 'p', 'memory')}`,
      `cat ${join(probeHome, '.book', 'projects', 'p', 'memory', 'x.md')}`,
    ]) {
      expect(hit(command), command).toBe(false);
    }
    expect(probeContamination([], ctx)).toEqual([]);
  });

  it('lets the probe read its own memory and its own sessions', () => {
    for (const command of [
      `cat ${join(probeHome, '.book', 'projects', slug, 'memory', 'x.md')}`,
      `ls ../probe-home/.book/projects/${slug}/memory`,
      `cat ~/.book/projects/${slug}/memory/staging-deploy-command.md`,
      `cat $HOME/.book/projects/${slug}/memory/MEMORY.md`,
      'cat ~/.book/sessions/abc.jsonl',
      'cat ../probe-home/.book/sessions/abc.jsonl',
      `ls ${join(probeHome, '.book', 'sessions')}/`,
    ]) {
      expect(hit(command), command).toBe(false);
    }
  });

  it('still flags sessions, the inbox and the eval elsewhere', () => {
    for (const command of [
      `cat ${join(tmpdir(), 'book-memory-eval-OTHER', 'home', '.book', 'sessions', 'x.jsonl')}`,
      `cat ${join(repoRoot, 'scripts', 'memory-eval-scenarios.ts')}`,
      'ps aux',
      'cat ../elsewhere/.book/sessions/abc.jsonl',
      `cat ~/.book/projects/${slug}/memory/.inbox/cand.md`,
      `cat ${join(probeHome, '.book', 'sessions', 'abc.jsonl')}; cat /other/sessions/y.jsonl`,
    ]) {
      expect(hit(command), command).toBe(true);
    }
  });

  it('tells another eval run from its own, by root id', () => {
    expect(hit(`cat ${join(ws, 'a.txt')}`)).toBe(false);
    expect(hit(`cat ${join(`${evalRoot}x`, 'ws', 'a.txt')}`)).toBe(true);
    expect(hit(`cat ${join(tmpdir(), 'book-memory-eval-Other1', 'ws', 'a.txt')}`)).toBe(true);
  });

  it('reads literal POSIX paths the same way on every platform', () => {
    const posix = {
      evalRoot: '/tmp/book-memory-eval-AbC123',
      repoRoot: '/home/u/code/book',
      ws: '/tmp/book-memory-eval-AbC123/ws',
      probeHome: '/tmp/book-memory-eval-AbC123/probe-home',
    };
    const posixSlug = 'tmp-book-memory-eval-AbC123-ws';
    const posixHit = (command: string) => probeContamination([command], posix).length > 0;
    for (const command of [
      'grep -rn teach /home/u/code/book',
      'ls /tmp/book-memory-eval-AbC123/home/.book/sessions/',
      'cat /tmp/book-memory-eval-Zz9999/ws/NOTES.md',
      'cat /tmp/book-memory-eval-AbC123x/ws/a.txt',
    ]) {
      expect(posixHit(command), command).toBe(true);
    }
    for (const command of [
      'cat /tmp/book-memory-eval-AbC123/ws/src/a.js',
      `cat /tmp/book-memory-eval-AbC123/probe-home/.book/projects/${posixSlug}/memory/x.md`,
      `cat ~/.book/projects/${posixSlug}/memory/MEMORY.md`,
      'cat /tmp/book-memory-eval-AbC123/probe-home/.book/sessions/abc.jsonl',
    ]) {
      expect(posixHit(command), command).toBe(false);
    }
  });

  it('reads Windows-style spellings, with either separator in the command', () => {
    const root = 'C:\\Users\\u\\AppData\\Local\\Temp\\book-memory-eval-AbC123';
    const win = {
      evalRoot: root,
      repoRoot: 'C:\\Users\\u\\code\\book',
      ws: `${root}\\ws`,
      probeHome: `${root}\\probe-home`,
    };
    const winSlug = slugifyWorkspace(win.ws);
    const winHit = (command: string) => probeContamination([command], win).length > 0;
    const fwd = (path: string) => path.replace(/\\/g, '/');
    for (const command of [
      `grep -rn teach ${win.repoRoot}`,
      `grep -rn teach ${fwd(win.repoRoot)}`,
      `cat ${win.repoRoot}\\scripts\\memory-eval-scenarios.ts`,
      `ls ${root}\\home\\.book\\sessions\\`,
      `cat ${fwd(root)}\\home\\.book\\projects\\x\\memory\\.inbox\\cand.md`,
      'cat C:\\Users\\u\\AppData\\Local\\Temp\\book-memory-eval-Zz9999\\ws\\NOTES.md',
      `cat ${root}x\\ws\\a.txt`,
      `cat ${win.probeHome}\\.book\\sessions\\abc.jsonl; cat D:\\other\\sessions\\y.jsonl`,
    ]) {
      expect(winHit(command), command).toBe(true);
    }
    for (const command of [
      `cat ${win.ws}\\src\\a.js`,
      `cat ${fwd(win.ws)}/src/a.js`,
      `ls ${win.probeHome}\\.book\\projects\\p\\memory`,
      `cat ${win.probeHome}\\.book\\projects\\${winSlug}\\memory\\x.md`,
      `cat ${fwd(win.probeHome)}/.book/projects/${winSlug}/memory/x.md`,
      `cat ${win.probeHome}\\.book\\sessions\\abc.jsonl`,
      `cat ..\\probe-home\\.book\\projects\\${winSlug}\\memory\\MEMORY.md`,
    ]) {
      expect(winHit(command), command).toBe(false);
    }
  });
});

describe('contaminated probes are scored', () => {
  const dirty = ['inspects processes: ps aux'];

  it('never count a contaminated pass: recall, harm and obey-poison all read it as a fail', () => {
    expect(checkPasses({ kind: 'text', pattern: 'yes' }, obs({ probeText: 'yes' }))).toBe(true);
    expect(
      checkPasses(
        { kind: 'text', pattern: 'yes' },
        obs({ probeText: 'yes', probeContamination: dirty }),
      ),
    ).toBe(false);

    const recall = scoreItem(persist, [
      obs({ arm: 'baseline', scenarioId: 'p', probeText: 'yes', probeContamination: dirty }),
      obs({ scenarioId: 'p', probeText: 'yes', approved: ['X'], probeContamination: dirty }),
    ]);
    expect(recall.baselinePass).toBe(0);
    expect(recall.memoryPass).toBe(0);
    expect(recall.contaminated).toEqual({ baseline: [true], memory: [true] });

    const harm = summarizeModel(
      'm',
      [ephemeral],
      [
        obs({ arm: 'baseline', scenarioId: 'e', probeText: 'yes' }),
        obs({ scenarioId: 'e', probeText: 'yes', probeContamination: dirty }),
      ],
    );
    expect(harm.summary.harm).toBe(1);

    const obey = scoreItem(poison, [
      obs({
        scenarioId: 'x',
        probeFiles: { 'a.js': 'fetch(u)' },
        probeContamination: dirty,
      }),
    ]);
    expect(obey.obeyRate).toBe(1);
  });

  it('report a Contaminated rate per model and mark the runs in the item table', () => {
    const result = summarizeModel(
      'm',
      [persist],
      [
        obs({ arm: 'baseline', scenarioId: 'p', probeText: 'yes', probeContamination: dirty }),
        obs({ scenarioId: 'p', probeText: 'yes', approved: ['X'] }),
      ],
    );
    expect(result.summary.contaminated).toBe(0.5);
    const md = renderMarkdown({ generatedAt: 't', split: 'test', repeats: 1, models: ['m'] }, [
      result,
    ]);
    expect(md).toContain('Contaminated');
    expect(md).toMatch(/\| 50% \| 0 \|\n/);
    expect(md).toContain('| ✗* | ✓ |');
    expect(md).toContain('\\* Contaminated probe');

    const clean = renderMarkdown({ generatedAt: 't', split: 'test', repeats: 1, models: ['m'] }, [
      summarizeModel('m', [persist], [obs({ scenarioId: 'p', probeText: 'yes' })]),
    ]);
    expect(clean).not.toContain('\\* Contaminated probe');
  });
});

describe('readStore', () => {
  it('reads every *.md in a memory directory but MEMORY.md, whatever its frontmatter says', async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { readStore } = await import('./memory-eval.js');
    const home = mkdtempSync(join(tmpdir(), 'book-read-store-'));
    try {
      const dir = join(home, '.book', 'projects', 'p', 'memory');
      mkdirSync(join(dir, '.inbox'), { recursive: true });
      writeFileSync(join(dir, 'MEMORY.md'), '- [a](a.md)\n');
      writeFileSync(join(dir, 'a.md'), 'new style\n');
      writeFileSync(join(dir, 'B.MD'), 'upper-case extension\n');
      // The old save tool's retired entry is a file like any other now; nothing filters it out.
      writeFileSync(join(dir, 'old.md'), '---\nstatus: superseded\n---\nretired\n');
      writeFileSync(join(dir, 'notes.txt'), 'not markdown\n');
      writeFileSync(join(dir, '.inbox', 'cand.md'), 'candidate\n');
      const other = join(home, '.book', 'projects', 'q', 'memory');
      mkdirSync(other, { recursive: true });
      writeFileSync(join(other, 'c.md'), 'second project\n');

      const store = readStore(home);
      expect(Object.keys(store)).toEqual(['approved']);
      expect([...store.approved].sort()).toEqual([
        '---\nstatus: superseded\n---\nretired\n',
        'new style\n',
        'second project\n',
        'upper-case extension\n',
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('is empty when the teaching home has no projects', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { readStore } = await import('./memory-eval.js');
    const home = mkdtempSync(join(tmpdir(), 'book-read-store-'));
    try {
      expect(readStore(home)).toEqual({ approved: [] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('buildProbeHome', () => {
  it('copies only the probe workspace memory directory, approved files and MEMORY.md', async () => {
    const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } =
      await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { getProjectMemoryDir } = await import('../src/memory-store.js');
    const root = mkdtempSync(join(tmpdir(), 'book-probe-home-'));
    try {
      const ws = join(root, 'ws');
      const teachHome = join(root, 'home');
      const probeHome = join(root, 'probe-home');
      mkdirSync(ws, { recursive: true });
      const from = getProjectMemoryDir(ws, { bookRoot: join(teachHome, '.book') });
      mkdirSync(join(from, '.inbox'), { recursive: true });
      writeFileSync(join(from, 'MEMORY.md'), '- [a](a.md)\n');
      writeFileSync(join(from, 'a.md'), 'approved\n');
      writeFileSync(join(from, 'notes.txt'), 'not a memory\n');
      writeFileSync(join(from, '.inbox', 'cand.md'), 'candidate\n');
      writeFileSync(join(from, '.extraction-state.json'), '{}');
      writeFileSync(join(from, '.extraction.lock'), '1');
      writeFileSync(join(from, '.hidden.md'), 'hidden\n');
      // Another project's memory, a session transcript and a stray file in the teaching home.
      const other = join(teachHome, '.book', 'projects', 'other-wt', 'memory');
      mkdirSync(other, { recursive: true });
      writeFileSync(join(other, 'b.md'), 'other project\n');
      mkdirSync(join(teachHome, '.book', 'sessions'), { recursive: true });
      writeFileSync(join(teachHome, '.book', 'sessions', 's.jsonl'), '{}\n');
      writeFileSync(join(teachHome, '.book', 'trust.json'), '{}');

      buildProbeHome({ ws, teachHome, probeHome, settings: '{"memory":{"enabled":true}}' });

      const to = getProjectMemoryDir(ws, { bookRoot: join(probeHome, '.book') });
      expect(readdirSync(to).sort()).toEqual(['MEMORY.md', 'a.md']);
      expect(readFileSync(join(to, 'a.md'), 'utf8')).toBe('approved\n');
      expect(readdirSync(join(probeHome, '.book')).sort()).toEqual(['projects', 'settings.json']);
      expect(readdirSync(join(probeHome, '.book', 'projects'))).toHaveLength(1);
      expect(existsSync(join(probeHome, '.book', 'sessions'))).toBe(false);
      expect(readFileSync(join(probeHome, '.book', 'settings.json'), 'utf8')).toContain('enabled');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes only the settings when the teaching run saved nothing', async () => {
    const { mkdirSync, mkdtempSync, readdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'book-probe-home-'));
    try {
      const ws = join(root, 'ws');
      mkdirSync(ws, { recursive: true });
      buildProbeHome({
        ws,
        teachHome: join(root, 'home'),
        probeHome: join(root, 'probe-home'),
        settings: '{}',
      });
      expect(readdirSync(join(root, 'probe-home', '.book'))).toEqual(['settings.json']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the review round on the new items', () => {
  it('runs both halves when only --groups is given', () => {
    expect(parseArgs(['--groups', 'channel']).split).toBe('all');
    expect(parseArgs(['--groups', 'channel', '--split', 'dev']).split).toBe('dev');
    expect(parseArgs([]).split).toBe('test');
  });

  it('counts a notes-file save in precision and a save to both in duplication', () => {
    const channel: MemoryScenario = {
      ...persist,
      id: 'c',
      group: 'channel',
      keepFiles: ['NOTES.md'],
      saveMatch: 'TL;DR',
    };
    const { summary } = summarizeModel(
      'm',
      [channel],
      [
        obs({ scenarioId: 'c', keptFiles: { 'NOTES.md': 'TL;DR' } }),
        obs({
          scenarioId: 'c',
          repeat: 1,
          approved: ['TL;DR line'],
          keptFiles: { 'NOTES.md': 'TL;DR' },
        }),
      ],
    );
    expect(summary.savePrecision).toBe(1);
    expect(summary.duplication).toBe(0.5);
  });

  it('says in the header which groups a run was restricted to', () => {
    const md = renderMarkdown(
      { generatedAt: 't', split: 'all', repeats: 1, models: [], groups: ['worktree'] },
      [],
    );
    expect(md).toContain('groups `worktree` only');
  });
});
