import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { appendFileSync } from 'node:fs';
import { resolveCompactBudgets, runCompact } from './compact.js';
import {
  scoreFidelity,
  factRetained,
  supersessionCorrect,
  groundedSourceRatio,
  retentionPrecisionFor,
  FIDELITY_ARMS,
  type FidelityArm,
  type GenerationRecord,
} from './compact-fidelity.js';
import {
  buildCompactFixtureHistory,
  buildPlantedFacts,
  buildToolHeavyFixtureHistory,
  buildToolHeavyPlantedFacts,
  compactTestConfig,
  type PlantedFact,
} from '../test/compact-fixture.js';
import type { AgentConfig } from '../types/runtime.js';
import type { Message } from '../types/messages.js';
import type { ConversationCheckpointV2 } from '../types/sessions.js';

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

function makeConfig(arm: FidelityArm): AgentConfig {
  return compactTestConfig({
    maxTokens: arm.reservedOutputTokens,
    modelInfo: { contextWindow: arm.contextWindow },
  });
}

/** The loop's preflight gate for an arm, which `postHistoryUtilization` is measured against. */
function preflightGate(arm: FidelityArm): number {
  return resolveCompactBudgets(makeConfig(arm)).preflightThreshold;
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
function scriptedReducer(
  facts: readonly PlantedFact[],
  history: readonly Message[],
  /**
   * Carried across generations by the caller. Declaring it inside would reset
   * it on every re-install, and the summary this double claims to rewrite each
   * generation would in fact be byte-identical throughout.
   */
  counter: { call: number },
): void {
  const observed = new Set(history.map((message) => message.id));
  mockedStream.mockImplementation(async function* (...args: unknown[]) {
    const messages = args[1] as { role: string; content: string }[];
    const prompt = messages.at(-1)?.content ?? '';
    const seed = readSeed(prompt);
    counter.call++;

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
          summary: `Handoff state, revision ${counter.call}. ${'Narrative the reducer rewrites each time. '.repeat(60)}`,
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
  arm: FidelityArm,
  history: Message[],
  facts: readonly PlantedFact[],
): Promise<{ records: GenerationRecord[]; sourceHistory: Message[] }> {
  const sourceHistory = [...history];
  const records: GenerationRecord[] = [];
  const counter = { call: 0 };
  let current = history;

  for (let generation = 1; generation <= GENERATIONS; generation++) {
    scriptedReducer(facts, current, counter);
    const result = await runCompact(makeConfig(arm), current, { trigger: 'auto' });
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

  it('matches whole tokens, so a term is not found inside a larger word', () => {
    // The corpus's superseded value `npm` is a substring of its own replacement
    // `pnpm`; plain containment could never score it lost while pnpm survived.
    expect(factRetained('use pnpm 9', fact({ terms: ['npm'] }))).toBe(false);
    expect(factRetained('assume npm for now', fact({ terms: ['npm'] }))).toBe(true);
    // `1000` occurs inside the token counts present in every checkpoint.
    expect(factRetained('"preTokens":21000', fact({ terms: ['1000'] }))).toBe(false);
    expect(factRetained('divide by 1000.', fact({ terms: ['1000'] }))).toBe(true);
  });

  it('matches a term that ends in punctuation', () => {
    // A word boundary after `)` would demand a following word character, so a
    // regex-based rule would never find this fact at all.
    expect(factRetained('the query() signature', fact({ terms: ['query()'] }))).toBe(true);
    expect(factRetained('eu-west-1 now', fact({ terms: ['eu-west-1'] }))).toBe(true);
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

  describe.each(FIDELITY_ARMS)('arm $contextWindow window', (arm) => {
    it('holds the recorded baseline over eight generations', async () => {
      const { history, turns } = buildCompactFixtureHistory({ fillerRepeat: arm.fillerRepeat });
      const facts = buildPlantedFacts(turns);
      const { records, sourceHistory } = await runGenerations(arm, history, facts);

      const metrics = scoreFidelity(records, facts, sourceHistory, preflightGate(arm));

      // The only way to re-measure the floors in FIDELITY_ARMS; see its module
      // comment. Vitest swallows console output of passing tests, so a value
      // other than "1" is taken as a file path to append the line to.
      const printTarget = process.env.BOOK_FIDELITY_PRINT;
      if (printTarget) {
        const line = JSON.stringify({
          contextWindow: arm.contextWindow,
          preflightThreshold: preflightGate(arm),
          metrics,
          postTokens: records.map((r) => r.postContextTokens),
          retained: records.map((r) => r.replacementHistory.length - 1),
        });
        console.info(line);
        if (printTarget !== '1') appendFileSync(printTarget, `${line}\n`);
      }

      expect(records).toHaveLength(GENERATIONS);
      expect(metrics.finalRetention).toBeGreaterThanOrEqual(arm.floors.minFinalRetention);
      expect(metrics.meanRetention).toBeGreaterThanOrEqual(arm.floors.minMeanRetention);
      expect(metrics.verbatimUserRetention).toBeGreaterThanOrEqual(
        arm.floors.minVerbatimUserRetention,
      );
      expect(metrics.supersessionCorrectness).toBeGreaterThanOrEqual(
        arm.floors.minSupersessionCorrectness,
      );
      expect(metrics.groundedSourceRecall).toBeGreaterThanOrEqual(
        arm.floors.minGroundedSourceRecall,
      );
      expect(metrics.retentionPrecision).toBeGreaterThanOrEqual(arm.floors.minRetentionPrecision);
      expect(metrics.reducerCalls).toBeLessThanOrEqual(arm.floors.maxReducerCalls);
      expect(metrics.postHistoryUtilization).toBeGreaterThanOrEqual(
        arm.floors.minPostHistoryUtilization,
      );

      // Loss is ordered: the oldest facts go first, because the fitter evicts
      // completed episodes from the front. The newest three survive all eight
      // generations, and nothing that survived a later generation was lost in an
      // earlier one. Pinning the ORDER rather than a set of ids keeps this
      // meaningful if the corpus grows, and it holds on every arm.
      const survivors = facts.filter((entry) => metrics.lostAtGeneration[entry.id] === null);
      expect(survivors.length).toBeGreaterThanOrEqual(3);
      const lossOrder = facts
        .map((entry) => metrics.lostAtGeneration[entry.id])
        .filter((value): value is number => value !== null);
      expect(lossOrder).toEqual([...lossOrder].sort((a, b) => a - b));
    });
  });

  it('keeps facts that live in tool output and file observations', async () => {
    const arm32k = FIDELITY_ARMS[0];
    const { history, turns } = buildToolHeavyFixtureHistory();
    const facts = buildToolHeavyPlantedFacts(turns);
    scriptedReducer(facts, history, { call: 0 });

    const result = await runCompact(makeConfig(arm32k), history, { trigger: 'auto' });

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
      preflightGate(arm32k),
    );
    // A single generation over a small corpus loses nothing: this checks the
    // tool-output and file-observation paths are scoreable at all, which a
    // prose-only fixture cannot show.
    expect(metrics.finalRetention).toBe(1);
    expect(metrics.groundedSourceRecall).toBe(1);
  });

  it('retains the verbatim tail when the reducer output is unusable at the production window', async () => {
    const arm272k = FIDELITY_ARMS.find((a) => a.contextWindow === 272_000)!;
    const config = makeConfig(arm272k);
    const { history } = buildCompactFixtureHistory({ fillerRepeat: arm272k.fillerRepeat });
    mockedStream.mockImplementation(async function* () {
      yield { type: 'text', content: 'not a checkpoint' };
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });

    const result = await runCompact(config, history, { trigger: 'auto' });

    expect(result.status).toBe('compacted');
    if (result.status !== 'compacted') return;
    expect(result.degraded).toBe(true);
    expect(result.replacementHistory.length).toBeGreaterThan(1);
    // The same denominator `postHistoryUtilization` uses: the loop's gate.
    expect(result.postContextTokens).toBeGreaterThanOrEqual(
      0.35 * resolveCompactBudgets(config).preflightThreshold,
    );
  });
});
