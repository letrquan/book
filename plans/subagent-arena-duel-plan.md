# Plan: Next-Gen TUI Experience Suite (`/duel`, `/roast`, `/blast`)

- **Date:** 2026-08-26
- **Status:** Proposed
- **Scope:** Interactive developer experience suite containing three standout slash commands:
  1. ⚔️ **`/duel` (Subagent Arena)**: Head-to-head dual-worktree agent showdown with automated referee scoring.
  2. 🎸 **`/roast` (Arcade Code Roaster & Ranker)**: DMC/Arcade-style D→SSS grading, witty critiques, and 1-click SSS combo refactoring.
  3. 💥 **`/blast` (Blast Radius Shockwave)**: Interactive pre-refactor ripple-effect impact radar and containment patch generator.
- **Goal:** Transform Book from a standard vertical chat log into a delightful, high-utility developer cockpit that makes architectural decisions, code reviews, and deep refactors fun, fast, and safe.

---

## 1. Feature 1: Subagent Arena (`/duel`)

### 1.1 Product Summary & Value Proposition
When developers face architectural ambiguity (e.g. *Fastify vs Express*, *Regex vs AST Parser*, *Zustand vs Redux*, *Middleware vs Interceptors*), current AI agents make a single arbitrary choice in the working directory.

`/duel` spawns two isolated subagents in parallel Git worktrees representing opposing engineering philosophies (e.g. *Red: Performance & Zero-Dependencies* vs *Blue: Strict Type-Safety & Extensibility*). An automated referee scores both solutions across test pass rates, execution speed, bundle/diff size, dependency footprint, and type safety, rendering a side-by-side combat HUD where the user merges the winner with key `[1]` or `[2]`.

### 1.2 Live Arena View Mockup (`src/tui/components/DuelArena.tsx`)

```text
╭── ⚔️  THE SUBAGENT ARENA  ─────────────────────────────────── [Match #042] ─╮
│  GOAL: "Refactor auth middleware to support async token rotation"             │
├─────────────────────────────────────┬────────────────────────────────────────┤
│ 🔴 RED CONTENDER: "Lightweight Hook" │ 🔵 BLUE CONTENDER: "State Machine"     │
│ ─────────────────────────────────── │ ────────────────────────────────────── │
│ 🥊 Philosophy: Zero-Dependency       │ 🛡️ Philosophy: Type-Safe State Machine  │
│ 📁 Worktree: wt-duel-042-red        │ 📁 Worktree: wt-duel-042-blue          │
│                                     │                                        │
│ 📊 COMBAT STATS:                    │ 📊 COMBAT STATS:                       │
│  • Tests:     ●●●●●●●● 8/8 PASS     │  • Tests:     ●●●●●●●○ 7/8 PASS        │
│  • Code Delta: +32 / -15 lines      │  • Code Delta: +118 / -20 lines        │
│  • Deps Added: 0 new pkgs           │  • Deps Added: 1 pkg (xstate)          │
│  • Benchmark:  ⚡ 0.8ms / req        │  • Benchmark:  🐢 3.4ms / req          │
│  • Type Safety: Strict (0 errors)   │  • Type Safety: Strict (0 errors)      │
│                                     │                                        │
│ 📝 DIFF PREVIEW:                    │ 📝 DIFF PREVIEW:                       │
│  src/auth/jwt.ts                    │  src/auth/machine.ts                   │
│  ┌────────────────────────────────┐ │  ┌───────────────────────────────────┐ │
│  │+ export function withRotation()│ │  │+ export const authMachine = create│ │
│  │+   return async (req, res) => {│ │  │+   initial: 'idle', states: {...} │ │
│  └────────────────────────────────┘ │  └───────────────────────────────────┘ │
├─────────────────────────────────────┴────────────────────────────────────────┤
│ 👑 REFEREE VERDICT: RED WINS (100% tests pass, 4x faster, 0 extra deps)       │
│                                                                              │
│   [1] 🏆 Apply Red (Merge)    [2] 🛡️ Apply Blue (Merge)                       │
│   [Tab] Toggle Diff View      [D] Detailed Breakdown     [Esc] Discard Match │
╰──────────────────────────────────────────────────────────────────────────────╯
```

---

## 2. Feature 2: Arcade Code Roaster & Ranker (`/roast` / `/rank`)

### 2.1 Product Summary & Value Proposition
Standard code analysis tools produce dry, ignored lint reports. `/roast` evaluates the active branch, staged diff, or target file with an arcade-style grading system (**D → C → B → A → S → SS → SSS**) reminiscent of classic combat games (e.g. Devil May Cry).

It pairs sharp, humorous developer critique with rigorous structural analysis (God functions, cyclomatic complexity, missing test coverage, any-casting) and calculates a real-time **Style Point Score**. Pressing `[Enter]` unleashes an automated **SSS-Rank Combo Refactor** to boost the code to perfection.

### 2.2 Roaster Scorecard Mockup (`src/tui/components/RoastScorecard.tsx`)

```text
╭── ⚡ CODE STYLIST & ROAST SCORECARD ──────────────────────── [Branch: feat/auth] ─╮
│                                                                                   │
│   CURRENT RANK:                                                                   │
│    ██████╗     RANK: [B] "Badass, but messy"                                      │
│    ██╔══██╗    Style Points: 1,420 / 3,000 XP                                     │
│    ██████╔╝    Critique: "Your JWT handler is 400 lines long. Even God would get  │
│    ██╔══██╗              lost reading this switch-case."                          │
│    ██████╔╝                                                                       │
│                                                                                   │
│ 📊 COMBO BREAKDOWN:                                                               │
│   ✔ Clean ESM Imports & Zero Cycles   +300 XP (Sweet!)                            │
│   ✔ Strict TypeScript (Zero `any`)    +500 XP (Great!)                            │
│   ❌ 450-line God Function            -400 XP (Combo Broken! 💔)                  │
│   ❌ Zero Unit Tests for Edge Cases   -600 XP (Dismal...)                        │
│                                                                                   │
│ 🚀 ROAD TO [SSS] (SMOKIN' SEXY STYLE):                                            │
│   [1] Extract helper classes & decompose God Function (+800 XP)                   │
│   [2] Auto-generate 8 edge-case unit tests (+1,000 XP)                            │
│                                                                                   │
│   [Enter] Auto-Combo to [SSS RANK] (Apply Clean Refactor)    [Esc] Dismiss        │
╰───────────────────────────────────────────────────────────────────────────────────╯
```

---

## 3. Feature 3: Blast Radius Shockwave (`/blast`)

### 3.1 Product Summary & Value Proposition
Changing shared types, schema definitions, or core utilities often creates hidden regressions across unrelated modules. 

`/blast <path-or-symbol>` acts as a pre-refactor seismic radar. It simulates changing the target, traverses the project import/type dependency graph, detects breaking type signatures and failing test suites, and models a **Blast Radius Shockwave** categorized from **Category 1 (Subtle)** to **Category 5 (Cataclysmic)**. Furthermore, it prepares an atomic **Containment Protocol Migration Patch** that adapts downstream call sites automatically.

### 3.2 Blast Radius View Mockup (`src/tui/components/BlastRadar.tsx`)

```text
╭── 💥 BLAST RADIUS IMPACT RADAR ────────────────────── [Target: src/types/user.ts] ─╮
│                                                                                   │
│  🎯 EPICENTER: `User.id: string -> UUID` (Breaking Type Change)                   │
│  💥 SHOCKWAVE LEVEL: Category 4 (Medium-High Impact)                              │
│                                                                                   │
│  🌊 RIPPLE IMPACT GRAPH:                                                          │
│  [src/types/user.ts]                                                              │
│    ├── 🔴 (CRITICAL) src/auth/session.ts       (3 type errors, 1 test fails)      │
│    ├── 🔴 (CRITICAL) src/db/queries/users.ts   (SQL query parameter mismatch)     │
│    ├── 🟡 (WARNING)  src/api/routes/user.ts    (OpenAPI schema out of date)       │
│    └── 🟢 (SAFE)     src/frontend/types.ts     (Compatible alias)                 │
│                                                                                   │
│  🛡️ CONTAINMENT PROTOCOL:                                                         │
│   Book can automatically create a 4-file atomic migration patch to absorb the     │
│   shockwave with 0 broken builds.                                                 │
│                                                                                   │
│   [Tab] Cycle Affected Files    [P] Preview Shockwave Patch    [Enter] Execute    │
╰───────────────────────────────────────────────────────────────────────────────────╯
```

---

## 4. System Architecture & Module Organization

```text
src/
├── duel/                             # Subagent Arena subsystem
│   ├── types.ts                      # Match, ContenderStats, Verdict domain models
│   ├── orchestrator.ts               # Dual-worktree coordinator & agent spawner
│   ├── referee.ts                    # Test runner, typecheck, diff & metric scorer
│   └── patch-merge.ts                # Worktree-to-workspace patch application
├── roast/                            # Code Roaster & Ranker subsystem
│   ├── types.ts                      # Rank tiers (D..SSS), StyleRules, Scorecard
│   ├── analyzer.ts                   # AST metrics, complexity, test coverage checks
│   ├── generator.ts                  # Witty roast commentary & combo breakdown
│   └── sss-refactor.ts               # Multi-step automated polish workflow
├── blast/                            # Blast Radius subsystem
│   ├── types.ts                      # BlastCategory (1..5), ShockwaveGraph, Node
│   ├── graph-tracer.ts               # Project-wide dependency & import graph walk
│   ├── impact-simulator.ts           # Speculative typecheck & test failure detector
│   └── containment-patch.ts          # Downstream adaptation patch builder
└── tui/components/
    ├── DuelArena.tsx                 # Split-screen combat arena view
    ├── RoastScorecard.tsx            # Arcade ranking scorecard with XP meters
    └── BlastRadar.tsx                # Seismic ripple tree & containment action view
```

---

## 5. Phased Implementation Roadmap

### Phase 1: Subagent Arena (`/duel`)
1. **Contracts & Models** (`src/duel/types.ts`): Define `DuelMatch`, `ContenderReport`, `ContenderStats`, `DuelVerdict`.
2. **Worktree Orchestrator** (`src/duel/orchestrator.ts`): Use `GitWorktreeManager` to spawn parallel red/blue worktrees.
3. **Referee Engine** (`src/duel/referee.ts`): Execute project test suite and typechecks in each worktree; compute metric deltas.
4. **TUI Component** (`src/tui/components/DuelArena.tsx`): Ink split-deck with keyboard controls (`[1]`, `[2]`, `[Tab]`, `[Esc]`).
5. **Command Wiring**: Register `/duel` in `src/commands/builtins.ts`.

### Phase 2: Arcade Code Roaster (`/roast`)
1. **Rank & Rule Engine** (`src/roast/types.ts`, `analyzer.ts`): Compute cyclomatic complexity, function lengths, test ratios, and assign ranks `D` through `SSS`.
2. **Commentary Generator** (`src/roast/generator.ts`): Produce high-energy, humorous critiques based on detected smells.
3. **SSS Refactoring Pipeline** (`src/roast/sss-refactor.ts`): Delegate cleanups and test generation to a patcher agent.
4. **TUI Component** (`src/tui/components/RoastScorecard.tsx`): Render ASCII rank badges, combo lists, and the `[Enter]` SSS action.
5. **Command Wiring**: Register `/roast` in `src/commands/builtins.ts`.

### Phase 3: Blast Radius Shockwave (`/blast`)
1. **Dependency Tracer** (`src/blast/graph-tracer.ts`): Walk TypeScript / ESM import graphs to map downstream consumers.
2. **Impact Simulator** (`src/blast/impact-simulator.ts`): Speculatively check affected files and categorize severity level (Cat 1–5).
3. **Containment Protocol** (`src/blast/containment-patch.ts`): Formulate unified migration diffs for call-sites.
4. **TUI Component** (`src/tui/components/BlastRadar.tsx`): Render the impact tree with colored severity pips and action prompts.
5. **Command Wiring**: Register `/blast` in `src/commands/builtins.ts`.

---

## 6. Verification & Quality Standards

- **Architecture Checks**: Ensure zero circular dependencies, leaf imports for `src/tui/`, and strict adherence to `scripts/check-architecture.ts`.
- **Quality Gates**: Pass `npm run check` (ESLint `--max-warnings 0`, Prettier, TypeScript strict checks, unit and contract tests).
- **Graceful Non-TUI Fallbacks**: Provide clean Markdown table outputs for `/duel`, `/roast`, and `/blast` when run in headless or print modes.
