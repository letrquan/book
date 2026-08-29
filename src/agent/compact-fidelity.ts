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
import type { PlantedFact } from './compact-fixture.js';

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
   * Post-compaction request size as a fraction of the loop's preflight
   * threshold, averaged. The design calls the gap between this and 1.0 the
   * "dead budget" -- headroom compaction discards and then pays to rebuild.
   */
  postRequestUtilization: number;
}

/** Mirrors the loop's own preflight fraction; see `loop.ts`. */
export const PREFLIGHT_FRACTION = 0.8;

function checkpointText(checkpoint: ConversationCheckpointV2): string {
  return JSON.stringify(checkpoint);
}

/** A fact is retained when every one of its literal terms is present. */
export function factRetained(text: string, fact: PlantedFact): boolean {
  return fact.terms.every((term) => text.includes(term));
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
    const text = `${message.contextContent ?? message.content ?? ''}`;
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
  const utilizationPerGeneration: number[] = [];
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
    utilizationPerGeneration.push(
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
    postRequestUtilization: mean(utilizationPerGeneration),
  };
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}
