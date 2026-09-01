/**
 * The Carried Ledger: user-authored constraints, kept by the host across
 * compaction generations.
 *
 * Why this module exists. Before it, every fact in a checkpoint was written by
 * the reducer into `episodes` / `constraints` and then re-fitted by
 * `fitCheckpoint` at every generation. Under budget pressure the fitter evicts
 * completed episodes oldest-first and truncates text down a ladder, so the
 * oldest facts go first -- and the oldest facts in a coding session are the
 * rules the user opened with. Book's own fidelity harness measured
 * `verbatimUserRetention` at **0.0**: both opening constraints were gone by
 * generation 1. A rule given on turn 3 did not survive to hour two, let alone
 * to day two.
 *
 * The fix is an author split. Text the *user* wrote is not the reducer's to
 * paraphrase and not the fitter's to evict, so the host extracts it, stores it
 * verbatim in a field of its own, and re-attaches it after every generation.
 * The reducer can read it (it seeds the prompt) but can never write it:
 * `parseAndValidateCheckpoint` deletes whatever the model puts in `carried`.
 *
 * The cost of "the fitter may not touch it" is that the ledger grows forever,
 * which is just the overflow moved one level down. So it carries its own cap
 * (`capCarriedLedger`) and its own supersession rule -- both here, both
 * deterministic, neither needing a model call.
 *
 * Extraction is heuristic and deliberately so: it is a cheap, auditable,
 * provider-free scan for directive sentences. It will miss a constraint phrased
 * without a cue word, and it will occasionally keep a sentence that only reads
 * like one. Both failures are bounded -- a miss leaves behaviour exactly as it
 * was before this module, and a false positive costs a few dozen tokens and is
 * the first thing the cap evicts.
 *
 * `compact.ts` owns the wiring; this module is pure.
 */

import type { CarriedConstraint, CarriedLedger } from '../types/sessions.js';
import type { Message } from '../types/messages.js';
import { looksLikeSecretOrUnfit } from '../secret-detect.js';

/** Hard ceiling on entries, independent of the token cap. */
export const CARRIED_LEDGER_MAX_ENTRIES = 32;
/** Hard ceiling on the serialized ledger, independent of the checkpoint budget. */
export const CARRIED_LEDGER_MAX_TOKENS = 1_024;
/**
 * The most of a checkpoint's budget the ledger may claim. The ledger is
 * un-evictable, so without this a long conversation full of directives would
 * starve the summary and the file list the agent also needs.
 */
const CARRIED_LEDGER_BUDGET_FRACTION = 0.35;
/** Longest verbatim entry. Past this the sentence is prose, not a rule. */
export const CARRIED_ENTRY_MAX_CHARS = 280;
/** Shortest sentence worth recording. */
const CARRIED_ENTRY_MIN_CHARS = 12;
/**
 * Content-token overlap at which a later entry is treated as restating an
 * earlier one. High on purpose: a wrong supersession mark makes a live rule the
 * first thing the cap evicts, which is the failure this module exists to stop.
 */
const SUPERSESSION_OVERLAP = 0.7;

/**
 * Directive cues, strongest first within each list.
 *
 * Matched case-insensitively on word boundaries against a single sentence. The
 * split into strong and weak is what gives the cap a principled order to evict
 * in: "never touch the vendored parser" outranks "prefer the async spawn".
 */
const STRONG_CUES = [
  'under no circumstances',
  'at all times',
  'must not',
  'must never',
  'must',
  'never',
  'always',
  'do not',
  "don't",
  'cannot',
  "can't",
  'should not',
  "shouldn't",
  // `is/are required` and `require(s)`, but never the bare participle: "found no
  // change required" is a report, not a rule, and admitting it filled the ledger
  // with narration on the first corpus this ran against.
  'is required',
  'are required',
  'requires',
  'require',
  'forbidden',
  'not allowed',
  'disallowed',
  'prohibited',
  'mandatory',
];

const WEAK_CUES = [
  'make sure',
  'no longer',
  'instead of',
  'stick to',
  'avoid',
  'ensure',
  'keep',
  'prefer',
  'should',
];

const CUE_PATTERNS: Array<{ pattern: RegExp; strength: CarriedConstraint['strength'] }> = [
  ...STRONG_CUES.map((cue) => ({ pattern: cuePattern(cue), strength: 'strong' as const })),
  ...WEAK_CUES.map((cue) => ({ pattern: cuePattern(cue), strength: 'weak' as const })),
  // Restrictive `only` has to govern something: "use only pnpm" is a rule,
  // "the result was informational only" is a sentence that happens to end in it.
  { pattern: /\bonly\b(?=\s+\S)/i, strength: 'weak' },
];

function cuePattern(cue: string): RegExp {
  // The cue list is a literal allowlist, so escaping only guards the apostrophes
  // and keeps the constructor honest if the list grows.
  const escaped = cue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

/**
 * Words that carry no topic. Stripped before overlap scoring so supersession is
 * judged on *what* the rule is about, not on how emphatically it was phrased --
 * otherwise "always use X" and "never use X" score as near-identical because
 * they share every word that is not the polarity.
 */
const TOPIC_STOPWORDS = new Set([
  // Normalized exactly as `topicTokens` normalizes what it compares against.
  // Splitting the raw cue leaves "don't" in the set while a token is "don" plus
  // "t", so the polarity stem leaks into the topic and depresses overlap below
  // the supersession threshold for every contraction cue.
  ...STRONG_CUES.flatMap((cue) => normalizeForId(cue).split(' ')),
  ...WEAK_CUES.flatMap((cue) => normalizeForId(cue).split(' ')),
  'only',
  'required',
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'for',
  'to',
  'of',
  'in',
  'on',
  'at',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'we',
  'you',
  'i',
  'our',
  'your',
  'my',
  'me',
  'us',
  'as',
  'by',
  'with',
  'from',
  'any',
  'all',
  'not',
  'no',
  'so',
  'if',
  'when',
  'then',
  'than',
  'there',
  'here',
  'please',
]);

/** A user turn whose prose the user actually wrote. */
function isUserAuthored(message: Message): boolean {
  if (message.role !== 'user') return false;
  // A resolved slash-command body and a delegated agent's task prompt both arrive
  // as `role: 'user'` prose. Neither is the user's own words: the first is
  // repository- or Book-authored, the second was written by the delegating model.
  // Admitting them let a checked-in `.book/commands/*.md` plant a rule this ledger
  // then quoted back as verbatim user intent and the fitter was forbidden to evict.
  if (message.derivedContent) return false;
  if (message.kind && message.kind !== 'conversation') return false;
  // A user-role message carrying tool traffic or a delivered agent notification
  // is transport, not authorship.
  if (message.toolCalls?.length || message.toolResults?.length) return false;
  if (message.agentNotifications?.length) return false;
  return true;
}

/**
 * Split into candidate sentences.
 *
 * Newlines first so a bulleted rule list yields one candidate per bullet, then
 * terminal punctuation. A sentence is the unit because it is the smallest span
 * that still reads as a rule on its own.
 */
function splitSentences(text: string): string[] {
  return (
    text
      .split(/\r?\n+/)
      .flatMap((line) => line.split(/(?<=[.!?])\s+/))
      // The trailing `\s+` is load-bearing: without it `\d+[.)]` eats the `3.` of
      // "3.11 is required" and `[-*+]` eats the `-` of "-Wall must be passed",
      // silently rewriting text this module then quotes back as the user's verbatim words.
      .map((piece) => piece.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
      .filter(Boolean)
  );
}

function classify(sentence: string): CarriedConstraint['strength'] | undefined {
  for (const { pattern, strength } of CUE_PATTERNS) {
    if (pattern.test(sentence)) return strength;
  }
  return undefined;
}

function normalizeForId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * djb2, hex. Not a security boundary -- it only has to be stable across
 * generations and cheap, so the same sentence keeps the same id and merges
 * instead of accumulating a duplicate every time the user repeats themselves.
 */
function entryId(normalized: string): string {
  let hash = 5381;
  for (let index = 0; index < normalized.length; index++) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(index)) >>> 0;
  }
  return `c${hash.toString(16).padStart(8, '0')}`;
}

function topicTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of normalizeForId(text).split(' ')) {
    if (token.length < 3) continue;
    if (TOPIC_STOPWORDS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

function overlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

function truncate(text: string): string {
  if (text.length <= CARRIED_ENTRY_MAX_CHARS) return text;
  return `${text.slice(0, CARRIED_ENTRY_MAX_CHARS - 3).trimEnd()}...`;
}

/**
 * Extract candidate constraints from user-authored turns, oldest first.
 *
 * Reads `content` -- the text the user typed -- and never `contextContent`.
 * That is a security boundary, not a convenience: `contextContent` carries
 * `@file` expansions and shell-substitution output, so a repository could plant
 * a sentence there and have it promoted into a host-owned record the fitter is
 * forbidden to evict. Nothing the repository controls reaches this ledger.
 */
export function extractUserConstraints(
  messages: readonly Message[],
  generation: number,
): CarriedConstraint[] {
  const entries: CarriedConstraint[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (!isUserAuthored(message)) continue;
    for (const sentence of splitSentences(message.content ?? '')) {
      if (sentence.length < CARRIED_ENTRY_MIN_CHARS) continue;
      const strength = classify(sentence);
      if (!strength) continue;
      const text = truncate(sentence);
      // A ledger that never forgets is the last place to write a credential.
      if (looksLikeSecretOrUnfit(text)) continue;
      const normalized = normalizeForId(text);
      if (!normalized) continue;
      const id = entryId(normalized);
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push({
        id,
        text,
        strength,
        source: { eventRef: `session://current/event/${message.id}` },
        firstSeenGeneration: generation,
        lastSeenGeneration: generation,
      });
    }
  }
  return entries;
}

/**
 * Merge newly extracted entries into the inherited ledger.
 *
 * Append-only by construction: an id already present is refreshed
 * (`lastSeenGeneration`) rather than re-added, and existing entries keep their
 * position. Order is the ledger's meaning -- the reading rule the checkpoint
 * carries is "later entries win" -- so nothing is ever reordered.
 */
export function mergeCarriedLedger(
  prior: CarriedLedger | undefined,
  extracted: readonly CarriedConstraint[],
  generation: number,
): CarriedLedger {
  const constraints = (prior?.constraints ?? []).map((entry) => ({ ...entry }));
  const byId = new Map(constraints.map((entry) => [entry.id, entry]));
  for (const entry of extracted) {
    const existing = byId.get(entry.id);
    if (existing) {
      // A rule the user restated is live again: bumping `lastSeenGeneration` is
      // what makes `markSupersessions` treat it as the most recent word on its
      // topic rather than leaving it flagged from an earlier pass.
      existing.lastSeenGeneration = Math.max(existing.lastSeenGeneration, generation);
      continue;
    }
    constraints.push(entry);
    byId.set(entry.id, entry);
  }
  markSupersessions(constraints);
  return {
    version: 1,
    constraints,
    ...(prior?.droppedCount ? { droppedCount: prior.droppedCount } : {}),
  };
}

/**
 * Mark an entry as superseded when another entry restates it more recently.
 *
 * This is the only supersession the host can decide without a model, and it is
 * intentionally narrow: near-identical topic wording. Genuine contradictions
 * the wording does not reveal ("use npm" then "use pnpm") are NOT detected
 * here, and are not meant to be. They are resolved by the ledger's ordering
 * rule instead -- both entries stay, oldest first, and the reader is told that
 * later entries win. Marking is an eviction hint, never a deletion.
 *
 * "More recently" is `lastSeenGeneration`, with ledger position as the
 * tie-break. Position alone is wrong: an entry the user restates keeps its
 * original slot, so a rule revived on turn 40 would still be marked superseded
 * by the paraphrase that displaced it on turn 4 -- and then be the first thing
 * the cap evicted.
 */
function markSupersessions(constraints: CarriedConstraint[]): void {
  const tokens = constraints.map((entry) => topicTokens(entry.text));
  const isLater = (candidate: number, subject: number): boolean =>
    constraints[candidate].lastSeenGeneration === constraints[subject].lastSeenGeneration
      ? candidate > subject
      : constraints[candidate].lastSeenGeneration > constraints[subject].lastSeenGeneration;

  for (let subject = 0; subject < constraints.length; subject++) {
    delete constraints[subject].supersededBy;
    for (let candidate = constraints.length - 1; candidate >= 0; candidate--) {
      if (candidate === subject || !isLater(candidate, subject)) continue;
      if (overlap(tokens[subject], tokens[candidate]) < SUPERSESSION_OVERLAP) continue;
      constraints[subject].supersededBy = constraints[candidate].id;
      break;
    }
  }
}

/** Serialized cost of a ledger, for callers that must budget around it. */
export function carriedLedgerTokens(ledger: CarriedLedger): number {
  return ledgerTokens(ledger);
}

function ledgerTokens(ledger: CarriedLedger): number {
  return Math.ceil(JSON.stringify(ledger).length / 4);
}

/**
 * Resolve the ledger's token budget for a checkpoint of `checkpointBudget`.
 *
 * Two ceilings, both needed: the absolute one keeps a huge context window from
 * licensing an unbounded ledger, and the fractional one keeps a small window
 * from letting the ledger crowd out the rest of the checkpoint.
 */
export function carriedLedgerBudget(checkpointBudget: number): number {
  // There is deliberately no absolute floor. One used to raise the result to 64
  // tokens, which on a small checkpoint budget out-ranked the fractional ceiling
  // it is paired with -- a budget of 100 yielded 64, two thirds of the whole
  // checkpoint, in a field `fitCheckpoint` may not evict from. A ledger squeezed
  // to a few tokens is not a failure mode: `capCarriedLedger` shortens a lone
  // over-budget entry rather than returning nothing.
  return Math.floor(
    Math.min(CARRIED_LEDGER_MAX_TOKENS, checkpointBudget * CARRIED_LEDGER_BUDGET_FRACTION),
  );
}

/**
 * Bound the ledger. This is the ledger's answer to "what stops it becoming the
 * next overflow", and it is the only place entries are ever removed.
 *
 * Eviction order, oldest first within each tier:
 *   1. superseded entries -- a restatement of them is already in the ledger,
 *   2. weak entries -- softer steers,
 *   3. strong entries -- last resort, and counted in `droppedCount` so a lossy
 *      ledger is legible rather than silent.
 *
 * The newest entry is never evicted while any other remains: the most recent
 * thing the user said is the least safe thing to forget.
 */
export function capCarriedLedger(ledger: CarriedLedger, budgetTokens: number): CarriedLedger {
  let constraints = ledger.constraints.map((entry) => ({ ...entry }));
  // Counts what this capping dropped, not what every previous one did. Seeding
  // from `ledger.droppedCount` compounded: each generation re-extracts the rules
  // whose turns are still in the window, merge restores the ones the last cap
  // evicted, and this cap evicts them again -- so the same handful of lost rules
  // was re-counted every generation and the disclosure grew without bound.
  let dropped = 0;

  const fits = (): boolean => {
    // Length alone settles it, and settling it here matters: `ledgerTokens`
    // serializes the whole ledger, so consulting it once per eviction is
    // quadratic in bytes when extraction produced hundreds of candidates.
    if (constraints.length > CARRIED_LEDGER_MAX_ENTRIES) return false;
    const candidate: CarriedLedger = {
      version: 1,
      constraints,
      ...(dropped ? { droppedCount: dropped } : {}),
    };
    return ledgerTokens(candidate) <= budgetTokens;
  };

  const tiers: Array<(entry: CarriedConstraint) => boolean> = [
    (entry) => entry.supersededBy !== undefined,
    (entry) => entry.strength === 'weak',
    () => true,
  ];

  for (const matches of tiers) {
    while (!fits() && constraints.length > 1) {
      const index = constraints.findIndex(
        (entry, position) => matches(entry) && position < constraints.length - 1,
      );
      if (index < 0) break;
      constraints.splice(index, 1);
      dropped++;
    }
  }

  // A single entry that is itself over budget: keep it, shortened, rather than
  // return an empty ledger. A truncated rule still names its subject.
  if (!fits() && constraints.length === 1) {
    const only = constraints[0];
    const room = Math.max(16, budgetTokens * 4 - JSON.stringify({ ...only, text: '' }).length - 64);
    if (only.text.length > room) {
      constraints = [{ ...only, text: `${only.text.slice(0, Math.max(1, room - 3))}...` }];
    }
  }

  return {
    version: 1,
    constraints,
    ...(dropped ? { droppedCount: dropped } : {}),
  };
}

/**
 * Build the ledger for one compaction: inherit, extract, merge, cap.
 *
 * Returns `undefined` when there is nothing to carry, so a conversation that
 * stated no constraint pays no bytes for the feature.
 */
export function buildCarriedLedger(
  prior: CarriedLedger | undefined,
  messages: readonly Message[],
  generation: number,
  checkpointBudget: number,
): CarriedLedger | undefined {
  const merged = mergeCarriedLedger(
    prior,
    extractUserConstraints(messages, generation),
    generation,
  );
  if (merged.constraints.length === 0) return undefined;
  return capCarriedLedger(merged, carriedLedgerBudget(checkpointBudget));
}

/**
 * The reading rule, carried with the checkpoint message.
 *
 * Without it the ledger is just another list the model may average against the
 * reducer's paraphrase. It states the two things the host guarantees and the
 * model cannot infer from the JSON: the text is the user's own, and order
 * decides conflicts.
 */
export function carriedLedgerNotice(ledger: CarriedLedger | undefined): string {
  if (!ledger || ledger.constraints.length === 0) return '';
  const lossy = ledger.droppedCount
    ? ` ${ledger.droppedCount} older entr${ledger.droppedCount === 1 ? 'y was' : 'ies were'} dropped by the ledger cap and can be retrieved from session history.`
    : '';
  return `[carried: ${ledger.constraints.length} constraint(s) quoted verbatim from the user's own turns, oldest first; they remain in force, and where two conflict the later one wins.${lossy}]\n`;
}
