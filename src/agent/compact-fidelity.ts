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
   * Post-compaction HISTORY tokens over `contextWindow * PREFLIGHT_FRACTION`,
   * averaged. Deliberately a proxy, not the loop's own gate: the loop compares
   * a full request estimate -- system prompt and tool schemas included --
   * against a threshold computed after subtracting its output reserve, and
   * neither of those is available here. The absolute value is therefore not
   * the loop's utilization; what makes it useful is that it is computed the
   * same way every run, so the design's "dead budget" -- headroom compaction
   * discards and then pays to rebuild by re-reading files -- is comparable
   * across changes.
   */
  postHistoryUtilization: number;
}

/**
 * The loop's preflight fraction, duplicated here as the proxy's denominator.
 * It is a literal on both sides; see `postHistoryUtilization` for why this
 * metric is not the loop's gate and does not try to be.
 */
export const PREFLIGHT_FRACTION = 0.8;

/**
 * The recorded v2 fidelity baseline, measured 2026-08-29 after Carried Ledger
 * phase 0 (items 0.1-0.5, 0.7) and audit item I landed.
 *
 * Floors, not targets, and they move in one direction only -- upward for
 * retention and grounding, downward for reducer calls. A change that lowers one
 * is a fidelity regression and has to be argued for rather than absorbed.
 *
 * They live beside the scorer, not in the test, so the provider-backed
 * benchmark can grade against the same numbers instead of duplicating them.
 *
 * Read them before trusting compaction with a long run. Under this corpus's
 * budget pressure v2 keeps only the newest third of what it was told, it drops
 * the oldest facts first, and `minVerbatimUserRetention` is **zero**: neither
 * constraint the user opened the conversation with is still in the checkpoint
 * after a single generation. That is the decay the Carried Ledger's
 * author-split exists to stop, and it is why the design puts user text in a
 * host-owned ledger the fitter may not rewrite.
 */
export const FIDELITY_BASELINE = {
  /** Measured 0.333 -- only the newest third of the planted facts survive. */
  minFinalRetention: 0.33,
  /** Measured 0.333 across the eight generations. */
  minMeanRetention: 0.33,
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
   * Measured 0.144, and a ceiling rather than a floor. This is the design's
   * "dead budget": compaction targets half the window, but the retention and
   * checkpoint caps pin the real post-compaction history far below it, and the
   * difference is headroom the agent is entitled to keep and instead pays to
   * rebuild by re-reading files. Phase 1's budget rework is expected to raise
   * this deliberately -- when it does, this constant must be updated
   * consciously rather than drift.
   */
  maxPostHistoryUtilization: 0.15,
} as const;

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
  contextWindow: number,
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
      record.postContextTokens / Math.max(1, contextWindow * PREFLIGHT_FRACTION),
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
