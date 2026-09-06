/**
 * Pure scoring for compaction fidelity.
 *
 * Every function here is deterministic and provider-free: it takes checkpoints
 * that a run already produced and returns numbers. No I/O, no model, no clock.
 * That is what lets the fidelity harness live in the unit tier and be ratcheted
 * like any other budget.
 *
 * `compact.ts` must never import this module -- scoring depends on compaction,
 * not the other way round.
 */

import type { Message } from '../types/messages.js';
import type { ConversationCheckpointV2 } from '../types/sessions.js';
import type { PlantedFact } from '../test/compact-fixture.js';

/** One generation's observable output, as the harness records it. */
export interface GenerationRecord {
  generation: number;
  checkpoint: ConversationCheckpointV2;
  /** History the compaction handed back: checkpoint message plus retained tail. */
  replacementHistory: readonly Message[];
  /** Reducer calls this compaction spent. */
  modelCalls: number;
  postContextTokens: number;
}

export interface FidelityMetrics {
  /**
   * For each planted fact, the generation at which it first went missing, or
   * `null` if it survived every generation. The headline number: a fact that
   * disappears at generation 2 is one the agent forgets within hours.
   */
  lostAtGeneration: Record<string, number | null>;
  /** Facts still present in the final generation, over all planted facts. */
  finalRetention: number;
  /** Mean retention across every generation. Degrades earlier than the final. */
  meanRetention: number;
  /** Retention restricted to facts a user stated as a constraint. */
  verbatimUserRetention: number;
  /**
   * Fraction of `current-value` facts whose current term is present, counting a
   * generation as wrong only when the superseded term is present WITHOUT it.
   */
  supersessionCorrectness: number;
  /** Fraction of checkpoint sources whose `eventRef` resolves to a real message. */
  groundedSourceRecall: number;
  /** Fraction of retained tail messages that carry a planted fact or observation. */
  retentionPrecision: number;
  /** Total reducer calls across every generation. */
  reducerCalls: number;
  /**
   * Post-compaction HISTORY tokens over the loop's preflight gate
   * (`resolveCompactBudgets(config).preflightThreshold`), averaged. The gate
   * counts the whole request -- system prompt and tool schemas included -- and
   * the harness has no request, so this is the history's share of the gate: an
   * upper bound on what a real session sees, computed the same way every run,
   * so the design's "dead budget" -- headroom compaction discards and then pays
   * to rebuild by re-reading files -- is comparable across changes.
   */
  postHistoryUtilization: number;
}

export interface FidelityFloors {
  minFinalRetention: number;
  minMeanRetention: number;
  minVerbatimUserRetention: number;
  minSupersessionCorrectness: number;
  minGroundedSourceRecall: number;
  minRetentionPrecision: number;
  maxReducerCalls: number;
  /** Floor now: the dead budget is reclaimed. Was the ceiling maxPostHistoryUtilization = 0.15. */
  minPostHistoryUtilization: number;
}

export interface FidelityArm {
  contextWindow: number;
  /** config.maxTokens for the arm: the output reserve the loop would subtract. */
  reservedOutputTokens: number;
  fillerRepeat: number;
  floors: FidelityFloors;
}

/**
 * The recorded v2 fidelity baseline, re-measured 2026-09-05 after the Carried
 * Ledger Phase 1 budget rework (residual retained tail); the pre-rework numbers
 * it replaces were measured 2026-08-30 after the Carried Ledger landed
 * (`agent/carried-ledger.ts`), which itself replaced the pre-ledger numbers from
 * 2026-08-29.
 *
 * Floors, not targets, and they move in one direction only -- upward for
 * retention and grounding, downward for reducer calls. A change that lowers one
 * is a fidelity regression and has to be argued for rather than absorbed.
 *
 * They live beside the scorer, not in the test, so the provider-backed
 * benchmark can grade against the same numbers instead of duplicating them.
 *
 * What changed. Before the ledger, `minVerbatimUserRetention` was **zero**:
 * neither constraint the user opened the conversation with was still in the
 * checkpoint after a single generation, because both lived in model-authored
 * episodes and the fitter evicts completed episodes oldest-first. The ledger's
 * author split moved user-written text into a host-owned field the fitter may
 * not evict, and the measured value is now 1.0 across all eight generations.
 * Overall retention rose with it -- from 0.333 to 0.667 -- because the same
 * sentences also carry facts the episodes were losing.
 *
 * What Phase 1 changed (2026-09-05, revised 2026-09-06 after review). The
 * retained tail is now the residual of the post-compaction target instead of a
 * flat 20k cap (`resolveCompactBudgets` in `compact.ts`), and the target is
 * half the loop's preflight gate, so the harness runs two arms: a 32k window
 * with a 4k reserve, and the 272k default window the owner's sessions actually
 * compact at, where the flat cap used to bind and no test could reach it.
 *
 * The 32k arm is NOT the corpus the 2026-08-30 floors were measured on. Its
 * filler grew from three repeats to five (the residual tail holds the whole
 * three-repeat corpus, so generation 1 had nothing to summarize), its tail is
 * ~7.9k tokens instead of 6.4k, and its target ~11.2k instead of 16k. Where a
 * floor below equals an older number, that is coincidence, not continuity; the
 * ratchet compares a floor only with a measurement on the same arm as recorded
 * here. `postHistoryUtilization` flipped from a 0.15 ceiling to a floor on both
 * arms and is now measured against the loop's own gate. `retentionPrecision`
 * fell from 0.898 and is NOT comparable with that number: an empty retained
 * tail scores 1.0, and seven of the eight old generations retained nothing,
 * so the old figure mostly measured the absence of a tail. With a real tail
 * the metric counts every retained turn that carries no planted fact, which
 * in this corpus is the filler by design. Each arm records its own floors.
 *
 * To re-measure after a change: run the fidelity test with
 * `BOOK_FIDELITY_PRINT=1` (the arm test prints one JSON line of metrics per
 * arm), then paste the numbers here with the date.
 */
export const FIDELITY_ARMS: readonly FidelityArm[] = [
  {
    contextWindow: 32_000,
    reservedOutputTokens: 4_096,
    /**
     * 3 was the corpus every earlier baseline ran on. At this window the
     * residual tail (~7.9k tokens) holds most of that corpus, so generation 1
     * would have little or nothing to summarize; 5 is the smallest filler that
     * pushes the oldest turns out of the tail again.
     */
    fillerRepeat: 5,
    floors: {
      /** Measured 0.667 on 2026-09-06. */
      minFinalRetention: 0.66,
      /** Measured 0.677 across the eight generations on 2026-09-06. */
      minMeanRetention: 0.67,
      /** Measured 1.0 on 2026-09-06. */
      minVerbatimUserRetention: 1,
      /** Measured 1.0 on 2026-09-06. */
      minSupersessionCorrectness: 1,
      /** Measured 1.0 on 2026-09-06. */
      minGroundedSourceRecall: 1,
      /**
       * Measured 0.026 on 2026-09-06. Not a regression against the old 0.898:
       * that figure came from seven generations that retained nothing (an
       * empty tail scores 1.0), and the ~7.9k tail here keeps two filler turns
       * per generation by construction. See the module comment.
       */
      minRetentionPrecision: 0.02,
      /** Measured 8 on 2026-09-06 -- one reducer call per generation, no repairs spent. */
      maxReducerCalls: 8,
      /**
       * Floor, not ceiling: dead budget reclaimed. Measured 0.470 against the
       * loop's 22,323-token gate on 2026-09-06; post-compaction history sits at
       * the target, which is half the gate.
       */
      minPostHistoryUtilization: 0.46,
    },
  },
  {
    contextWindow: 272_000,
    reservedOutputTokens: 64_000,
    fillerRepeat: 60,
    floors: {
      /** Measured 0.833 on 2026-09-06. */
      minFinalRetention: 0.83,
      /** Measured 0.823 across the eight generations on 2026-09-06. */
      minMeanRetention: 0.82,
      /** Measured 1.0 on 2026-09-06. */
      minVerbatimUserRetention: 1,
      /** Measured 1.0 on 2026-09-06. */
      minSupersessionCorrectness: 1,
      /** Measured 1.0 on 2026-09-06. */
      minGroundedSourceRecall: 1,
      /**
       * Measured 0.176 on 2026-09-06. A ~79k tail keeps the fixture's unrelated
       * filler turns by construction, so precision is not comparable across
       * arms and must not be rescued by shrinking the filler.
       */
      minRetentionPrecision: 0.17,
      /** Measured 8 on 2026-09-06 -- one reducer call per generation, no repairs spent. */
      maxReducerCalls: 8,
      /**
       * Floor, not ceiling: dead budget reclaimed. Measured 0.480 against the
       * loop's 166,400-token gate on 2026-09-06 (post-compaction history 77k-82k).
       */
      minPostHistoryUtilization: 0.47,
    },
  },
];

function checkpointText(checkpoint: ConversationCheckpointV2): string {
  return JSON.stringify(checkpoint);
}

/**
 * A fact is retained when every one of its terms appears as a whole token.
 *
 * Plain `includes` is wrong here and quietly inflates every retention number:
 * the corpus's superseded `npm` is a substring of its own replacement `pnpm`,
 * so it could never be scored as lost while `pnpm` survived, and the accepted
 * decision `1000` matches inside the token counts that appear in every
 * checkpoint's `statistics`.
 */
export function factRetained(text: string, fact: PlantedFact): boolean {
  return fact.terms.every((term) => containsToken(text, term));
}

function isWordChar(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/.test(character);
}

/**
 * Whole-token containment. Written by index rather than by regular expression so
 * a term needs no escaping and a term ending in punctuation, like `query()`, is
 * matched as readily as a bare word: an edge is only guarded when the term's own
 * character there is a word character.
 */
function containsToken(text: string, term: string): boolean {
  if (term.length === 0) return true;
  const guardStart = isWordChar(term[0]);
  const guardEnd = isWordChar(term[term.length - 1]);
  for (let from = 0; ;) {
    const at = text.indexOf(term, from);
    if (at < 0) return false;
    const before = at > 0 ? text[at - 1] : undefined;
    const after = at + term.length < text.length ? text[at + term.length] : undefined;
    if ((!guardStart || !isWordChar(before)) && (!guardEnd || !isWordChar(after))) return true;
    from = at + 1;
  }
}

/**
 * Supersession is not "the old value is gone". The corpus itself says
 * "us-east-1 is historical only", so a faithful checkpoint mentions both terms.
 * The failure being scored is presenting the superseded value while having lost
 * the current one -- that is when the agent acts on a stale value.
 */
export function supersessionCorrect(
  text: string,
  current: PlantedFact,
  superseded: PlantedFact | undefined,
): boolean {
  const hasCurrent = factRetained(text, current);
  if (hasCurrent) return true;
  if (!superseded) return false;
  return !factRetained(text, superseded);
}

/**
 * Grounding is scored on `eventRef`, never on quotes. `fitCheckpoint` legally
 * strips a non-inherited source down to its bare `eventRef` when it needs room,
 * so a missing quote after fitting is correct behaviour rather than a defect.
 */
export function groundedSourceRatio(
  checkpoint: ConversationCheckpointV2,
  history: readonly Message[],
): number {
  const ids = new Set(history.map((message) => message.id));
  let total = 0;
  let grounded = 0;
  const groups = [
    ...checkpoint.constraints.map((entry) => entry.sources),
    ...checkpoint.files.map((entry) => entry.sources),
    ...checkpoint.episodes.map((entry) => entry.sources),
    ...checkpoint.openThreads.map((entry) => entry.sources),
  ];
  for (const sources of groups) {
    for (const source of sources) {
      total++;
      const eventId = source.eventRef.replace(/^session:\/\/current\/event\//, '');
      if (ids.has(eventId)) grounded++;
    }
  }
  return total === 0 ? 1 : grounded / total;
}

/**
 * What fraction of the verbatim tail is carrying its weight. A retained message
 * counts when it holds a planted fact or a file observation; filler that merely
 * happens to be recent does not.
 */
export function retentionPrecisionFor(
  replacementHistory: readonly Message[],
  facts: readonly PlantedFact[],
): number {
  const retained = replacementHistory.filter((message) => message.kind !== 'checkpoint');
  if (retained.length === 0) return 1;
  const useful = retained.filter((message) => {
    if ((message.fileObservations ?? []).length > 0) return true;
    // Prose is not the only place a fact lives. A retained turn whose evidence
    // is a compiler error in a tool result is carrying its weight, and scoring
    // only `content` understates precision on exactly the tool-heavy corpus
    // this module added to cover that path.
    const text = [
      message.contextContent ?? message.content ?? '',
      ...(message.toolCalls ?? []).map((call) => JSON.stringify(call.arguments ?? {})),
      ...(message.toolResults ?? []).map((result) => result.content),
    ].join(' ');
    return facts.some((fact) => factRetained(text, fact));
  });
  return useful.length / retained.length;
}

/** Score a completed multi-generation run. */
export function scoreFidelity(
  generations: readonly GenerationRecord[],
  facts: readonly PlantedFact[],
  sourceHistory: readonly Message[],
  /** The loop's preflight gate for the arm's config: `resolveCompactBudgets(config).preflightThreshold`. */
  preflightThreshold: number,
): FidelityMetrics {
  if (generations.length === 0) {
    throw new Error('scoreFidelity requires at least one generation.');
  }
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const lostAtGeneration: Record<string, number | null> = {};
  for (const fact of facts) lostAtGeneration[fact.id] = null;

  const retentionPerGeneration: number[] = [];
  const supersessionPerGeneration: number[] = [];
  const groundedPerGeneration: number[] = [];
  const precisionPerGeneration: number[] = [];
  const historyUtilizationPerGeneration: number[] = [];
  let reducerCalls = 0;

  for (const record of generations) {
    const text = checkpointText(record.checkpoint);
    let retainedCount = 0;
    for (const fact of facts) {
      if (factRetained(text, fact)) {
        retainedCount++;
      } else if (lostAtGeneration[fact.id] === null) {
        lostAtGeneration[fact.id] = record.generation;
      }
    }
    retentionPerGeneration.push(retainedCount / facts.length);

    const currentFacts = facts.filter((fact) => fact.kind === 'current-value');
    supersessionPerGeneration.push(
      currentFacts.length === 0
        ? 1
        : currentFacts.filter((fact) =>
            supersessionCorrect(
              text,
              fact,
              fact.supersedes ? byId.get(fact.supersedes) : undefined,
            ),
          ).length / currentFacts.length,
    );

    groundedPerGeneration.push(groundedSourceRatio(record.checkpoint, sourceHistory));
    precisionPerGeneration.push(retentionPrecisionFor(record.replacementHistory, facts));
    historyUtilizationPerGeneration.push(
      record.postContextTokens / Math.max(1, preflightThreshold),
    );
    reducerCalls += record.modelCalls;
  }

  const constraintFacts = facts.filter((fact) => fact.kind === 'user-constraint');
  const finalText = checkpointText(generations[generations.length - 1].checkpoint);

  return {
    lostAtGeneration,
    finalRetention: retentionPerGeneration[retentionPerGeneration.length - 1],
    meanRetention: mean(retentionPerGeneration),
    verbatimUserRetention:
      constraintFacts.length === 0
        ? 1
        : constraintFacts.filter((fact) => factRetained(finalText, fact)).length /
          constraintFacts.length,
    supersessionCorrectness: mean(supersessionPerGeneration),
    groundedSourceRecall: mean(groundedPerGeneration),
    retentionPrecision: mean(precisionPerGeneration),
    reducerCalls,
    postHistoryUtilization: mean(historyUtilizationPerGeneration),
  };
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}
