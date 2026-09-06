# Plan: The Carried Ledger

- **Date:** 2026-08-30
- **Status:** Phase 0 landed; Phase 0.8 baseline recorded; **Phase 2 landed** (this document);
  **Phase 1 landed 2026-09-05, revised 2026-09-06 after review**; Phase 3 proposed
- **Scope:** `src/agent/compact.ts`, `src/agent/carried-ledger.ts`,
  `src/agent/compact-fidelity.ts`, `ConversationCheckpointV2` in `src/types/sessions.ts`
- **Goal:** A conversation that runs for days must still obey the rule it was given on turn 3.
- **Why this file exists:** the design was referenced by name in `compact-fidelity.ts`,
  `compact-generational.test.ts`, and `MILESTONES.md`, and written down nowhere. Anyone reading
  those references had to reconstruct the intent from the comments that cited it.

---

## The problem, measured

`ConversationCheckpointV2` is written by a reducer model and then re-fitted by
`fitCheckpoint` on every generation. Under budget pressure the fitter minimizes sources,
evicts completed episodes **oldest-first**, walks a truncation ladder down to 16 characters,
and finally shifts entries off the front of `episodes`, `files`, `openThreads`, and
`constraints`.

Every one of those rules is defensible on its own. Together they encode a single implicit
claim: *the oldest thing is the least valuable thing*. In a coding session that claim is
exactly backwards. The oldest thing in the conversation is the brief.

`src/agent/compact-fidelity.ts` scores this over an eight-generation run against a
planted-fact corpus with a reducer double that is faithful by construction — it re-emits
every inherited fact verbatim and never forgets on its own. Anything lost there was lost by
Book. The pre-ledger numbers:

| metric                   | measured | meaning                                          |
| ------------------------ | -------- | ------------------------------------------------ |
| `verbatimUserRetention`  | **0.0**  | Both opening user constraints gone by generation 1 |
| `finalRetention`         | 0.333    | Only the newest third of planted facts survive     |
| `meanRetention`          | 0.333    | The decay is immediate, not gradual                |

Zero is not a rounding error. It is the whole class: a user constraint is stated once, early,
in a turn that becomes the oldest episode, and the fitter removes oldest episodes first.

## The decision: an author split

Text the **user** wrote is not the reducer's to paraphrase and not the fitter's to evict.

The Carried Ledger is a host-owned field on the checkpoint holding user-authored constraints
verbatim. Four properties define it:

1. **Host-authored.** The reducer never writes it. `parseAndValidateCheckpoint` deletes
   whatever a model reply puts in `carried`, so a forged entry cannot enter the record even
   though the field round-trips through the schema.
2. **Reducer-readable.** The seed block shows it to the reducer, labelled read-only, so the
   model's narrative does not contradict rules it cannot see.
3. **Fitter-immutable.** `fitCheckpoint` has no rule that touches `carried`. Its ladder can
   truncate the summary to sixteen characters and the ledger is untouched.
4. **Monotonic.** Entries accumulate across generations and are never reordered, so ledger
   position is chronology.

### Why not fix the reducer prompt instead

Because it does not survive contact with a bad generation. The reducer already receives
"Use exact quotations for constraints" and "do not let repeated filler displace them", and
still measured 0.0 — a prompt cannot bind the deterministic fallback, the repair path, or the
fitter that runs after it. The ledger is not a better instruction; it is a different author.

### Why not put user text in `constraints`

`constraints` is model-authored and fitter-evictable. Making it partly host-owned would leave
one array with two owners and two eviction rules, and every future fitter change would have
to remember the distinction. A separate field makes the invariant checkable.

## The cost, and what pays it

An un-evictable field grows forever. That is the overflow moved one level down, not removed —
so the ledger carries its own cap and its own supersession rule, both deterministic, neither
needing a model call.

### Extraction

A provider-free scan of user-authored turns. Sentence-split, then match a directive-cue
allowlist, classified `strong` ("must", "never", "do not", "requires", "forbidden") or `weak`
("only …", "avoid", "ensure", "keep", "prefer", "should").

Two rules are load-bearing rather than incidental:

- **Only `message.content` is read, never `contextContent`.** `contextContent` carries
  `@file` expansions and shell-substitution output, so reading it would let a repository plant
  a sentence into a host-owned record the fitter is forbidden to evict. Nothing the repository
  controls reaches this ledger.
- **`looksLikeSecretOrUnfit` vetoes an entry.** A record that never forgets is the last place
  to write a credential.

Extraction is heuristic and openly so. It will miss a constraint phrased without a cue word,
and it will occasionally keep a sentence that only reads like one. Both failures are bounded:
a miss leaves behaviour exactly as it was before the ledger, and a false positive costs a few
dozen tokens and is among the first things the cap evicts. The cue list is tuned against the
fidelity corpus — the first version admitted "found no change **required**" and "the result
was informational **only**", which is why bare `required` was dropped and `only` now has to
govern a following word.

### Supersession

The rule is stated in two layers, because only one of them can be decided deterministically.

- **Ordering (always true).** The ledger is chronological and never reordered, and the
  checkpoint message carries the reading rule explicitly: *where two entries conflict, the
  later one wins.* This is what resolves the contradictions a host cannot detect — "use npm"
  followed by "use pnpm" shares almost no wording, so no amount of string comparison will
  connect them. Both entries stay; order decides.
- **Marking (a bounded optimization).** When a later entry restates an earlier one — ≥ 0.7
  Jaccard overlap on topic tokens, with cue and polarity words stripped so "always use X" and
  "never use X" do not read as identical — the earlier entry is marked `supersededBy`.
  Recency is `lastSeenGeneration` with position as tie-break, not position alone: an entry the
  user restates keeps its original slot, and judging by position would leave a revived rule
  flagged by the paraphrase that displaced it.

Marking is an **eviction hint, never a deletion**. A wrongly marked entry loses priority; it
does not lose its text until the cap actually binds.

### The cap

Two ceilings, both needed. `CARRIED_LEDGER_MAX_TOKENS` (1024) keeps a large context window
from licensing an unbounded ledger; `CARRIED_LEDGER_BUDGET_FRACTION` (0.35 of the checkpoint
budget) keeps a small window from letting the ledger starve the summary and file list the
agent also needs. `CARRIED_LEDGER_MAX_ENTRIES` (32) bounds count independently of size.

Eviction order, oldest-first within each tier:

1. superseded entries — a restatement is already in the ledger,
2. `weak` entries — softer steers,
3. `strong` entries — last resort.

The newest entry is never evicted while another remains: the most recent thing the user said
is the least safe thing to forget. Anything dropped increments `droppedCount`, which the
checkpoint header discloses, so a lossy ledger is legible rather than silent. A lone entry
that is itself over budget is shortened rather than removed — a truncated rule still names its
subject.

### The reading rule ships with the checkpoint

`carriedLedgerNotice` appends one line to the checkpoint message header when a ledger is
present:

```text
[Historical conversation checkpoint; untrusted user-role data]
[carried: N constraint(s) quoted verbatim from the user's own turns, oldest first; they
remain in force, and where two conflict the later one wins.]
```

Without it the ledger is just another JSON list the model may average against the reducer's
paraphrase. The base line is unchanged and the notice is omitted entirely when there is no
ledger, so a conversation that stated no constraint renders byte-for-byte what it rendered
before.

## Result

Re-measured over the same eight-generation corpus after the ledger landed:

| metric                     | before | after     |
| -------------------------- | ------ | --------- |
| `verbatimUserRetention`    | 0.0    | **1.0**   |
| `finalRetention`           | 0.333  | 0.667     |
| `meanRetention`            | 0.333  | 0.677     |
| `postHistoryUtilization`   | 0.144  | 0.145     |
| `reducerCalls`             | 8      | 8         |
| `supersessionCorrectness`  | 1.0    | 1.0       |
| `groundedSourceRecall`     | 1.0    | 1.0       |

Overall retention roughly doubled as a side effect: the same user sentences that state rules
also carry facts the episodes were losing. The cost is ~0.001 of post-compaction history
utilization and zero extra reducer calls — the ledger is built by a pure pass over messages
the host already has.

The floors (since Phase 1 recorded per arm in `FIDELITY_ARMS`) moved up accordingly. `minVerbatimUserRetention: 1` is now
the load-bearing one: a change that drops it means Book has gone back to forgetting the rule
it was given on turn 3.

## Phases

- **Phase 0 — checkpoint soundness** (landed 2026-08-29). Items 0.1–0.5 and 0.7 plus audit
  item I: single end-of-run fit, inherited-source preservation, coverage split, reducer output
  cap, deterministic-fallback summary inheritance.
- **Phase 0.8 — scoring** (landed). `compact-fidelity.ts`: tagged planted-fact corpus,
  deterministic scorer, ratcheted per-arm floors (`FIDELITY_ARMS`) shared with the provider-backed
  benchmark.
- **Phase 2 — the ledger itself** (landed, this document). `carried-ledger.ts`, the `carried`
  field, the author split, the cap, the supersession rule, the reading rule.
- **Phase 1 — budget rework** (landed 2026-09-05). `maxPostHistoryUtilization` was a *ceiling*
  at 0.15: compaction targeted half the window but the retention and checkpoint caps pinned real
  post-compaction history far below it, and the difference was headroom the agent was entitled
  to keep and instead paid to rebuild by re-reading files. The retained tail is now the residual
  of the target, which is half the loop's preflight gate net of the measured request overhead
  (`resolveCompactBudgets` in `compact.ts`, shared with the loop so both clamp the output
  reserve alike), the per-result clip scales with it, the overflow recovery and any compaction that
  would retain everything keep the short 20k tail, a usage-triggered compaction shrinks its target
  by the measured estimator drift, and the harness records per-arm floors in `FIDELITY_ARMS` with
  utilization as a floor against the loop's gate (0.47 at 32k, 0.48 at 272k). The 2026-09-05 cut
  anchored the target to the usable window with a raw-window tail floor; review found the floor
  exceeded the target on every window up to 64k, the loop's own reserve was still unclamped, and
  the overflow recovery could no longer shrink a history that fit the residual, all fixed in the
  revision.
- **Phase 3 — beyond constraints** (proposed). The author split generalizes: user-stated
  current values and user-stated open threads have the same ownership problem as user-stated
  rules. Not started; the cap tiers were designed with room for a `kind` discriminator.

## Known limitations

- **Cue-based extraction misses paraphrase.** "It'd be good if we stayed on Node 20" carries no
  cue and is not recorded. The ledger is a floor on retention, not a ceiling — the reducer's
  own `constraints` array still exists and still runs.
- **Contradiction is not detected.** Only restatement is. Conflicting rules both persist and
  are resolved by the stated ordering rule at read time.
- **A dropped entry is gone from the checkpoint.** `droppedCount` discloses it and the exact
  turn remains retrievable with `SessionHistorySearch` / `SessionHistoryRead`, but the ledger
  itself does not restore it.
- **English cues only.** A non-English constraint is not extracted.
