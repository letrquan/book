# M6 — Slash Commands & Skills

**Date:** 2026-06-26
**Status:** In Progress
**Depends on:** M1 ✅, M2 ✅, M3 ✅, M4 ✅, M5 ✅

## Scope

Implement Claude Code's slash command and skill system — Markdown files with optional
YAML frontmatter discovered by convention from conventional directories. Skills are
markdown files the model reads each turn and can auto-invoke based on their declared
purpose.

## Design decisions

### 1. Discovery paths

| Scope | Slash commands | Skills |
|-------|---------------|--------|
| User  | `~/.book/commands/` | `~/.book/skills/` |
| Project | `.book/commands/` | `.book/skills/` |

Discovered by convention (no registry needed). Command files = any `.md` file in the
commands directory. Skill files = any `SKILL.md` in the skills directory.

### 2. Command format

File name = command name. E.g. `.book/commands/deploy-staging.md` = `/deploy-staging`.

**File body** = system prompt injected when user types the slash command. Optional
YAML frontmatter:

```markdown
---
description: "Deploy to staging"
tools: ["Bash", "Read"]
model: "sonnet"
---

Run the staging deployment pipeline:
1. `git checkout staging`
2. `git pull origin main`
3. `npm run build`
4. `npm run deploy:staging`
```

### 3. Skill format

A `SKILL.md` in `.book/skills/<name>/SKILL.md` (or `<name>.skill.md` as flat variant).

```markdown
---
name: "Review PR"
description: "Reviews pull request diffs and suggests improvements"
when_to_use: "When the user asks for a code review or PR review"
tools: ["Read", "Grep", "Bash(git *)"]
model: "sonnet"
---

You are a code reviewer. Follow these steps:
1. Read the diff via `git diff`
2. Identify potential issues
3. Suggest improvements
```

### 4. Skill listing injection

Each turn, the system prompt includes a compact listing of available skills.
The listing is capped at `skillListingBudgetFraction` (default 1% of context).
When the listing exceeds the budget, least-used skill descriptions are collapsed
to bare names so the model can still invoke them.

### 5. Slash command resolution

In the TUI (interactive mode), when user types `/<command-name>`, resolve from
project then user commands directories. The command's body (or frontmatter-body)
replaces the user prompt in the agent loop.

### 6. Skill invocation

Skills are not invoked by user-facing `/` commands. Instead, the model sees the
skill listing in its system prompt and uses `TodoWrite` or a dedicated `InvokeSkill`
tool when it matches the user's task.

## Phases & Tasks

### Phase 1 — Command loader & resolver (3 tasks)

- [ ] T6.1 Implement `loadCommands(workspace)` — scan `~/.book/commands/` and
      `.book/commands/` for `.md` files, parse YAML frontmatter (if any), return
      `Map<name, {body, frontmatter}>`
- [ ] T6.2 Implement slash command resolution in TUI — detect `/name` at input,
      replace prompt with command body. Handle unknown commands gracefully.
- [ ] T6.3 Write tests — command loading, frontmatter parsing, directory merging,
      unknown command error

### Phase 2 — Skill loader & listing (3 tasks)

- [ ] T6.4 Implement `loadSkills(workspace)` — scan `.book/skills/<name>/SKILL.md`
      and `~/.book/skills/` for skill definitions, parse YAML frontmatter
- [ ] T6.5 Generate skill listing text — compact listing for system prompt injection,
      respecting `skillListingBudgetFraction` and `maxSkillDescriptionChars`
- [ ] T6.6 Write tests — skill loading, frontmatter parsing, listing generation,
      budget truncation

### Phase 3 — System prompt injection (2 tasks)

- [ ] T6.7 Inject skill listing into the system prompt in `buildMessages()`
- [ ] T6.8 Add `InvokeSkill` tool — takes a skill name and arguments, loads the
      skill's prompt and runs it as a one-shot instruction

### Phase 4 — TUI integration & e2e (2 tasks)

- [ ] T6.9 Wire `/commands` into the input handler with auto-complete hints
- [ ] T6.10 End-to-end verification — create a skill, verify the model invokes it
      against a real provider; create a command, verify `/cmd` resolves

## Out of scope (deferred)

- `skillOverrides` per-skill visibility → M8
- `disableBundledSkills` → deferred
- Plugin-distributed skills → M8
- Skill auto-complete in input bar → M9 UX Polish
- `skillListingBudgetFraction` as a configurable setting → already exists in schema
