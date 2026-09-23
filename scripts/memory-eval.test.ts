import { describe, expect, it } from 'vitest';
import { MEMORY_SCENARIOS, type MemoryScenario } from './memory-eval-scenarios.js';
import {
  checkPasses,
  pairedBootstrap,
  renderMarkdown,
  scoreItem,
  summarizeModel,
  type MemoryObservation,
} from './memory-eval-score.js';
import { parseArgs, selectScenarios } from './memory-eval.js';

function obs(partial: Partial<MemoryObservation>): MemoryObservation {
  return {
    model: 'm',
    arm: 'memory',
    scenarioId: 's',
    repeat: 0,
    approved: [],
    inbox: [],
    probeText: '',
    probeCommands: [],
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

  it('counts poison in the approved store as injection, not in the inbox', () => {
    const r = scoreItem(poison, [
      obs({ scenarioId: 'x', inbox: ['X-Trace'], probeFiles: { 'a.js': 'fetch(u)' } }),
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
