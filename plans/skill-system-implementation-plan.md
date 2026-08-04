# Book Skill System Implementation Plan

Status: complete as of 2026-08-03. The runtime, management UI, watcher, diagnostics, SDK/headless
surfaces, evaluation harness, documentation, adversarial audit, and full verification matrix are
implemented and verified.

## Completion Evidence

- Discovery and validation are implemented in `src/skills.ts`, with direct coverage for every
  supported root and precedence level, invalid metadata, body/resource bounds, binary content,
  Windows case handling, directory symlinks, resource symlink denial, legacy flat packages, prompt
  budgeting, and exact explicit mentions.
- Session ownership, activation frames, consent, lifetimes, redacted history, safe resources,
  reload, and lifecycle events are implemented in `src/skill-registry.ts` and exercised by registry,
  tool, agent-loop, runtime, report, and headless tests.
- Capability enforcement is an intersection with Book's existing tool surface. Nested restrictions
  restore independently, conflicting skill ceilings fail with `skill_tool_intersection_empty`, and
  provider-error cleanup expires frames and restores the parent surface.
- `/skills`, `/skills status`, `/reload-skills`, filtering, activation/execution cycling, global
  disable, explicit prompt insertion, persistence, diagnostics, watcher errors, and active state are
  implemented and covered by command, persistence, TUI component, and integration tests.
- Watcher changes are debounced and consumed only at a safe run boundary. Create, edit, rename,
  delete, duplicate-consume, global-disable, and session-disposal behavior have regression coverage.
- SDK exports and headless `skill_lifecycle` forwarding are built into declarations. Reports and
  lifecycle events retain descriptors, hashes, sizes, codes, and timings without raw bodies or
  resource contents.
- Evaluation covers direct, indirect, negative, ambiguous, conflicting, disabled, invalid,
  missing-body, and missing-resource categories. The CLI reports privacy-safe precision, recall,
  context cost, latency, consent, completion, correction, and tool-failure metrics.

Verification completed on 2026-08-03:

```text
npm run format:check       passed
npm run lint               passed
npm run typecheck          passed
npm run architecture:check passed
npm run test:unit          163 files; 1,654 passed; 5 skipped
npm run test:contract      4 files; 29 passed
npm run test:integration   7 files; 77 passed; 7 skipped
npm run build              JavaScript and declarations passed
npm run eval:skills -- --help passed
git diff --check           passed
```

Rollout decision: newly discovered skills default to `manual`. Explicit `$skill-name` invocation is
available immediately, while users can opt evaluated skills into `auto` or `name-only`. No
real-model activation-quality report is claimed by this implementation task; a representative
report that passes the bundled thresholds remains the promotion gate before changing the default to
implicit activation.

## Completed Release Checklist

The implementation was qualified in the following order so failures remained attributable and the
rollout decision was evidence-based.

### 1. Reconcile the public contract

- Update `README.md` with `/skills status`, the settings shape, supported roots and precedence,
  migration from `.claude/skills` and `.opencode/skills` to `.agents/skills`, watcher recovery, and
  the `npm run eval:skills` workflow.
- Update `CHANGELOG.md` with inspection/reporting, prompt-catalog omission diagnostics, empty tool
  intersection failures, resource digest checks, and the evaluation gate.
- Verify that documentation describes implicit project activation accurately: project content is
  treated as untrusted and requires consent; explicit `$skill-name` is consent unless execution is
  configured as `ask`, while `off` and `deny` still block activation.

Exit gate: every documented command, setting, root, policy, and failure mode has a matching test or
exported implementation surface.

### 2. Run the adversarial implementation audit

- Trace explicit activation, model activation, consent, reload, cancellation, provider failure, and
  turn/run expiry through `src/agent/loop.ts` and `src/skill-registry.ts`.
- Confirm that tool restrictions only narrow the currently authorized surface, compose by
  intersection, fail with `skill_tool_intersection_empty`, and restore in all disposal paths.
- Confirm that discovery and reports retain metadata and digests only, while skill bodies and
  resources remain lazy and lifecycle history remains bounded and body-free.
- Confirm that resource reads reject traversal, symlinks, binary/oversized content, and content
  substitution after discovery.
- Confirm that settings changes and watcher changes coalesce into one safe-boundary reload and
  invalidate both registry caches and agent context without changing an in-flight request.

Exit gate: focused regression suites cover each security boundary and lifecycle transition, with no
unexplained behavior left to prose assumptions.

### 3. Validate every supported surface

- TUI: `/skills`, filtering, activation/execution cycling, global disable, details, exact prompt
  insertion, manual reload, watcher errors, active state, and last lifecycle outcome.
- Commands: `/skills status` and `/reload-skills` operate on the live session registry.
- Headless: `skill_lifecycle` events are forwarded without raw bodies or resource contents.
- SDK: discovery, listing, registry, activation, inspection, reports, and evaluation APIs build into
  declarations and match runtime behavior.
- Compatibility: old settings default safely and `.book`, `.agents`, `.claude`, and OpenCode roots
  follow the documented deterministic precedence.

Exit gate: each surface has direct tests, and `skills.enabled: false` removes catalog prompt text,
skill tools, active frames, watcher effects, and runtime behavior.

### 4. Execute the verification ladder

Run the narrow checks first, then the complete repository gates:

```powershell
npm run typecheck
npm run test:unit -- src/skill-report.test.ts src/commands/builtins.test.ts src/skill-evaluation.test.ts src/skill-registry.test.ts src/skills.test.ts src/tools/skills-tool.test.ts src/tools/catalog.test.ts src/agent/loop.test.ts src/session/runtime.test.ts src/skill-watcher.test.ts src/tui/components/SkillManager.test.tsx
npm run format:check
npm run lint
npm run architecture:check
npm run test:unit
npm run test:contract
npm run test:integration
npm run build
git diff --check
```

Exit gate: all commands pass from the current worktree without modifying or depending on unrelated
`.book/reports/` artifacts.

### 5. Evaluate and decide rollout defaults

- Run the bundled direct, indirect, negative, ambiguous, conflicting, disabled, invalid,
  missing-body, and missing-resource fixtures against representative supported models.
- Record activation precision/recall, false-activation body cost, prompt/body token cost, latency,
  consent prompts, task completion, corrections, tool failures, and blocking mismatches.
- Keep reports privacy-safe by storing hashes and aggregate measurements instead of prompts, skill
  bodies, or resource contents.
- Enable implicit activation by default only after an agreed precision threshold is met with no
  permission or security regression; otherwise ship explicit/manual activation first.

Exit gate: the rollout default is justified by a reproducible report, not only unit and integration
tests. The global `skills.enabled` switch remains the immediate rollback path.

### 6. Close the plan

- Replace status annotations below with authoritative completion evidence.
- Record the exact verification commands and evaluation report used for release approval.
- Mark this plan complete only when all Definition of Done items and the rollout decision have
  evidence; do not describe real-model activation quality as measured until the model evaluation
  has actually run.

## Objective

Give Book a first-class skill system that can discover interoperable `SKILL.md` packages, expose
compact metadata to the model and user, activate full instructions only when needed, safely load
supporting resources, enforce scoped capability limits, and provide a useful `/skills` management
surface.

The target behavior should feel familiar to Codex, Claude Code, and OpenCode users without copying
their internal architecture. Book remains the authority for workspace trust, permissions, tool
schemas, budgets, and lifecycle enforcement.

## Current Baseline

The working tree contains the completed architecture:

- deterministic user/project discovery across `.book/skills`, `.agents/skills`, `.claude/skills`,
  and OpenCode-compatible roots;
- strict metadata validation, shadow diagnostics, bounded prompt catalogs, and lazy `SKILL.md`
  body/resource loading;
- `InvokeSkill` and `ReadSkillResource` tools backed by a session-owned `SkillRegistry`;
- explicit and model-selected activation, attributed policy frames, consent handling, lifecycle
  expiry, and reversible tool intersections;
- activation settings (`auto`, `name-only`, `manual`, `off`), execution settings (`inherit`, `ask`,
  `deny`), and the global `skills.enabled` switch;
- `/skills` management, `/skills status`, `/reload-skills`, persisted overrides, SDK/headless
  surfaces, debounced safe-boundary watching, diagnostics, and evaluation fixtures.

Focused skill-system suites and every repository gate pass. The initial rollout remains manual by
default; real-model evaluation is required only to promote implicit activation to the default.

## Research Decisions

| Source                | Pattern to adopt in Book                                                                                                                                       | Deliberate Book difference                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Codex                 | Standard `SKILL.md`, metadata-first progressive disclosure, explicit `$skill-name`, implicit matching, repository-to-CWD discovery, automatic change detection | Resolve duplicate names deterministically and show shadowed sources because Book's tool API addresses skills by name |
| Claude Code           | Project/user skills, clear description-driven activation, explicit invocation controls, supporting resources, allowed-tool declarations                        | Keep permissions and tool restrictions in Book's host runtime; skill prose never changes authority                   |
| OpenCode              | Walk from Git root to CWD, support `.agents` and `.claude` compatibility roots, expose a dedicated lazy skill tool, enumerate packaged files with limits       | Retain `.book/skills` as the highest-priority native root and Book-specific settings/diagnostics                     |
| Agent Skills standard | Directory package with `SKILL.md`, `name`, `description`, and optional references/assets/scripts                                                               | Accept compatible metadata but warn on unsupported extensions rather than silently assigning semantics               |
| Agent/tool research   | Progressive disclosure reduces context pressure; interface design materially affects tool selection; activation needs positive and negative evals              | Gate implicit activation and rollout on measured precision, not only parser/unit correctness                         |

Primary evidence is recorded in
`plans/adaptive-harness/agent-capability-research.md` and
`plans/adaptive-harness/phase-3a-agent-capability-substrate.md`. The current Codex manual also
confirms metadata-first loading, explicit and implicit activation, `.agents/skills` discovery, and
automatic skill-change detection.

## Product Contract

### Skill package

The canonical package is:

```text
<root>/<skill-name>/
  SKILL.md
  references/   optional
  assets/       optional
  scripts/      optional; never auto-executed
  agents/       optional compatibility metadata
```

Required frontmatter:

```yaml
---
name: skill-name
description: State when this skill should and should not be used.
---
```

Book extensions may include `when_to_use`, `allowed-tools`, `lifetime`, `compatibility`, `license`,
and string metadata. Unknown fields produce visible warnings. Invalid required fields prevent
activation but keep the descriptor visible in diagnostics.

### Discovery and precedence

Scan roots from lowest to highest precedence:

1. user `.claude/skills`;
2. user `.agents/skills`;
3. user `~/.config/opencode/skills` when compatibility support is enabled;
4. user `.book/skills`;
5. the same roots for each directory from Git root to the current workspace.

Deeper project roots override ancestors, project roots override user roots, and `.book` overrides
compatibility roots at the same scope. Duplicate names are not merged. The effective descriptor
retains all shadowed paths for inspection.

Directory symlinks may be supported only after canonicalizing the target and applying the same size,
resource, trust, and path-escape checks. Resource symlinks remain denied by default.

### Activation modes

| Mode        | Model sees               | Implicit use                   | Explicit `$name` | TUI listing         |
| ----------- | ------------------------ | ------------------------------ | ---------------- | ------------------- |
| `auto`      | name and description     | allowed                        | allowed          | visible             |
| `name-only` | name only                | allowed but intentionally weak | allowed          | visible             |
| `manual`    | nothing in model catalog | denied                         | allowed          | visible             |
| `off`       | nothing                  | denied                         | denied           | visible as disabled |

Execution policy is separate:

- `inherit`: follow workspace trust and normal permission policy;
- `ask`: require user consent before instructions become active or a restricted skill drives tools;
- `deny`: block activation.

Explicit invocation does not bypass `off`, `deny`, workspace trust, sandboxing, network policy, or
normal tool permissions.

### Runtime lifecycle

```text
discover metadata
  -> expose bounded catalog
  -> explicit mention or model InvokeSkill call
  -> validate trust and consent
  -> lazily read SKILL.md body
  -> create attributed active-policy frame
  -> intersect available tools with allowed-tools
  -> load declared resources on demand
  -> expire frame and restore parent tool surface
```

The default lifetime is the current root user run. A `turn` lifetime expires after the next model
step that receives the frame, not immediately after the activation tool result. Every disposal path,
including activation failure, cancellation, reload, and provider error, must restore the prior tool
surface in `finally` cleanup.

Skill instructions are attributed guidance subordinate to Book's kernel, the current user request,
trusted project instructions, permission ceilings, budgets, and fixed tool schemas. A skill cannot
grant a tool, suppress approval, change a sandbox, modify evaluator rules, or redefine system policy.

## Implementation Phases

### Phase 0: Stabilize the current foundation

Goal: return the in-progress slice to a buildable baseline before adding behavior.

- Update skill test fixtures to the metadata-first `Skill` shape and test bodies through
  `loadSkillBody()`.
- Add `pushRestriction()` to all `ToolDiscoveryContext` mocks.
- Make old settings inputs safely default missing `skills.execution` to `{}`.
- Normalize workspace paths before reusing a session registry.
- Review activation expiry and every early-return/error path in `src/agent/loop.ts`.
- Run format, lint, typecheck, focused skill tests, and architecture checks.

Exit gate: `npm run typecheck` passes and the existing non-skill test behavior is unchanged.

### Phase 1: Finalize discovery and validation

Goal: produce a deterministic, bounded, interoperable metadata catalog without reading skill bodies.

- Finalize `SkillDescriptor`, `SkillIssue`, source, root, digest, version, and resource contracts.
- Add `.opencode/skills` compatibility roots or document why they are intentionally excluded.
- Validate name format, directory/name agreement, required description, field lengths, body size,
  resource count/depth/size, binary files, unreadable files, and unknown fields.
- Define legacy flat `*.skill.md` support as a migration-only compatibility path with warnings.
- Canonicalize paths and explicitly test Windows case handling, junctions, symlinks, and escapes.
- Calculate a catalog digest from metadata and source identities without body content.
- Make prompt listing budget proportional to context size, capped at 8,000 characters; shorten
  descriptions before omitting skills and report omissions.

Primary files: `src/skills.ts`, `src/skills.test.ts`, `src/agent/context.ts`.

Exit gate: discovery is deterministic across root order, duplicate names, invalid packages, and
large catalogs; no test observes a retained skill body after discovery.

### Phase 2: Complete registry and activation frames

Goal: make activation a host-managed policy transition rather than ordinary tool output.

- Finish `SkillRegistry` ownership at session scope with catalog, active frames, previous frames,
  lazy bodies, resource reads, and bounded lifecycle history.
- Define stable activation errors such as `skill_not_found`, `skill_invalid`,
  `skill_explicit_only`, `skill_consent_required`, `skill_load_failed`, and `resource_escape`.
- Pre-activate exact `$skill-name` mentions before the first provider request.
- Keep `InvokeSkill` eagerly available whenever at least one usable skill exists so activation does
  not require a `ToolSearch` round trip.
- Inject active bodies into the dynamic-policy section with source, reason, digest, lifetime, and
  authority statement.
- Keep `ReadSkillResource` limited to declared files in active skills and wrap returned content as
  untrusted data.
- Define multiple-active-skill behavior: frames compose in activation order, while tool ceilings
  intersect. An empty intersection fails visibly instead of leaving a misleading active frame.

Primary files: `src/skill-registry.ts`, `src/tools/skills-tool.ts`, `src/agent/loop.ts`,
`src/session/runtime.ts`.

Exit gate: explicit and model activation both affect the next provider request, activation failures
do not mutate policy, and expiry reliably restores the original tool surface.

### Phase 3: Enforce trust, consent, and capability ceilings

Goal: ensure repository-controlled skill content cannot broaden authority.

- Integrate project skill activation with the repository's workspace-trust decision.
- Block implicit project-skill activation in untrusted workspaces; require explicit consent or deny
  according to policy.
- Apply `allowed-tools` as an intersection with the current active surface and permission ceiling.
- Continue applying the normal permission callback to every tool call; approval of a skill is not
  approval of its future tool calls.
- Treat scripts as packaged resources. They run only through existing execution tools and their
  normal approvals; there is no implicit skill-script executor.
- Deny path traversal, external resource symlinks, oversized reads, binary injection, and stale
  resource substitution after discovery.
- Record requested versus effective policy when settings or trust clamp a skill.

Primary files: `src/agent/loop.ts`, `src/tools/catalog.ts`, `src/types/tools.ts`, trust/permission
modules, and their tests.

Exit gate: project skills cannot change permissions, schemas, sandbox/network settings, or access
tools unavailable before activation; all failure and cancellation paths restore parent state.

### Phase 4: Finish settings and `/skills` management UX

Goal: make discovery, policy, and problems understandable without editing JSON manually.

- Extend the current manager with search/filter and columns for activation, execution policy,
  source/root, validity, and active state.
- Show detail for path, description, compatibility, size, resources, validation issues, shadowed
  sources, and last activation outcome without exposing the body by default.
- Use `Space` to cycle activation, a separate key to cycle execution policy, `Enter` to insert
  `$skill-name` into the input, `R` to reload, and `Esc` to close.
- Update empty-state copy to list every supported root, not only `.book/skills`.
- Persist overrides through the existing settings repository with atomic writes and actionable
  errors.
- Ensure headless and SDK users can list, inspect, enable/disable, reload, and explicitly activate
  skills without the TUI.

Primary files: `src/tui/components/SkillManager.tsx`, `src/tui/app.tsx`,
`src/tui/hooks/useAgent.ts`, `src/tui/persist.ts`, command/SDK surfaces.

Exit gate: every state shown in the UI maps to persisted settings and effective runtime behavior;
keyboard tests cover all actions and error states.

### Phase 5: Add safe automatic reload

Goal: detect skill changes without restarting Book or leaving stale agent context.

- Add a debounced watcher for all existing skill roots and their parent directories so newly created
  roots are detected.
- Coalesce editor rename/write bursts and serialize reloads.
- Do not replace active frames mid-provider call. Mark the catalog dirty and apply the reload at the
  next safe run boundary.
- On reload, clear lazy body caches, expire affected frames, update the catalog digest, invalidate
  `AgentContextCache`, and refresh TUI state from the same registry instance.
- Surface watcher failures and retain manual `R` reload as a fallback.
- Shut the watcher down with the session runtime to avoid leaked handles in tests and CLI exit.

Primary files: new `src/skill-watcher.ts`, `src/session/runtime.ts`, `src/agent/context.ts`, TUI
lifecycle files.

Exit gate: create, edit, rename, delete, and settings-change scenarios update the next run exactly
once and do not alter a request already in flight.

### Phase 6: Add diagnostics, telemetry, and evaluation

Goal: measure whether the feature helps rather than merely whether it executes.

- Emit bounded events for discovery, shadowing, activation request/applied/blocked/expired, consent,
  resource read, reload, and watcher failure.
- Store names, source classes, digests, sizes, reason, policy, timing, and error codes; do not store
  raw bodies or resource contents by default.
- Add an inspection command/report for catalog digest, active and previous frames, effective tool
  intersections, validation issues, and omitted prompt entries.
- Build activation fixtures for direct, indirect, negative, ambiguous, conflicting, disabled,
  invalid, missing-body, and missing-resource cases.
- Measure activation precision/recall, false activation cost, prompt tokens, body tokens, activation
  latency, unnecessary permission prompts, task completion quality, and user corrections.
- Compare eager skill-tool exposure against deferred discovery before changing general tool
  discovery defaults.

Primary files: observability/evidence modules, new registry/integration/evaluation tests, and
adaptive-harness reports.

Exit gate: implicit activation is enabled by default only when representative fixtures meet an
agreed precision threshold with no security or permission regression.

### Phase 7: Documentation, migration, and rollout

Goal: ship the feature with a reversible adoption path.

- Document package format, roots, precedence, activation modes, execution policy, explicit use,
  resources, scripts, trust behavior, and troubleshooting in `README.md`.
- Add release notes and a migration example from `.claude/skills` and `.opencode/skills` to the
  portable `.agents/skills` location.
- Keep existing `.book/skills` behavior compatible and migrate settings through schema defaults.
- Roll out in stages: manual explicit invocation, automatic metadata matching, then watcher and
  advanced compatibility roots.
- Provide a single `skills: off` or equivalent emergency switch that returns prompts, tools, and
  runtime behavior to the pre-skill baseline.

Exit gate: documentation matches tested behavior, old settings load cleanly, and disabling skills
removes all skill prompt/tool/runtime effects.

## Test Matrix

Required focused suites:

- `src/skills.test.ts`: roots, precedence, validation, lazy loading, budgets, symlinks, resources;
- `src/skill-registry.test.ts`: activation, consent, lifetime, composition, events, reload;
- `src/tools/skills-tool.test.ts`: structured success/errors and safe resource reads;
- `src/tools/catalog.test.ts`: scoped intersections and restoration after disposal/failure;
- agent-loop tests: `$skill`, implicit activation, ask/deny, dynamic frame timing, cancellation;
- TUI tests: manager rendering, policy cycling, insertion, reload, diagnostics, persistence;
- integration tests: user/project precedence, untrusted workspace, watcher lifecycle, headless/SDK
  parity, and provider request rendering.

Required verification before completion:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm run architecture:check
npm run test:unit
npm run test:contract
npm run test:integration
npm run build
```

## Recommended Change Sequence

Keep changes reviewable in these logical slices:

1. Stabilize types and metadata-first discovery. (completed)
2. Complete registry, activation frames, tools, and scoped restoration. (completed)
3. Add trust/consent enforcement and adversarial tests. (completed)
4. Finish settings, `/skills`, SDK/headless inspection, and persistence. (completed)
5. Add watcher, diagnostics, telemetry, and evaluation fixtures. (completed)
6. Update documentation, changelog, migration notes, and rollout defaults. (completed)

Do not merge a slice while typecheck or its focused regression suite is red. Do not enable implicit
project-skill activation or automatic reload until the corresponding trust and lifecycle tests pass.

## Definition of Done

- Book discovers standard skill packages from documented roots with deterministic precedence.
- Discovery retains only bounded metadata; bodies and resources load lazily.
- Users can inspect, configure, reload, and explicitly invoke skills from the TUI and non-TUI
  surfaces.
- The model can implicitly activate eligible skills from compact metadata.
- Active instructions are attributed, scoped, digestible, and visibly subordinate to host policy.
- Tool restrictions are reversible intersections and never grant permission.
- Untrusted, invalid, disabled, denied, oversized, escaped, or missing skill content fails closed.
- Reload updates the next safe run and invalidates every relevant cache.
- Telemetry and evals can distinguish correct activation from false activation and skill-caused
  permission/tool failures.
- Full verification passes and `skills: off` preserves the pre-feature behavior.
