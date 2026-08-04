# Book Milestones

Status date: 2026-08-04. This roadmap records shipped foundations and remaining work. For exact
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
- [x] Background job manager with `/jobs`, session and explicit persistent shell lifetimes,
  restart reattachment, bounded logs/output, notifications, stop/dismiss, and SDK/stream events.
- [x] First-class interoperable skill system with multi-root discovery, metadata-first prompting,
  explicit/manual/automatic activation policies, consent, safe resources, reload/watch behavior,
  TUI management, diagnostics, and evaluation tooling.
- [x] Architecture and release gates: strict TypeScript, no import cycles, TUI leaf enforcement,
  no synchronous production child-process APIs, unit/contract/integration tiers, coverage/UI
  budgets, package smoke, audits, and main-branch stabilization checks.

## Current Priorities

### 1. Trust Boundary and Sandbox Hardening

- [ ] Add a user-owned workspace trust database and a first-open review flow.
- [ ] Disable or separately approve project hooks, MCP commands, provider credentials/endpoints,
  executable custom-command substitutions, and privileged agent definitions in untrusted projects.
- [ ] Rebuild shell sandbox execution around structured argv instead of a wrapped command string.
- [ ] Enforce declared filesystem/network sandbox policies and define fail-closed behavior on
  unsupported platforms.
- [ ] Bind provider credentials to approved origins and restrict lower-trust secret resolution.

See [plans/security-assessment.md](plans/security-assessment.md) for the current risk register.

### 2. Release Readiness

- [ ] Decide the distribution identity: keep GitHub/source-only distribution or choose an
  available scoped npm package name and remove `private: true` intentionally.
- [ ] Complete the renderer real-PTY matrix and interactive soak on Windows and Unix terminals.
- [ ] Maintain three eligible green main-branch CI runs with no open lifecycle/accounting
  regression issues before advancing runtime-attribution work.
- [ ] Cut the next version only after `npm run release:check`, full Node 20/24 validation, package
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
- [ ] Phases 1-3B: add an inert harness boundary, evidence ledger, fixed workflows, explicit
  capability manifests, and reliable deterministic routing.
- [ ] Phases 4-8: selector, externally grounded outcomes, shadow evaluation, scoped canaries, and
  bounded workflow evolution. None of these phases currently controls live runtime behavior.
- [ ] Phase 9 remains a future research gate for cross-context transfer.

The authoritative phase ledger is
[plans/adaptive-harness-implementation-plan.md](plans/adaptive-harness-implementation-plan.md).

## Documentation Rule

When a product surface changes, update the implementation, focused tests, `CHANGELOG.md`, the
relevant README section, and [docs/current-state.md](docs/current-state.md) in the same change. Plans
must identify whether they are proposed, partially implemented, complete, or historical.
