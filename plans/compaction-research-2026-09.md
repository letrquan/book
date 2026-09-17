# Research: Compaction — what the 2026 literature says Book should do next

- **Date:** 2026-09-14
- **Status:** research note. **P1 landed 2026-09-14** (Carried Turns, `carryUserTurns` in
  `src/agent/compact.ts`); **P2 landed 2026-09-16** (`withholdSuperseded` and the rescission
  rule in `src/agent/carried-ledger.ts` — explicit rescission cues rather than the object-swap
  heuristic sketched below, which cannot tell "npm → pnpm" from "tests" and "lint");
  **P3 landed 2026-09-17** (`fitCheckpoint` lanes by kind and dependency, the `fit` disclosure,
  and the by-kind reducer double with `retentionByKind` in `compact-fidelity.ts` — the
  deterministic post-fit verifier is the `fit` tally, and the ledger half of it is omitted because
  the fit never touches `carried`); **P4 landed 2026-09-17** (`src/agent/compact-audit.ts`: the
  suspect-input scan with the `PreCompact` `suspect_inputs` signal, the inherited-constraint
  audit, the host-owned `audit` field and `[reducer: …]` header line, and the benchmark's
  `--adversarial` arm — the "(a) verifier" landed as the inherited-constraint audit rather than a
  ledger check, since the fit never touches the ledger); **P5 phase 1 landed 2026-09-17**
  (`plans/async-compaction-plan.md`: `applyCompactResult`, `judgeCompaction`, the
  `prepareCompact`/`commitCompact` seam through `AgentSession`, the loop's deferred trigger --
  moved ahead of the tool wave because the usage threshold and the preflight gate nearly
  coincide -- and `--deferred <k>` in the benchmark; repair on reject, managed agents and the
  pre-turn host path are phase 2); P6 is moot after P1.
- **Scope:** `src/agent/compact.ts`, `src/agent/carried-ledger.ts`, `src/agent/compact-fidelity.ts`,
  `scripts/compact-eval.ts`, `src/agent/loop.ts` (compaction call site)
- **Method:** literature retrieval through the OpenResearch CLI (`orx discover` over alphaXiv and
  OpenAlex, window `--published-after 2023-01-01`, default priority; one initial round, one
  follow-up round, one shallow multilingual loop), then `orx paper` on the six most load-bearing
  results. Only the six papers marked **read** below support design claims; the rest are
  discovery-only leads whose findings were _not_ verified beyond their abstracts.
- **Companion:** `plans/carried-ledger-plan.md` (Phases 0–2 landed, Phase 3 proposed). This
  note is the evidence base for deciding what Phase 3 should be.

---

## 1. Where Book stood before P1 (so the papers can be read against it)

_Written 2026-09-14 before Carried Turns landed; rows 2 and 5 of the table are now closed for
any turn the carried-turns budget holds, and open only for the ledger's own extraction._

Book compacts with a reducer model that writes a `ConversationCheckpointV2`
(`summary`/`constraints`/`files`/`episodes`/`openThreads`), which the host re-fits under budget
(`fitCheckpoint` in `compact.ts`). On top of that sits the Carried Ledger
(`carried-ledger.ts`): user constraints extracted deterministically from the user's own turns by
an English cue list (`STRONG_CUES`/`WEAK_CUES`, `carried-ledger.ts:68-113`), stored verbatim,
readable-but-not-writable by the reducer, capped at 32 entries / 1024 tokens, and disclosed in
the checkpoint header with the reading rule "where two conflict the later one wins"
(`carriedLedgerNotice`, `carried-ledger.ts:511`).

Known limitations already written down in the ledger plan:

| #   | gap                                                             | where                                        |
| --- | --------------------------------------------------------------- | -------------------------------------------- |
| 1   | fitter evicts oldest-first; "the oldest thing is the brief"     | `fitCheckpoint` (`shift()` ladder; closed by P3) |
| 2   | cue-based extraction misses paraphrase                          | `carried-ledger.ts:68-113`                   |
| 3   | contradiction not detected, only restatement; both entries stay | `markSupersessions`, `carried-ledger.ts:352` |
| 4   | reducer output is trusted after schema validation only          | `generateCheckpoint`, `compact.ts:1296`      |
| 5   | English cues only — a Vietnamese constraint is never extracted  | `carried-ledger.ts:68`                       |
| 6   | Phase 3 "beyond constraints" undefined                          | `carried-ledger-plan.md` §Phases             |

Two facts about the current implementation that the papers make load-bearing:

- **Compaction is synchronous.** The loop `await`s `callbacks.onCompact` inline
  (`loop.ts:661-680`) and the TUI/print hosts do the same pre-turn. Nothing runs while the reducer
  runs, and nothing checks the reducer's output against what the agent does next.
- **User turns are summarized, not kept.** `selectRecentBundles` (`compact.ts:1046`) keeps a
  recent tail of user-led bundles and hands everything older — including the user's own turns —
  to the reducer. Only the cue-matched sentences survive verbatim, via the ledger. (`book status`
  reports the first user turn byte-exact, but it reads it from the transcript for the operator —
  `cli/status-cmd.ts:187` — the model never sees it again once it is summarized.)

## 2. Papers, ranked by how directly they bear on Book

### Read (support design claims below)

1. **Lost in Compaction: Evaluating Side-Constraint Loss under Context Compaction** (Wang et al., PSU) —
   https://www.alphaxiv.org/abs/2608.11242 · code: github.com/ZhiqiEliWang/compaction-integrity
   Defines _session constraints_ (rules that govern _how_, not _what_), a 5-type taxonomy
   (action / information / process / preference / output), and the COMPINT suite (three 100k-token
   fillers, four injection positions, strict/preferential × direct/contextual framings). Across
   six compactors and 750 instances the mean constraint retention was **17%**; truncation and
   LLMLingua-2 retained **0%**; the Anthropic and pi-mono compaction prompts on `gpt-oss-120b`
   peaked at 36% and fell to 0% on chat-style filler. Retention drops as input length grows
   (≈90% at 10k → far lower at 100k on the same data), is highest for constraints stated
   _closest to the compaction instruction_, and is lowest for _process_ constraints. Their fix is
   an online, training-free extractor: a small model (Qwen3.5-9B) reads **only user turns**, keeps a
   session list of constraints, and the list is appended outside the summary. That reached
   **90–96%** retention on all three fillers and beat GPT-5.4-mini by 52.7 pp on chat filler.
   Cost: 0.03 s per 100k tokens on single-query trajectories, ≤13 s on 257-turn chats.

2. **Governance Decay: How Context Compaction Silently Erases Safety Constraints in Long-Horizon LLM Agents** (Chen, BIT) —
   https://www.alphaxiv.org/abs/2606.22528
   ConstraintRot benchmark, seven models, 1,323 episodes. Policy in full context: **0%**
   violation; after one compaction: **30%** pooled, up to 59%. Constraint survival in the summary
   predicts violation exactly (survived → 0%, dropped → 38%), and the violation rate tracks the
   _summarizer_ model, not the agent model. Tighter summary budgets (300 → 15 words) drop
   survival from 88% to 23%. Decay compounds across rounds (0% → 78% over four) and reproduces
   cross-lingually (+42% in Chinese). Of four compaction strategies only `head_tail` — keep the
   oldest turn — held 0%. New attack class: **compaction-eviction** — content the adversary
   controls (tool output) instructs or pressures the summarizer to omit the rule; a
   "token-budget" framing drove Claude-Sonnet-4.6 from 0% to 65%. Defense: **constraint
   pinning** — extract constraints into a protected buffer and re-inject after compaction —
   restored 0% on all seven models at ~47 tokens. Residual hole: an operator-impersonation
   "policy rescinded" message in the _recent, unsummarized_ tail bypasses naive pinning
   (0% → 17%; 10% after hardening).

3. **The Compaction Cliff in Long-Running AI Agent Memory** (Zerhoudi, Mitrović, Granitzer, Passau) —
   https://www.alphaxiv.org/abs/2608.22752
   Typed knowledge model — Constraint / Procedural / Belief / Preference / Episodic — with a
   fidelity lane per type. Type-blind compactors (including Claude Code's `/compact` prompt on
   Sonnet 4.6) recall **53%** of safety rules after one 50% round and **10%** after five;
   TypeCompact holds 1.00 / 0.95 / 0.80 at 50% / 25% / 10% compression and **0.96 over five
   rounds**. Three components proved load-bearing in ablation: labels assigned at indexing time,
   a deterministic post-compaction verifier that checks each constraint's canonical form is still
   present and restores it if not, and an explicit `Unsafe` escalation when the budget cannot hold
   every constraint. Classifier finding that matters for Book: regex/encoder-only recall was
   **0.27–0.77**, and grammatical classifiers fell to 0.62 on _declaratively_ phrased rules
   ("the vendored parser is frozen"), which are 50–61% of real safety text; a counterfactual
   "SafetyMargin" prompt ("would removing this increase the chance of an unsafe action?") lifted
   declarative recall to 0.90. A cascade regex → encoder → LLM → abstain-as-hard is offered as
   the cost-bounded version.

4. **Slipstream: Trajectory-Grounded Compaction Validation for Long-Horizon Agents** (Chen, Pan, Dai, Netravali, Princeton) —
   https://www.alphaxiv.org/abs/2605.08580 · code: github.com/chenzhuofu/slipstream
   Synchronous compaction is **26–44%** of end-to-end latency on SWE-bench / BrowseComp and has no
   validation signal because every post-compaction step is conditioned on the summary. Run the
   compactor _in parallel_ with the agent continuing on the original context; the next-k steps
   (k ≈ 2–4 in practice) become a held-out signal. A judge does a **statement-level** check
   (facts/constraints the next-k steps used are in the summary) and a **plan-level** check (the
   summary supports the same forward intent). Accept → adopt summary + the k steps; reject
   (1–8.5% of compactions) → targeted repair. Omission is ~90% of compaction failures; 88–100% of
   first deviations surface within 3 steps. Result: **+1.3 to +8.8 pp** task accuracy and up to
   39.7% less latency. Async alone gives the latency but not the accuracy; the judge does not need
   to be as strong as the agent (a 2–3B cross-family judge kept most of the gain).

5. **Beyond Compaction: Structured Context Eviction for Long-Horizon Agents** (Semenov, Dorofeev, Kiz8) —
   https://www.alphaxiv.org/abs/2606.11213
   Context Window Lifecycle: the agent annotates episodes (`expl` / `act` with declared
   dependencies); eviction is deterministic, LLM-free and graduated (strip reasoning → strip bulk
   outputs → strip small tool interactions → remove episode), evicts by _dependency_ not age, and
   **never evicts user turns** (Principle 3) or the prologue. 89 Terminal-Bench tasks in one
   80M-token session at an 80k budget with no accuracy loss vs. isolated sessions, and 20–70%
   lower inference cost from a stable prefix. Budget sensitivity: >120k tokens raised cost with no
   accuracy gain; ~50k cut cost up to 3× but doubled wall-clock through re-exploration; 80–120k is
   the Pareto band. Case study: summarization after task 1 discarded structural detail task 2
   needed; eviction kept it.

6. **Revoked but Still Authoritative: An Empirical Study of Revocation Enforcement in Agent-Memory Systems** (Shen, Toyoda, Leung, Vulcan Research) —
   https://www.alphaxiv.org/abs/2609.08258
   When a superseded rule and its replacement are both presented with equal standing, nine models
   took the unsafe (revoked) action in **43.1%** of trials, and the revoked rule out-ranked its
   replacement because absolute phrasing retrieves better. "Disregard superseded facts" prompt
   hardening only moved that to 37.2%; **withholding** the revoked record moved it to 0%. Models
   cannot tell current from revoked on standing alone. Agent write-back of its own decision as a
   new fact re-poisons a filtered store (71–83% unsafe on later reads).

### Discovery-only leads (abstract-level; not verified)

- **Context Compaction Theory** — https://www.alphaxiv.org/abs/2608.01326 — proves generation
  (summarize) can need strictly less budget than selection (keep-a-subset) and gives a way to
  score a deployed compactor against the optimum on a query set. Relevant to the retain-vs-summarize
  question in P1.
- **Retain or Consolidate? Budget-Dependent Operator Selection** — https://www.alphaxiv.org/abs/2607.17545 —
  consolidation wins under tight budgets (+48% on LongMemEval), retention under loose ones.
  Supports keeping raw user turns while the budget allows and only summarizing them under pressure.
- **What Should an Agent Forget? Separating What Is Stored from What Is Used** — https://www.alphaxiv.org/abs/2609.10263 —
  same-slot replacement links suppress superseded values for current-state answers while keeping
  them for historical queries. The shape Book's supersession should take (P2).
- **Dead text or binding clause?** — https://www.alphaxiv.org/abs/2608.12599 — revocation inertia
  ("behavioral relapse"): models keep enacting withdrawn constraints; a contract ledger with
  tombstones compiled ahead of time reduces it; a one-sentence tombstone note alone recovers about
  a third of the effect.
- **Residual Drift Dominates Contradiction** — https://www.alphaxiv.org/abs/2605.23940 — after
  repair, residual multi-turn failures are 98–100% _satisfiable drift_ (state consistent, answer
  silently violates it), not contradiction. Argues for validating the _answer_ against the ledger,
  not just keeping the ledger.
- **LLMs Get Lost in Evolving User Intent** — https://www.alphaxiv.org/abs/2607.20734 — strong
  static performance does not transfer when intent is revealed/revised across turns. Motivates
  carrying user-stated current values and open threads (Phase 3 scope).
- **Addressable Recall Compaction (ARC)** — https://www.alphaxiv.org/abs/2607.25066 — replace old
  tool observations with ID-addressable citations the agent can dereference; 99.4% NIAH vs 88.1%.
  Book already does this (`SessionHistorySearch`/`SessionHistoryRead`, source refs); the paper is
  external validation, not a proposal.
- **CompactionRL** — https://www.alphaxiv.org/abs/2607.05378 — the highest-voted paper in the
  keyword round (165 votes): trains the agent with compaction in the RL loop. Training-based, out
  of scope for a provider-agnostic harness; noted so it is not mistaken for an omission.
- **SWE-MeM** — https://www.alphaxiv.org/abs/2606.28434 — trained coding agents that decide when /
  what / how to compress. Training-based; out of scope for a provider-agnostic harness, noted for
  the eval design (they measure resolve rate _and_ token use jointly).

### Multilingual facet

The shallow loop on non-English constraint extraction returned nothing on point (personalized
memory and code-switched speech papers only). The only cross-lingual evidence found is
Governance Decay's +42% violation on Chinese, i.e. the problem is at least as bad in other
languages; no paper offers a language-specific extractor. This shapes P1 and P6: the fix for gap #5 is
to stop depending on language at all, not to add Vietnamese cues.

## 3. What this implies for Book — proposals, in priority order

Ordered by (evidence strength × size of the gap it closes) / implementation cost. P1–P3 are
host-only changes with no new model call on the happy path.

### P1. Keep user turns verbatim; summarize only assistant and tool content

**Gaps closed:** #1 (the brief is the oldest thing), #2 and #5 (nothing to extract if nothing is
lost), most of #6.

**Evidence.** CWL's Principle 3 (user content inviolable) held accuracy over 80M tokens
[2606.11213]. Governance Decay found `head_tail` — the only strategy that kept the oldest turn —
was the only one at 0% violation [2606.22528]. Lost in Compaction's extractor works because it
reads _only user turns_ and puts them _outside_ the summary [2608.11242]. Book's own
`verbatimUserRetention` went 0.0 → 1.0 the moment the ledger stopped summarizing cue-matched user
sentences (`carried-ledger-plan.md` §Result); this generalizes that to every user sentence.

**Design.** In `selectRecentBundles` (`compact.ts:1046`), split each summarized bundle: the
user message is retained (clipped at a per-turn cap, e.g. 512 tokens, with the excess going to
the reducer and the clip disclosed), assistant and tool messages go to the reducer as today. The
retained user turns render _before_ the checkpoint in transcript order so the reducer's summary
reads as "what happened between these turns". The ledger stays (it is the cap-proof floor and the
thing that survives when even user turns are clipped), but its extractor becomes a safety net
rather than the only path.

**Budget.** User turns in a coding session are small relative to tool output; measure on the
fidelity corpus and `.book/reports/compact-eval-v2-*` sessions before choosing the per-turn cap.
Under real pressure (the short-tail recovery path), fall back to today's behavior — Retain or
Consolidate [2607.17545] says retention is right under loose budgets and consolidation under
tight ones, so make the switch budget-dependent rather than absolute.

**Measure.** Add a `userTurnRetention` metric to `compact-fidelity.ts` (fraction of planted
user-turn facts, cue-less included, that survive each generation) and plant _paraphrased,
cue-less_ and _Vietnamese_ constraints in the corpus. Expect `finalRetention` to move well above
0.667 / 0.833 with `reducerCalls` unchanged. Record the token cost as a new column in
`FIDELITY_ARMS`.

### P2. Withhold superseded ledger entries instead of "later wins"

**Gap closed:** #3.

**Evidence.** Presenting both the revoked and the current rule with equal standing produced
43.1% unsafe actions; telling the model to disregard superseded facts only reached 37.2%;
withholding reached 0% [2609.08258]. That is exactly Book's current reading rule
(`carriedLedgerNotice`: "where two conflict the later one wins"). Dead-text-or-binding-clause
reports that a one-sentence tombstone recovers about a third of the full effect [2608.12599,
abstract only].

**Design.** `markSupersessions` (`carried-ledger.ts:352`) already computes `supersededBy` for
restatements. Two changes: (a) render superseded entries as a one-line tombstone
(`[superseded by #7]`) rather than in full, or omit them and raise `droppedCount`; (b) widen
detection from restatement to _same-topic object swap_ — the `TOPIC_STOPWORDS` machinery
already strips polarity words, so "always use npm" / "never use npm" already score as one topic
and get the restatement mark; the missing case is high topic overlap with one _different_
remaining token ("use npm" → "use pnpm"), which today is two live entries. Keep it host-only
and conservative; the eval probe `package-manager-correction` in `scripts/compact-eval.ts`
already exists for this and should flip from "both present, model picks" to "only the current one
present".

**Guard against the hole Governance Decay found.** A rescission must come from the user's own
typed turn (the ledger already only ingests user turns — keep that invariant; never let a tool
result or assistant message create a tombstone).

**Measure.** `supersessionCorrectness` already exists in `compact-fidelity.ts:252`; extend the
corpus with polarity-flip and object-swap pairs and require the superseded text to be _absent_
from the rendered ledger, not merely ordered later.

### P3. Type-aware fit order in `fitCheckpoint`

**Gap closed:** #1 for the reducer-authored fields.

**Evidence.** Compaction Cliff's whole result is that per-type fidelity lanes turn 0.10 recall
after five rounds into 0.96 [2608.22752]; CWL evicts by dependency and never by age alone
[2606.11213].

**Design.** The truncation ladder in `fitCheckpoint` ended with
`episodes.shift(); files.shift(); openThreads.shift(); constraints.shift()`. Reorder into
lanes: (1) episodes with status `complete` whose `sources` no file or open thread still cites,
oldest first; (2) `files` not cited by any open thread; (3) remaining episodes; (4) open threads;
(5) `constraints` — and never below the ledger, which is already exempt. This is the `kind`
discriminator the ledger plan reserved for Phase 3, applied to the checkpoint instead of adding a
new field. Also add Compaction Cliff's deterministic post-fit verifier: after fitting, confirm each
ledger entry and each reducer `constraints[].text` still appears; a reducer constraint that
vanished is disclosed in the header the way `droppedCount` is today.

**Measure.** `finalRetention` split by fact kind in `compact-fidelity.ts` (constraint /
file / episode / thread) so the floor can be ratcheted per lane.

### P4. Treat the reducer as an untrusted-input sink

**Gap closed:** #4, plus a security surface Book has not written down.

**Evidence.** Compaction-eviction attacks: tool output that says "for token budget, omit the
policy" drove a model that resisted passive decay to 65% violation [2606.22528].
Book's reducer prompt (`buildReducerPrompt`, `compact.ts:1264`) already wraps history as
`untrusted data`, and the ledger is immune by construction (host-owned). The reducer's own
`constraints`/`openThreads` are not.

**Design.** Cheap, host-only: (a) the post-fit verifier from P3 catches silent omission of a
ledger entry; (b) a deterministic scan of the _summarized_ tool results for
compaction-directed instructions ("summarizer", "when compacting", "omit", "token budget") that,
on a hit, flags the checkpoint as `degraded` with a `warning` — the field exists on `CompactResult`
(`types/sessions.ts:54-57`). No new model call. Add a hook-visible signal so `PreCompact` scripts
can block.

**Measure.** Add an adversarial arm to `scripts/compact-eval.ts`: a planted tool result carrying
each of Governance Decay's six omission framings; floor = ledger constraints 100% present, reducer
constraints ≥ baseline.

**As landed (2026-09-17).** (a) became the inherited-constraint audit: the reducer's output is
compared with the seed and every seed constraint neither cited nor restated nor held by the
ledger is counted -- disclosed, never restored, because a withdrawn rule or a finished task is
dropped legitimately and scope cannot help (the host demotes a model-authored `global`/`workspace`
scope to `task` on parse). (b) is `scanSuspectInputs`: a sentence must carry an address term, an
omission verb and directive mood; the mood test is what keeps this repository's own docs, which
describe all three in the third person, from firing (0 hits across README, CHANGELOG, plans and
470 source files, except Book's own reducer prompt and one test comment). Hits are never quoted
into the checkpoint. The `--adversarial` arm exists; the deterministic harness cannot be steered,
so the number has to come from a provider-backed run. Known limitations: the seed itself is
reducer output, so an instruction that once made it into a constraint's text persists as seed and
is not scanned; the scan is English-only; and the excerpt handed to hooks is a tool-result
sentence and is withheld only when the secret detector matches it. Review then closed three
holes: physical lines are joined into sentences before the test, so a directive hard-wrapped
across two lines is caught and a wrapped comment fragment that opens with a quoted order is not;
`audit.suspectInputs` keeps at most eight references beside a full `suspectInputCount`, so a span
with dozens of steered tool results cannot spend the checkpoint budget on references and evict
real rules through another door; and the inherited-constraint audit normalizes any script, so a
rule in Vietnamese or Japanese is counted rather than skipped.

### P5. Asynchronous compaction with a trajectory-grounded judge

**Gap closed:** #4 (the actual faithfulness check), and the latency Book pays today.

**Evidence.** +1.3 to +8.8 pp accuracy and −39.7% latency; async without the judge gives only the
latency; a small cross-family judge suffices [2605.08580]. Book already has the two ingredients:
`compactModel` routes the reducer to a cheaper model, and `npm run eval:compact` is a _paired_
harness (control on original history vs treatment on compacted history) — which is the same
held-out signal Slipstream uses, run offline.

**Design (larger; propose after P1–P4 land).** In `loop.ts:661`, when `shouldCompact` fires,
start `runCompact` in the background and let the current turn proceed on the full history; on the
next turn boundary, if the candidate checkpoint is ready, run a judge call (the `compactModel`)
with the checkpoint plus the intervening assistant/tool messages: statement-level ("every fact
and constraint these steps relied on is in the checkpoint") and plan-level ("the checkpoint
supports the next action these steps took"). Accept → splice the checkpoint in _behind_ the
intervening steps; reject → targeted repair via the existing `buildRepairPrompt` path with the
judge's diagnosis; fallback → today's synchronous path. Constraints: the OpenAI-compatible router
Book runs on has no shared-prefix trick, so the cost is one extra reducer-sized request in
flight plus a small judge call; the overflow-recovery path (`CompactTail = 'short'`) must stay
synchronous because there is no room to continue.

**Measure.** Turn the paired probes in `scripts/compact-eval.ts` into a _sufficiency_ score:
for each session, does the treatment arm's next-k probe answers match the control arm's? Report
judge accept/reject rate; Slipstream's 1–8.5% reject band is the sanity check that the judge is
neither rubber-stamping nor thrashing.

### P6. Replace the English cue list with a language-agnostic extractor — only if P1 is rejected

**Gaps closed:** #2, #5.

Lost in Compaction's Qwen3.5-9B extractor over user turns reached 90–96% retention
[2608.11242]; Compaction Cliff shows regex tops out at 0.27–0.77 recall and a counterfactual
prompt beats grammatical classification on declarative rules [2608.22752]. Book could run that as a
cascade — today's cues first (free), then one `compactModel` call over _only the user turns being
summarized_ when a turn has no cue hit — giving Vietnamese and paraphrased constraints a path into
the ledger. It costs a model call per compaction and keeps the extraction/ledger split. P1 makes
this mostly moot (the turn itself survives), which is why it is last.

## 4. What the fidelity harness cannot see today

Three blind spots the papers make visible, each a corpus change to `compact-fidelity.ts` before
any of P1–P6 is judged:

- **Cue-less and non-English constraints.** Every planted user constraint in the corpus is
  English and cue-bearing, so `verbatimUserRetention = 1.0` says nothing about gaps #2 and #5.
  Plant "it'd be good if we stayed on Node 20" and "đừng đụng vào thư mục vendor".
- **Process constraints.** Lost in Compaction found them least retained; Book's corpus should
  tag constraint _type_ (action / information / process / preference / output) and report
  retention per type.
- **Sufficiency, not recall.** Slipstream's point is that source-grounded recall correlates
  poorly with what the agent needed next. The paired probes in `scripts/compact-eval.ts` are the
  right instrument; promote the treatment-vs-control agreement to a first-class metric with its
  own floor.

## 5. Things the literature says Book already has right

Worth stating so they are not "improved" away:

- A host-owned, model-unwritable constraint buffer re-injected after compaction is the defense
  two independent papers converged on (constraint pinning [2606.22528], the SC extractor
  [2608.11242]). The Carried Ledger is that.
- Addressable references into the untouched transcript (`SessionHistorySearch`/`Read`, source
  refs) are ARC's mechanism [2607.25066, abstract] and Slipstream's "targeted repair" needs them.
- Compacting at roughly half the window (Phase 1: ~79k target at 272k) sits inside CWL's
  measured 80–120k Pareto band [2606.11213] and on the right side of Lost in Compaction's
  "retention falls with input length" curve [2608.11242].
- The reducer prompt's `untrusted data` framing and the ledger's user-turns-only ingestion are
  the two invariants Governance Decay's attack and Revoked-but-Authoritative's write-back
  poisoning both depend on being absent.

## 6. Retrieval record

Initial round (2026-09-14): alphaXiv embedding ("summarizing long agent conversations to fit the
context window while preserving user constraints and task state"), alphaXiv keyword ("context
compaction LLM agent", acronym recovery "LLM", "memory management long-horizon agents
summarization"), OpenAlex ("context compression long conversation LLM agent memory"). Follow-up
round (gap #3): alphaXiv embedding on contradiction/supersession, keyword "instruction drift
multi-turn constraint tracking", OpenAlex on summary faithfulness. Shallow loop (gap #5):
alphaXiv embedding on multilingual constraint extraction — thin. OpenAlex returned surveys and
LongLLMLingua (token-level prompt compression, a different layer); none were read.
