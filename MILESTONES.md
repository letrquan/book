# Book Milestones

Status date: 2026-08-19. This roadmap records shipped foundations and remaining work. For exact
runtime defaults and known boundaries, see [docs/current-state.md](docs/current-state.md).

## Shipped Foundation

- [x] Anthropic Messages and OpenAI-compatible provider ports with streaming, retries, usage,
  model discovery, prompt caching, configurable effort, and BYOK provider management.
- [x] Interactive TUI, print/headless hosts, JSON/stream-JSON protocols, public `query()` SDK,
  shared session lifecycle, resume/fork/name support, compaction, rewind, and structured output.
- [x] Layered settings, atomic settings repository, migration/redaction, permission modes and rules,
  lifecycle hooks, optional bubblewrap sandbox, project/user instructions, themes, and auto-memory.
- [x] Provider-neutral tool registry with closed schemas, aliases, capability intersections,
  model-conditional mutation guidance, read-before-edit, tool discovery, bounded parallel-safe
  waves, retries/timeouts, structured errors, and persistent tool telemetry.
- [x] File, patch, shell, Git, web, notebook, todo, planning task, plan-mode, clarification,
  session-history, skill, MCP, and managed-agent tool families.
- [x] Managed explorer/patcher/validator agents with strict tool capabilities, concurrency limits,
  non-Git read-only exploration, Git worktrees for mutation/validation, evidence gates, completion
  delivery, resumable transcripts, ownership, retention, and recovery.
- [x] Host-orchestrated `/review` pipeline: immutable review target resolved by the host, read-only
  `reviewer` agents, parallel specialized lenses, independent falsification pass, explicit coverage
  that fails closed, `REVIEW.md` calibration, evidence-gated `--fix`, and a precision/recall
  evaluation harness.
- [x] Background job manager with `/jobs`, session and explicit persistent shell lifetimes,
  restart reattachment, bounded logs/output, notifications, stop/dismiss, and SDK/stream events.
- [x] First-class interoperable skill system with multi-root discovery, metadata-first prompting,
  explicit/manual/automatic activation policies, consent, safe resources, reload/watch behavior,
  TUI management, diagnostics, and evaluation tooling.
- [x] Architecture and release gates: strict TypeScript, no import cycles, TUI leaf enforcement,
  no synchronous production child-process APIs, unit/contract/integration tiers, coverage/UI
  budgets, package smoke, audits, and main-branch stabilization checks.

## Current Priorities

### 0. Long-Horizon Execution

Shipped on `feat/long-term-sessions`; see `docs/current-state.md` for the surface.

- [x] Continuation past a premature stop, with a no-progress brake that cannot be forged by refused
      tool calls and a separate brake for a run whose every call is refused.
- [x] A USD ceiling that bounds the objective: inclusive of delegated spend, carried across prompts
      and restarts, durable for managed agents and subagents, fail-closed when unevaluable, O(1).
- [x] Stream re-issue that survives a dropped connection, and never re-sends assistant prefill.
- [x] A liveness file and a crash record, so a run in flight is legible from outside.
- [x] Plan persistence across restarts, and an honest "the plan did not survive" signal.
- [x] Compaction fidelity: the Carried Ledger's Phase 0.8 baseline, recorded after Phase 0 landed,
      and Phase 2 -- the host-owned constraint ledger itself, with its cap and supersession rule.
      `verbatimUserRetention` went from 0.0 to 1.0 and overall retention from 0.333 to 0.667. The
      design is `plans/carried-ledger-plan.md`. Phase 1 (budget rework) landed 2026-09-05 and was
      revised 2026-09-06 after review: the retained tail is the residual of a target set at half
      the preflight gate (~79k tokens at 272k instead of a flat 20k), the loop and the compactor
      share one budget resolver, and the overflow recovery keeps the short tail; measured on a
      272k fidelity arm. Phase 3 remains proposed.
- [ ] A control surface for a run in flight - at hour 30 the only interventions are `kill` and wait.
- [x] Monotonic clock for every duration decided **inside one process** — the provider retry
      budget and model-discovery budget, the harness flush deadline and sync cadence, the
      background-shell start/stop budgets, the process-group kill bound, and the run's own elapsed
      time as the model is told it. `src/clock.ts`; injected, never a module global.
- [ ] Cross-process liveness/TTL is **still on the wall clock, and monotonic time cannot fix it** —
      two processes share no monotonic origin, so a reading cannot be persisted or compared across
      that boundary. Affects the background-shell heartbeat, the run-status file `book status`
      reads, and the two retention sweeps. Today the heartbeat is saved by its `isProcessAlive`
      disjunct and the status warning is worded as a maybe; making them actually correct needs a
      **sequence counter in the file**, not a better clock. Each site says so at the call.

### 1. Trust Boundary and Sandbox Hardening

- [ ] Add a user-owned workspace trust database and a first-open review flow.
- [ ] Disable or separately approve project hooks, provider credentials/endpoints, executable
  custom-command substitutions, and privileged agent definitions in untrusted projects. Project
  MCP servers, project-declared `permissions.allow` rules, project hook entries, and project
  slash commands that substitute shell now each have per-item fingerprinted approval; provider
  blocks and agent definitions do not. All four record their decisions in `~/.book/trust.json`,
  keyed by workspace path and read from outside the working tree, so nothing a repository ships
  can approve itself; `book trust hook|rule|command` records the decision, `book config set`
  refuses those four paths outright, and `book doctor` prints what is withheld. What remains here
  is provider blocks and agent definitions, and an interactive surface for any of it: the MCP gate
  is the only one with a TUI prompt, so in the primary mode a withheld declaration is silent until
  `book doctor` is run. The `auth` block joined the stripped set when subscription auth shipped,
  as a subtree delete rather than an enumeration of leaves.
- [x] Rebuild shell sandbox execution around structured argv instead of a wrapped command string.
- [x] Enforce declared filesystem sandbox policy, and fail closed on network domain rules that
  bubblewrap cannot express.
- [ ] Add a macOS (`sandbox-exec`) and Windows sandbox backend, and define fail-closed behavior on
  platforms that still have none.
- [ ] Require independent approval for the `excludedCommands` escape path instead of letting a
  matching command silently skip the sandbox. `sandbox.allowUnsandboxedCommands` is now enforced
  rather than dead, so an operator can refuse every unsandboxed command outright and `book doctor`
  reports the effective policy — but at its `true` default a model-chosen command that happens to
  match an operator's exclusion pattern still runs on the host with no separate approval step.
- [ ] Bind provider credentials to approved origins and restrict lower-trust secret resolution.
  Subscription credentials are bound: `auth/resolve.ts` refuses to present a profile's token to
  any origin but the profile's own, checked where the request header is built rather than at any
  of the several places a base URL can change (`BOOK_BASE_URL`, a repository-shipped legacy
  `.bookrc.json`, a `provider.<id>` entry). The whole `auth` settings block is stripped from both
  workspace layers. What remains here is the same binding for BYOK API keys, which still follow
  whatever base URL the resolved configuration carries.

See [plans/security-assessment.md](plans/security-assessment.md) for the current risk register.

### 2. Release Readiness

- [ ] Decide the distribution identity: keep GitHub/source-only distribution or choose an
  available scoped npm package name and remove `private: true` intentionally.
- [ ] Complete the renderer real-PTY matrix and interactive soak on Windows and Unix terminals.
- [ ] Maintain three eligible green main-branch CI runs with no open lifecycle/accounting
  regression issues before advancing runtime-attribution work.
- [ ] Cut the next version only after `npm run release:check`, full Node 22/24 validation, package
  inspection, changelog promotion, and installed-artifact smoke tests.

### 3. Background Job Follow-up

- [x] Evented shell manager, unified TUI panel, host events, and persistent runner.
- [ ] Link planning tasks to executable jobs without conflating their state machines.
- [ ] Add permission-preserving rerun, task-aware stop behavior, cleanup commands, and richer doctor
  diagnostics for stale/lost persistent jobs.

### 4. Adaptive Harness

- [x] Stabilize terminal framing, root/child/resume accounting, budget enforcement, provider
  identity, versioned pricing, run IDs, and ambient run fingerprints.
- [ ] Finish the remaining evaluator, architecture, workspace-trust, permission-ceiling, and
  isolated-home preconditions.
- [ ] Phase 0: freeze the evaluation contract and deterministic corpus.
- [x] Phase 1: inert harness boundary with `off` as the only live mode and runtime-equivalent
  disabled behavior.
- [x] Phase 2: observe-only append-only run-evidence ledger — sealed per-root hash-chained JSONL
  streams, allowlist redaction, OTel-mapped telemetry, deferred headless root seals, and explicit
  managed-continuation child linkage.
- [x] Phase 3: validated fixed workflow registry — three built-in definitions (`minimal`,
  `safe-edit`, `verify-heavy`) behind recursively strict validation and a hashed registry, manually
  selected through `harness.workflow` or `--harness-workflow`, rendered as bounded guidance in the
  dynamic prompt zone, with kernel clamps and full provenance recorded per run. Selection fails
  closed under `harness.mode = off` and on unknown or path-like IDs; no automatic selection exists.
- [ ] Phases 3A-3B: explicit capability manifests and reliable deterministic routing.
- [ ] Phases 4-8: selector, externally grounded outcomes, shadow evaluation, scoped canaries, and
  bounded workflow evolution. None of these phases currently controls live runtime behavior.
- [ ] Phase 9 remains a future research gate for cross-context transfer.

The authoritative phase ledger is
[plans/adaptive-harness-implementation-plan.md](plans/adaptive-harness-implementation-plan.md).

### 5. Review Pipeline Follow-up

- [ ] Run the evaluation harness end to end: execute the review pipeline over checked-in golden
  diffs instead of scoring reports captured by hand, and gate prompt changes on the result.
- [x] Expose `/review` outside the TUI. The sequencing moved from `src/tui/app.tsx` into
  `src/review/host.ts`, which both hosts call; print/headless and SDK runs execute the full
  read-only pipeline — `--deep`, `--base`, path scopes, `<base>...<head>` — and emit a stable JSON
  report. `--fix` stays interactive-only by design: a non-interactive host cannot approve a
  patcher's tool calls, so it is refused with an explanation rather than patching unattended.
- [ ] Make the confidence threshold and the fixed 10-minute pass timeout configurable per project.

## Documentation Rule

When a product surface changes, update the implementation, focused tests, `CHANGELOG.md`, the
relevant README section, and [docs/current-state.md](docs/current-state.md) in the same change. Plans
must identify whether they are proposed, partially implemented, complete, or historical.
