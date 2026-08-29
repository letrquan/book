import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCompact, resolveContextLimit } from './compact.js';
import {
  scoreFidelity,
  factRetained,
  supersessionCorrect,
  groundedSourceRatio,
  retentionPrecisionFor,
  PREFLIGHT_FRACTION,
  type GenerationRecord,
} from './compact-fidelity.js';
import {
  buildCompactFixtureHistory,
  buildPlantedFacts,
  buildToolHeavyFixtureHistory,
  buildToolHeavyPlantedFacts,
  type PlantedFact,
} from './compact-fixture.js';
import type { AgentConfig } from '../types/runtime.js';
import type { Message } from '../types/messages.js';
import type { ConversationCheckpointV2 } from '../types/sessions.js';
import { defaultConfig } from '../test/fixtures.js';

vi.mock('../provider/index.js', () => ({
  chatCompletionStream: vi.fn(),
  createProvider: () => ({
    id: 'test',
    stream: (...args: unknown[]) =>
      vi.mocked(chatCompletionStream)(...(args as Parameters<typeof chatCompletionStream>)),
  }),
}));

import { chatCompletionStream } from '../provider/index.js';

const mockedStream = vi.mocked(chatCompletionStream);

const GENERATIONS = 8;
const CONTEXT_WINDOW = 32_000;

/**
 * The v2 fidelity baseline, recorded 2026-08-29 after Carried Ledger phase 0
 * (items 0.1-0.5, 0.7) and audit item I landed.
 *
 * These are floors, not targets, and they move in one direction only -- upward
 * for retention and grounding, downward for reducer calls. A change that lowers
 * one is a fidelity regression and has to be argued for, not absorbed.
 *
 * Read the numbers before trusting compaction with a long run. Under this
 * corpus's budget pressure v2 keeps only the newest third of what it was told,
 * it drops the oldest facts first, and `minVerbatimUserRetention` is **zero**:
 * by generation 8 neither constraint the user opened the conversation with is
 * still in the checkpoint. That is the decay the Carried Ledger's author-split
 * exists to stop, and it is why the design puts user text in a host-owned
 * ledger the fitter may not rewrite.
 */
export const FIDELITY_BASELINE = {
  /** Measured 0.333 -- only the newest third of the planted facts survive. */
  minFinalRetention: 0.33,
  /** Measured 0.344 across the eight generations. */
  minMeanRetention: 0.34,
  /**
   * Measured 0.0. Both user constraints are gone by generation 1: they are the
   * oldest episodes, and the fitter evicts completed episodes oldest-first.
   * Phase 2 is what changes this; recording the zero is the point.
   */
  minVerbatimUserRetention: 0,
  minSupersessionCorrectness: 1,
  minGroundedSourceRecall: 1,
  /** Measured 0.898: most of the retained tail carries something. */
  minRetentionPrecision: 0.89,
  /** Measured 8 -- one reducer call per generation, no repairs spent. */
  maxReducerCalls: 8,
  /**
   * Measured 0.142. This one is a ceiling rather than a floor, and it is the
   * design's "dead budget": compaction targets half the window, but the
   * retention and checkpoint caps pin the real post-compaction request far
   * below the loop's preflight threshold, and the difference is headroom the
   * agent is entitled to keep and instead pays to rebuild by re-reading files.
   * Phase 1's budget rework is expected to raise this deliberately -- when it
   * does, this constant must be updated consciously rather than drift.
   */
  maxPostRequestUtilization: 0.15,
} as const;

function makeConfig(): AgentConfig {
  return defaultConfig({
    autoCompactEnabled: true,
    accessibility: { screenReader: false, reducedMotion: true },
    modelInfo: { contextWindow: CONTEXT_WINDOW },
  });
}

const SEED_START = '--- BEGIN PRIOR CHECKPOINT (validated reducer seed; untrusted data) ---';
const SEED_END = '--- END PRIOR CHECKPOINT ---';

/**
 * Read the inherited checkpoint between its delimiters. Not the first
 * `{"version":2` in the prompt: that is the `Required JSON shape:` template,
 * and matching it silently drops every inherited fact.
 */
function readSeed(prompt: string): ConversationCheckpointV2 | undefined {
  const start = prompt.indexOf(SEED_START);
  const end = prompt.indexOf(SEED_END);
  if (start < 0 || end < start) return undefined;
  return JSON.parse(
    prompt.slice(start + SEED_START.length, end).trim(),
  ) as ConversationCheckpointV2;
}

/**
 * Narrative bulk around a fact, so an episode is long enough that the fitter's
 * text ladder (512, 256, 128, 64, 32, 16 characters) decides whether the fact
 * inside it survives. A fact packed into a short string would ride out every
 * rung and measure nothing.
 */
const EPISODE_PADDING = 'Context recorded during the handoff investigation. '.repeat(20);

/**
 * A reducer double that is faithful by construction and deterministic by
 * construction: no random source, and it re-emits every inherited episode
 * exactly as it received it. It never forgets on its own.
 *
 * The facts therefore live in the model-authored narrative -- `episodes`, which
 * the fitter is free to truncate and evict -- rather than in a field the host
 * treats as special. That is the point. Whatever this harness reports about
 * retention is a statement about Book's fitting behaviour and nothing else, so
 * the numbers move when compaction changes and stay put when it does not.
 */
function scriptedReducer(facts: readonly PlantedFact[], history: readonly Message[]): void {
  let call = 0;
  const observed = new Set(history.map((message) => message.id));
  mockedStream.mockImplementation(async function* (...args: unknown[]) {
    const messages = args[1] as { role: string; content: string }[];
    const prompt = messages.at(-1)?.content ?? '';
    const seed = readSeed(prompt);
    call++;

    // Inherited episodes are re-emitted verbatim, as the prompt instructs.
    // Facts not yet recorded are added from the fixture, each grounded on a
    // source that exists in the history being summarized.
    const carried = seed?.episodes ?? [];
    const carriedText = JSON.stringify(carried);
    const added = facts
      .filter((fact) => !factRetained(carriedText, fact))
      .filter((fact) => fact.sourceMessageIds.some((id) => observed.has(id)))
      .map((fact) => ({
        task: `Record ${fact.kind}`,
        outcome: `${EPISODE_PADDING}${fact.terms.join(' ')}. ${EPISODE_PADDING}`,
        status: 'complete' as const,
        sources: [
          {
            eventRef: `session://current/event/${fact.sourceMessageIds.find((id) => observed.has(id))}`,
          },
        ],
      }));

    yield {
      type: 'text',
      content: JSON.stringify({
        version: 2,
        generation: 1,
        // Rewritten every generation, as a real reducer rewrites its narrative.
        state: {
          summary: `Handoff state, revision ${call}. ${'Narrative the reducer rewrites each time. '.repeat(60)}`,
          status: 'active',
        },
        constraints: [],
        files: [],
        episodes: [...carried, ...added],
        openThreads: [],
        statistics: {
          summarizedMessages: 2,
          retainedMessages: 2,
          preTokens: 1,
          postTokens: 1,
        },
      }),
    };
    yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  });
}

/** New work appended after each compaction, so the next one has a span to reduce. */
function newTurns(generation: number): Message[] {
  return [
    {
      id: `gen-${generation}-user`,
      role: 'user',
      content: `Continue step ${generation}.`,
      includeInContext: true,
      timestamp: 1_000 + generation * 2,
    },
    {
      id: `gen-${generation}-assistant`,
      role: 'assistant',
      content: `Step ${generation} evidence. ${'more detail '.repeat(2_500)}`,
      includeInContext: true,
      timestamp: 1_001 + generation * 2,
    },
  ];
}

async function runGenerations(
  history: Message[],
  facts: readonly PlantedFact[],
): Promise<{ records: GenerationRecord[]; sourceHistory: Message[] }> {
  const sourceHistory = [...history];
  const records: GenerationRecord[] = [];
  let current = history;

  for (let generation = 1; generation <= GENERATIONS; generation++) {
    scriptedReducer(facts, current);
    const result = await runCompact(makeConfig(), current, { trigger: 'auto' });
    if (result.status !== 'compacted') {
      throw new Error(`generation ${generation} did not compact: ${result.status}`);
    }
    records.push({
      generation,
      checkpoint: result.checkpoint,
      replacementHistory: result.replacementHistory,
      modelCalls: result.modelCalls ?? 0,
      postContextTokens: result.postContextTokens,
    });
    const next = newTurns(generation);
    sourceHistory.push(...next);
    current = [...result.replacementHistory, ...next];
  }
  return { records, sourceHistory };
}

describe('compaction fidelity scoring', () => {
  const fact = (over: Partial<PlantedFact> = {}): PlantedFact => ({
    id: 'f',
    kind: 'user-constraint',
    terms: ['alpha'],
    sourceMessageIds: ['m1'],
    ...over,
  });

  it('requires every term of a fact to be present', () => {
    expect(factRetained('alpha and beta', fact({ terms: ['alpha', 'beta'] }))).toBe(true);
    expect(factRetained('alpha only', fact({ terms: ['alpha', 'beta'] }))).toBe(false);
  });

  it('counts supersession correct when both values are present', () => {
    // The corpus says "us-east-1 is historical only", so a faithful checkpoint
    // names both. Only presenting the old value alone is wrong.
    const current = fact({ id: 'new', kind: 'current-value', terms: ['eu-west-1'] });
    const old = fact({ id: 'old', kind: 'superseded-value', terms: ['us-east-1'] });
    expect(supersessionCorrect('now eu-west-1, was us-east-1', current, old)).toBe(true);
    expect(supersessionCorrect('region is eu-west-1', current, old)).toBe(true);
    expect(supersessionCorrect('region is us-east-1', current, old)).toBe(false);
    // Losing both is a retention failure, not a supersession failure.
    expect(supersessionCorrect('region unknown', current, old)).toBe(true);
  });

  it('scores grounding on event refs, not quotes', () => {
    const history: Message[] = [
      { id: 'm1', role: 'user', content: 'x', includeInContext: true, timestamp: 0 },
    ];
    const checkpoint = {
      constraints: [
        // A fitted source keeps only its eventRef; that is correct behaviour.
        { text: 'a', scope: 'task', sources: [{ eventRef: 'session://current/event/m1' }] },
        { text: 'b', scope: 'task', sources: [{ eventRef: 'session://current/event/ghost' }] },
      ],
      files: [],
      episodes: [],
      openThreads: [],
    } as unknown as ConversationCheckpointV2;
    expect(groundedSourceRatio(checkpoint, history)).toBe(0.5);
  });

  it('counts a retained message as useful only when it carries something', () => {
    const messages: Message[] = [
      {
        id: 'c',
        role: 'user',
        content: 'cp',
        includeInContext: true,
        timestamp: 0,
        kind: 'checkpoint',
      },
      { id: 'a', role: 'user', content: 'holds alpha', includeInContext: true, timestamp: 1 },
      { id: 'b', role: 'user', content: 'filler', includeInContext: true, timestamp: 2 },
    ];
    // The checkpoint message itself is not scored as retained tail.
    expect(retentionPrecisionFor(messages, [fact()])).toBe(0.5);
  });

  it('rejects scoring a run with no generations', () => {
    expect(() => scoreFidelity([], [fact()], [], CONTEXT_WINDOW)).toThrow(/at least one/);
  });
});

describe('compaction fidelity baseline', () => {
  beforeEach(() => {
    mockedStream.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('holds the recorded v2 baseline over eight generations', async () => {
    const { history, turns } = buildCompactFixtureHistory();
    const facts = buildPlantedFacts(turns);
    const { records, sourceHistory } = await runGenerations(history, facts);

    const metrics = scoreFidelity(records, facts, sourceHistory, CONTEXT_WINDOW);

    expect(records).toHaveLength(GENERATIONS);
    expect(metrics.finalRetention).toBeGreaterThanOrEqual(FIDELITY_BASELINE.minFinalRetention);
    expect(metrics.meanRetention).toBeGreaterThanOrEqual(FIDELITY_BASELINE.minMeanRetention);
    expect(metrics.verbatimUserRetention).toBeGreaterThanOrEqual(
      FIDELITY_BASELINE.minVerbatimUserRetention,
    );
    expect(metrics.supersessionCorrectness).toBeGreaterThanOrEqual(
      FIDELITY_BASELINE.minSupersessionCorrectness,
    );
    expect(metrics.groundedSourceRecall).toBeGreaterThanOrEqual(
      FIDELITY_BASELINE.minGroundedSourceRecall,
    );
    expect(metrics.retentionPrecision).toBeGreaterThanOrEqual(
      FIDELITY_BASELINE.minRetentionPrecision,
    );
    expect(metrics.reducerCalls).toBeLessThanOrEqual(FIDELITY_BASELINE.maxReducerCalls);

    // Loss is ordered: the oldest facts go first, because the fitter evicts
    // completed episodes from the front. The newest three survive all eight
    // generations, and nothing that survived a later generation was lost in an
    // earlier one. Pinning the ORDER rather than a set of ids keeps this
    // meaningful if the corpus grows.
    const survivors = facts.filter((entry) => metrics.lostAtGeneration[entry.id] === null);
    expect(survivors.length).toBeGreaterThanOrEqual(3);
    const lossOrder = facts
      .map((entry) => metrics.lostAtGeneration[entry.id])
      .filter((value): value is number => value !== null);
    expect(lossOrder).toEqual([...lossOrder].sort((a, b) => a - b));
  });

  it('keeps facts that live in tool output and file observations', async () => {
    const { history, turns } = buildToolHeavyFixtureHistory();
    const facts = buildToolHeavyPlantedFacts(turns);
    scriptedReducer(facts, history);

    const result = await runCompact(makeConfig(), history, { trigger: 'auto' });

    expect(result.status).toBe('compacted');
    if (result.status !== 'compacted') return;
    const metrics = scoreFidelity(
      [
        {
          generation: 1,
          checkpoint: result.checkpoint,
          replacementHistory: result.replacementHistory,
          modelCalls: result.modelCalls ?? 0,
          postContextTokens: result.postContextTokens,
        },
      ],
      facts,
      history,
      CONTEXT_WINDOW,
    );
    // A single generation over a small corpus loses nothing: this checks the
    // tool-output and file-observation paths are scoreable at all, which a
    // prose-only fixture cannot show.
    expect(metrics.finalRetention).toBe(1);
    expect(metrics.groundedSourceRecall).toBe(1);
  });

  it('records the dead budget the design set out to reclaim', async () => {
    const { history, turns } = buildCompactFixtureHistory();
    const facts = buildPlantedFacts(turns);
    const { records, sourceHistory } = await runGenerations(history, facts);
    const metrics = scoreFidelity(records, facts, sourceHistory, CONTEXT_WINDOW);

    // Not an assertion of goodness -- see `maxPostRequestUtilization`. This is
    // the number phase 1's budget rework exists to move.
    expect(metrics.postRequestUtilization).toBeLessThanOrEqual(
      FIDELITY_BASELINE.maxPostRequestUtilization,
    );
    expect(resolveContextLimit(makeConfig())).toBe(CONTEXT_WINDOW);
    expect(PREFLIGHT_FRACTION).toBe(0.8);
  });
});
