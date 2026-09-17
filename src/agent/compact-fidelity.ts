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
import {
  PLANTED_FACT_KINDS,
  type PlantedFact,
  type PlantedFactKind,
} from '../test/compact-fixture.js';

/** One generation's observable output, as the harness records it. */
export interface GenerationRecord {
  generation: number;
  checkpoint: ConversationCheckpointV2;
  /** History the compaction handed back: carried turns, checkpoint message, retained tail. */
  replacementHistory: readonly Message[];
  /** Reducer calls this compaction spent. */
  modelCalls: number;
  postContextTokens: number;
}

export interface FidelityMetrics {
  /**
   * For each planted fact, the generation at which it first went missing from
   * the whole replacement history -- compacted representation and retained
   * tail alike -- or `null` if it survived every generation. The headline
   * number: a fact that disappears at generation 2 is one the agent forgets
   * within hours. A fact still sitting verbatim in the tail is not lost, even
   * though the retention metrics below do not count it yet.
   */
  lostAtGeneration: Record<string, number | null>;
  /**
   * Facts still present in the final generation's compacted representation --
   * the checkpoint plus the user turns carried verbatim ahead of it, never the
   * retained tail -- over all planted facts.
   */
  finalRetention: number;
  /** Mean retention across every generation. Degrades earlier than the final. */
  meanRetention: number;
  /**
   * Retention restricted to facts a user stated as a constraint, scored on the
   * Carried Ledger alone (`checkpoint.carried`): this is the ledger's
   * guarantee, and it must hold even when no turn is carried and when the
   * reducer's own `constraints` copy of the rule has been evicted.
   */
  verbatimUserRetention: number;
  /**
   * Final-generation retention in the compacted representation, split by the
   * kind of fact. The fitter is not equally obliged to every kind -- an
   * unresolved thread or a rule in force is worth more than a finished
   * episode -- and this is where that shows, or fails to.
   */
  retentionByKind: Record<PlantedFactKind, number>;
  /**
   * Retention of what the user said in their own words -- constraints and the
   * cue-less or non-English `user-statement` facts the ledger cannot extract
   * and the reducer double never records -- in the final compacted
   * representation. Zero before Carried Turns; a floor on the whole user turn
   * surviving, where `verbatimUserRetention` is a floor on the ledger.
   */
  userTurnRetention: number;
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
  minUserTurnRetention: number;
  minSupersessionCorrectness: number;
  minGroundedSourceRecall: number;
  minRetentionPrecision: number;
  maxReducerCalls: number;
  /** Floor now: the dead budget is reclaimed. Was the ceiling maxPostHistoryUtilization = 0.15. */
  minPostHistoryUtilization: number;
  /** Per-kind floors on `retentionByKind`; a kind not listed is unconstrained. */
  minRetentionByKind: Partial<Record<PlantedFactKind, number>>;
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
 * What Carried Turns changed (2026-09-14, `plans/compaction-research-2026-09.md`
 * P1). Retention is now scored on the compacted representation -- the
 * checkpoint plus the user turns carried verbatim ahead of it -- because that
 * is what survives when the tail is gone. The corpus gained two
 * `user-statement` facts the ledger's cues cannot catch (a hedged preference
 * and a rule in Vietnamese), and the reducer double was corrected to ground
 * only on events in the prompt it is shown, as a reducer can; before, it
 * recorded facts from the retained tail it never read. So the floors below
 * are NOT comparable with the 2026-09-06 numbers. Measured on the same corpus
 * and double immediately before and after the change:
 *
 *   arm    metric                  before   after
 *   32k    finalRetention          0.643    0.643
 *   32k    meanRetention           0.625    0.634
 *   32k    userTurnRetention       0.5      0.5
 *   32k    supersessionCorrectness 0.938    1.0
 *   32k    retentionPrecision      0.026    0.143
 *   32k    postHistoryUtilization  0.470    0.476
 *   272k   finalRetention          0.571    1.0
 *   272k   meanRetention           0.571    0.804
 *   272k   userTurnRetention       0.5      1.0
 *   272k   supersessionCorrectness 0.938    0.938
 *   272k   retentionPrecision      0.176    0.240
 *   272k   postHistoryUtilization  0.480    0.488
 *
 * At the 272k window the owner's sessions compact at, every planted fact is
 * in the final compacted representation; the corpus states them all in user
 * turns, and the turns are now kept. The 32k arm is neutral: its tail is one
 * ~7.5k bundle in a ~7.8k budget, the newest bundle is never given up for
 * carried turns, so they get the ~270 tokens it leaves -- the brief and the
 * newest few. `userTurnRetention` there is the ledger's two constraints, not
 * the two statements.
 *
 * What the type-aware fit changed (2026-09-17, research note P3). Two things
 * moved together, and the table separates them. First the double: it used to
 * write every fact as a finished episode with the fact buried mid-paragraph,
 * a shape no reducer writes, which measured the text ladder against nothing
 * real and could not tell the checkpoint's fields apart. It now records each
 * fact where a reducer puts it -- rules and accepted decisions as
 * `constraints`, unresolved items as `openThreads`, observed paths as
 * `files`, the narrative as `episodes` named in the task -- and re-emits
 * every inherited field verbatim; `verbatimUserRetention` is scored on the
 * ledger alone so the reducer's copy of a rule cannot mask a lost ledger
 * entry; and the corpus gained a fifteenth fact, the CRLF thread's last run
 * day, planted in the thread's own turn so one finished episode is cited by
 * an open thread. Then the fit: eviction by kind and dependency instead of by
 * age (`fitCheckpoint` in `compact.ts`). Measured on the new double and
 * corpus with the old fit and the new:
 *
 *   arm    metric                  old fit  new fit
 *   32k    finalRetention          0.667    0.733
 *   32k    meanRetention           0.658    0.725
 *   32k    timeline-event          0.667    1.0
 *   32k    accepted-decision       1.0      1.0
 *   32k    open-thread             1.0      1.0
 *   32k    current-value           0.5      0.5
 *   32k    postHistoryUtilization  0.486    0.486
 *   272k   finalRetention          1.0      1.0
 *   272k   meanRetention           0.817    0.817
 *
 * The moved number is the cited episode: the old fit evicted it at generation
 * 1 as the oldest finished episode, the new one keeps it for the thread's
 * sake. Everything else at 32k is the same loss as before -- the two
 * statements the tail cannot hold and the region values, finished episodes
 * nothing cites -- and 272k loses nothing either way. Per-kind floors are
 * recorded from here on. P4 (same day) reserved the reducer-audit notice in
 * the header envelope: 32k utilization 0.486 -> 0.485, precision 0.143 ->
 * 0.162 as one bundle moved; nothing else changed.
 *
 * To re-measure after a change: run the fidelity test with
 * `BOOK_FIDELITY_PRINT=<file>` (the arm test appends one JSON line of metrics
 * per arm to that file; vitest swallows console output of passing tests, so
 * the value `1`, which only prints, is rarely useful), then paste the numbers
 * here with the date.
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
      /** Measured 0.733 on 2026-09-17 (15-fact corpus, by-kind double, type-aware fit); 0.667 with the old fit. */
      minFinalRetention: 0.73,
      /** Measured 0.725 across the eight generations on 2026-09-17; 0.658 with the old fit. */
      minMeanRetention: 0.72,
      /** Measured 1.0 on 2026-09-14. */
      minVerbatimUserRetention: 1,
      /**
       * Measured 0.5 on 2026-09-14: the two constraints through the ledger; the
       * two statements do not fit the ~270 tokens the newest bundle leaves.
       */
      minUserTurnRetention: 0.5,
      /** Measured 1.0 on 2026-09-14. */
      minSupersessionCorrectness: 1,
      /** Measured 1.0 on 2026-09-14. */
      minGroundedSourceRecall: 1,
      /**
       * Measured 0.143 on 2026-09-14. Carried turns count as retained
       * messages, and the ones that carry a fact lift this from 0.026; the
       * ~7.9k tail still keeps filler by construction. Not comparable with the
       * pre-ledger 0.898, which mostly measured the absence of a tail.
       */
      minRetentionPrecision: 0.14,
      /** Measured 8 on 2026-09-14 -- one reducer call per generation, no repairs spent. */
      maxReducerCalls: 8,
      /**
       * Floor, not ceiling: dead budget reclaimed. Measured 0.486 against the
       * loop's 22,323-token gate on 2026-09-17 (0.476 on 2026-09-14);
       * post-compaction history sits at the target, which is half the gate.
       */
      minPostHistoryUtilization: 0.47,
      /**
       * Measured 2026-09-17. Rules, decisions and the open thread survive
       * whole; the finished episode the thread cites survives with it. The
       * region values are finished episodes nothing cites, and half of each
       * pair is lost at generation 2; the two statements are what the ~270
       * tokens of carried-turn room at this window cannot hold.
       */
      minRetentionByKind: {
        'user-constraint': 1,
        'accepted-decision': 1,
        'rejected-decision': 1,
        'open-thread': 1,
        'timeline-event': 1,
        'current-value': 0.5,
        'superseded-value': 0.5,
      },
    },
  },
  {
    contextWindow: 272_000,
    reservedOutputTokens: 64_000,
    fillerRepeat: 60,
    floors: {
      /** Measured 1.0 on 2026-09-17 (15-fact corpus, by-kind double) and on 2026-09-14; 0.571 before Carried Turns. */
      minFinalRetention: 1,
      /** Measured 0.817 across the eight generations on 2026-09-17 (0.804 on the 14-fact corpus); 0.571 before. */
      minMeanRetention: 0.81,
      /** Measured 1.0 on 2026-09-14. */
      minVerbatimUserRetention: 1,
      /** Measured 1.0 on 2026-09-14; 0.5 before -- the cue-less and Vietnamese statements. */
      minUserTurnRetention: 1,
      /**
       * Measured 0.9375 on 2026-09-14, before and after: at generation 1 the
       * corrected double records the old region from the events it is shown
       * while the correction still sits in the retained tail, which this
       * metric does not read. The 2026-09-06 floor of 1 came from the double
       * grounding on the tail.
       */
      minSupersessionCorrectness: 0.93,
      /** Measured 1.0 on 2026-09-14. */
      minGroundedSourceRecall: 1,
      /**
       * Measured 0.240 on 2026-09-14 (0.176 before). A ~79k tail keeps the
       * fixture's unrelated filler turns by construction, so precision is not
       * comparable across arms and must not be rescued by shrinking the filler.
       */
      minRetentionPrecision: 0.23,
      /** Measured 8 on 2026-09-14 -- one reducer call per generation, no repairs spent. */
      maxReducerCalls: 8,
      /**
       * Floor, not ceiling: dead budget reclaimed. Measured 0.487 against the
       * loop's 166,400-token gate on 2026-09-17 (post-compaction history 79k-82k).
       */
      minPostHistoryUtilization: 0.48,
      /** Measured 2026-09-17: every kind whole at the window the owner's sessions compact at. */
      minRetentionByKind: {
        'user-constraint': 1,
        'user-statement': 1,
        'accepted-decision': 1,
        'rejected-decision': 1,
        'current-value': 1,
        'superseded-value': 1,
        'open-thread': 1,
        'timeline-event': 1,
      },
    },
  },
];

function checkpointText(checkpoint: ConversationCheckpointV2): string {
  return JSON.stringify(checkpoint);
}

/**
 * The compacted representation: what survives when the retained tail is gone.
 * The checkpoint, plus the user turns compaction carried verbatim ahead of it
 * (`kind: 'carried'`); a carried turn's provider-facing text is what counts.
 */
function compactedText(record: GenerationRecord): string {
  const carried = record.replacementHistory
    .filter((message) => message.kind === 'carried')
    .map((message) => message.contextContent ?? message.content);
  return [checkpointText(record.checkpoint), ...carried].join('\n');
}

/** Everything the model would see after this compaction: the compacted representation plus the tail. */
function replacementText(record: GenerationRecord): string {
  const tail = record.replacementHistory
    .filter((message) => message.kind !== 'checkpoint' && message.kind !== 'carried')
    .map((message) =>
      [
        message.contextContent ?? message.content ?? '',
        ...(message.toolCalls ?? []).map((call) => JSON.stringify(call.arguments ?? {})),
        ...(message.toolResults ?? []).map((result) => result.content),
      ].join(' '),
    );
  return [compactedText(record), ...tail].join('\n');
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
    const text = compactedText(record);
    const inContext = replacementText(record);
    let retainedCount = 0;
    for (const fact of facts) {
      if (factRetained(text, fact)) retainedCount++;
      if (!factRetained(inContext, fact) && lostAtGeneration[fact.id] === null) {
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
  const userFacts = facts.filter(
    (fact) => fact.kind === 'user-constraint' || fact.kind === 'user-statement',
  );
  const finalRecord = generations[generations.length - 1];
  const finalLedgerText = JSON.stringify(finalRecord.checkpoint.carried ?? {});
  const finalCompactedText = compactedText(finalRecord);
  const retentionByKind = {} as Record<PlantedFactKind, number>;
  for (const kind of PLANTED_FACT_KINDS) {
    const ofKind = facts.filter((fact) => fact.kind === kind);
    retentionByKind[kind] =
      ofKind.length === 0
        ? 1
        : ofKind.filter((fact) => factRetained(finalCompactedText, fact)).length / ofKind.length;
  }

  return {
    lostAtGeneration,
    finalRetention: retentionPerGeneration[retentionPerGeneration.length - 1],
    meanRetention: mean(retentionPerGeneration),
    verbatimUserRetention:
      constraintFacts.length === 0
        ? 1
        : constraintFacts.filter((fact) => factRetained(finalLedgerText, fact)).length /
          constraintFacts.length,
    retentionByKind,
    userTurnRetention:
      userFacts.length === 0
        ? 1
        : userFacts.filter((fact) => factRetained(finalCompactedText, fact)).length /
          userFacts.length,
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
