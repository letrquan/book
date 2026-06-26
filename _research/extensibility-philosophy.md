# Claude Code: Extensibility Philosophy

> Research note — scope: design *intent* behind Claude Code's extensibility surfaces. Sourced from Anthropic's official Claude Code documentation (Overview, CLI reference, Settings reference) and the version-gated feature notes embedded in those references, which function as the public changelog.

## The overarching philosophy: composability over configuration

Claude Code's extensibility is governed by a single stated principle, printed verbatim in the product overview:

> "Claude Code is composable and follows the Unix philosophy. Pipe logs into it, run it in CI, or chain it with other tools." — *Overview*

From that principle three sub-values follow, and every extensibility surface in the product is an instance of them:

1. **Extensibility without clutter.** Customizations are *opt-in* and *lazy*. A fresh checkout loads nothing the user didn't ask for; skills, hooks, agents, and MCP servers are discovered from conventional file locations only when present, and the `--bare` flag explicitly "skip[s] auto-discovery of hooks, skills, plugins, MCP servers, auto memory, and CLAUDE.md so scripted calls start faster" (*CLI reference*). A `--safe-mode` flag goes further, disabling *all* customizations to isolate a broken configuration. The product is engineered so that adding capability never degrades the default experience.
2. **Convention over configuration.** There is no central registry to register an extension. You drop a Markdown file in a conventional directory (`.claude/commands/`, `.claude/skills/`, `.claude/agents/`, `.mcp.json`) and it is discovered by location. Settings live in a layered `settings.json` that Claude Code "watches … and reloads … when they change" live (*Settings reference*).
3. **Compose small pieces.** Anthropic identifies exactly **four customization surfaces** — *skills, agents, hooks, and MCP servers* — and each is small, orthogonal, and combinable. The `strictPluginOnlyCustomization` managed setting (v2.1.82+) can lock them independently, confirming they are treated as peer building blocks rather than one monolithic plugin API (*Settings reference*).

These four surfaces are themselves layered across **four scopes** — *user* (`~/.claude/`), *project* (`.claude/`, checked into git, shared by the team), *local* (`.claude/settings.local.json`, machine-specific, gitignored), and *managed* (admin-deployed policy). The same surface behaves the same way in every scope; only *who* it applies to changes. This is the key design move: **the unit of extensibility is decoupled from the unit of distribution**.

---

## Slash commands → skills: Markdown as the extension format

### What exists and why

Custom commands are Markdown files with optional YAML frontmatter. They live in:

- **User commands:** `~/.claude/commands/` — personal, available across all projects.
- **Project commands:** `.claude/commands/` — checked into the repo, shared with the team.

The Markdown body is the prompt injected when the user types `/<command-name>`; frontmatter keys gate *when* the command runs, *which tools* it may use, and *which model* answers. This is convention-over-configuration in its purest form: the extension *is* a readable file, version-controllable in the same commit as the code it helps work on.

### The evolution into "skills"

This surface has since been generalized into **skills** — richer Markdown files (a `SKILL.md` with frontmatter) discoverable not only by the user typing `/` but *autonomously by the model* when a task matches the skill's declared purpose. The relationship is made explicit in the settings:

- The `--disable-slash-commands` flag "Disable all skills and commands for this session" — a single switch covering both, because they are one surface (*CLI reference*).
- The `disableBundledSkills` setting "disables the skills and workflows that ship with Claude Code: bundled skills and workflows are removed entirely, while built-in slash commands like `/init` stay typable but are hidden from the model. **Skills from plugins, `.claude/skills/`, and `.claude/commands/` are unaffected.**" (*Settings reference*) — confirming `.claude/commands/` and `.claude/skills/` are the *same* surface at two maturity levels.

**Why the generalization matters as philosophy:** a slash command is *user-triggered* (the human must remember `/deploy-staging` exists). A skill is *model-triggered*: its frontmatter carries `description` and `when_to_use` fields that the model reads each turn, so the model itself decides when the packaged workflow is relevant. The overview frames the intent: *"Create skills to package repeatable workflows your team can share, like `/review-pr` or `/deploy-staging`."* The design goal is that capability scales *without* the user having to memorize a growing command palette.

### Extensibility without clutter, enforced

Because skills are injected into the model's context every turn, Anthropic built explicit anti-clutter mechanisms — this is the clearest example of the philosophy in action:

- **`skillListingBudgetFraction`** (default `0.01` = 1% of context): "Fraction of the model's context window reserved for the skill listing Claude sees each turn. When the listing exceeds the budget, **descriptions for the least-used skills are collapsed to bare names** so Claude can still invoke them but won't see why." (v2.1.105+, *Settings reference*).
- **`maxSkillDescriptionChars`** (default 1536): per-skill cap on the combined `description` + `when_to_use` text.
- **`skillOverrides`** (v2.1.129+): per-skill visibility (`on`, `name-only`, `user-invocable-only`, `off`) so a team can "hide or collapse a skill without editing its `SKILL.md`."

The intent is explicit: *the more extensions you add, the more the system compresses their footprint*, rather than letting context bloat degrade the core experience. Extensibility is bounded so it never violates the "without clutter" half of the philosophy.

---

## Hooks: lifecycle extensibility via deterministic scripts

### What exists and why

Hooks are user-defined shell commands that run at well-defined points in the Claude Code lifecycle. They are configured declaratively in `settings.json` under the `hooks` key ("Configure custom commands to run at lifecycle events. See hooks documentation for format", *Settings reference*) and are read from the user, project, local, and managed scopes.

The documented event set spans the full agentic lifecycle:

| Event | Fires when | Intent it serves |
|---|---|---|
| `SessionStart` / `SessionEnd` | session begins / ends | environment setup, teardown, auditing |
| `UserPromptSubmit` | user submits a prompt | validate/transform input before the model sees it |
| `PreToolUse` | before any tool call | gate, block, or rewrite a tool invocation |
| `PostToolUse` | after a tool returns | auto-format, lint, log, trigger downstream work |
| `Stop` / `SubagentStop` | main agent / subagent finishes a turn | cleanup, notifications, verification |
| `Notification` | a notification is due | route to custom channels |
| `PreCompact` | before context compaction | snapshot state before it's summarized away |
| `ConfigChange` | settings files change on disk | react to live config edits |
| `Setup` (with `init`/`maintenance` matchers) | invoked via `--init` / `--maintenance` | one-shot bootstrap for scripted/CI runs |

(The core set `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `Notification`, `SessionStart`, `SessionEnd`, `PreCompact` is documented in the *Hooks reference*; `ConfigChange` and the `Setup` matcher are confirmed in the captured *Settings* and *CLI* references — "the `ConfigChange` hook fires for each detected change" when settings reload, and "`--init` Run Setup hooks with the `init` matcher," "`--init-only` Run Setup and SessionStart hooks, then exit.")

### The design intent

Hooks exist to give users **deterministic, non-LLM control points** — places where *code* runs, not where the model improvises. The overview states the canonical use cases plainly: *"Hooks let you run shell commands before or after Claude Code actions, like auto-formatting after every file edit or running lint before a commit."*

This is philosophically distinct from the other three surfaces:

- **vs. skills/agents:** hooks do not consume model context and do not require an LLM call. They are fast, cheap, and predictable — the right tool for policy enforcement (a `PreToolUse` hook can block a `Bash(rm -rf)` call before it ever runs) and for housekeeping (format-on-edit, commit-time lint).
- **vs. MCP:** MCP brings *new capabilities* into the model's world; hooks observe and shape the *existing* lifecycle. They are complementary, not competing.

Hooks communicate over a **JSON-over-stdio contract**: each hook receives a structured event payload on stdin and can return JSON on stdout to control subsequent behavior (e.g., a `PreToolUse` hook returning exit code 2 blocks the call). This keeps hooks language-agnostic — any script in any language is a valid hook — which is the same "small composable piece, language-agnostic" instinct behind Unix pipes.

Anthropic also added **HTTP hooks** with explicit allowlists (`allowedHttpHookUrls`, `httpHookAllowedEnvVars`) and a managed-only `allowManagedHooksOnly` toggle, so the same lifecycle surface can be policy-gated for organizations. The care taken to *bound* hook power (URL allowlists, env-var interpolation limits, managed-only lockdown) is the philosophy applying itself: extensibility is granted, then deliberately fenced so it cannot become a security or operational liability.

### Live reload as a usability commitment

A small but telling detail: "Claude Code watches your settings files and reloads them when they change, so edits to most keys apply to the running session without a restart. This includes `permissions`, `hooks`, and credential helpers." (*Settings reference*). Hooks are treated as live, iterative development artifacts, not deploy-and-restart configuration — lowering the friction of authoring them.

---

## Subagents and the Task tool: parallel, isolated context

### What exists and why

A **subagent** is a specialized Claude instance with its own system prompt, its own tool whitelist, and — crucially — its own **isolated context window**. Subagents are defined as Markdown files with YAML frontmatter, mirroring the skills format:

- **User subagents:** `~/.claude/agents/` — "Available across all your projects."
- **Project subagents:** `.claude/agents/` — "Specific to your project and can be shared with your team."
- **Dynamic subagents:** the `--agents` flag defines them inline via JSON, "Us[ing] the same field names as subagent frontmatter, plus a `prompt` field for the agent's instructions" (example: `{"reviewer":{"description":"Reviews code","prompt":"You are a code reviewer"}}`). (*CLI reference*, *Settings reference*)

The settings reference describes the intent directly: *"Subagent files define specialized AI assistants with custom prompts and tool permissions."* Frontmatter fields include `name`, `description`, `tools`, and `model` (plus `prompt` for the inline form).

The main thread invokes a subagent through the built-in **Task tool**, which the settings reference names explicitly: *"Claude Code has access to a set of tools for reading, editing, searching, running commands, and **orchestrating subagents**."* A subagent can even become the main thread itself via the `agent` setting: "Run the main thread as a named subagent … Applies that subagent's system prompt, tool restrictions, and model."

### The three design intents

1. **Context isolation.** The biggest practical problem in agentic coding is *context pollution* — a long investigation fills the window with stale detail that degrades later reasoning. Spawning a subagent for a bounded subtask (e.g., "search the codebase for all call sites of `foo()`") keeps that investigation's churn *out* of the lead agent's context; only the distilled result returns. This is why subagents exist as a primitive rather than as a convenience: they are the product's answer to the finite-context problem.
2. **Parallelism.** Subagents can run concurrently, and Claude Code exposes multiple parallelism tiers: in-process subagents via the Task tool, full background sessions via `--bg` / `claude agents` (an "agent view to monitor and dispatch parallel background sessions"), and **agent teams** where "a lead agent coordinates the work, assigns subtasks, and merges results" (*Overview*). The overview sells the intent: *"Spawn multiple Claude Code agents that work on different parts of a task simultaneously."*
3. **Specialization via least-privilege tooling.** A subagent's frontmatter restricts its `tools` — a reviewer agent can be given `Read` only, no `Edit`/`Bash`. This is capability-scoped delegation: the lead can hand off risky work to a subagent that *physically cannot* perform the destructive operations, even if compromised. The model setting is independently overridable per-subagent, so a cheap model can do retrieval while an expensive one synthesizes.

The same four-scope layering applies: a team shares a `.claude/agents/code-reviewer.md`, an individual keeps a personal `~/.claude/agents/`, and managed settings can lock the surface entirely (`strictPluginOnlyCustomization: ["agents"]`).

---

## MCP servers: connecting external tools and data

### What exists and why

The **Model Context Protocol** is the one surface Anthropic did *not* invent purely for Claude Code — it is an **open standard**, and that is the point. The overview states the framing:

> "The Model Context Protocol (MCP) is an **open standard** for connecting AI tools to external data sources. With MCP, Claude Code can read your design docs in Google Drive, update tickets in Jira, pull data from Slack, or use your own custom tooling." — *Overview*

An MCP server is an external process that exposes *tools*, *resources*, and *prompts* to any MCP-capable client. Claude Code connects to them via multiple transports — local `stdio`, `SSE`, and `HTTP` (the `claude mcp login` command "Works for HTTP, SSE, and claude.ai connector servers," *CLI reference*). Servers are configured in:

- **Project:** `.mcp.json` (checked in, shared with the team — `--strict-mcp-config` uses *only* these).
- **User:** entries in `~/.claude.json`.
- **Ad hoc:** `--mcp-config ./mcp.json` for a single run.
- **Managed:** `managed-mcp.json` plus `allowedMcpServers` / `deniedMcpServers` / `allowManagedMcpServersOnly` for org policy.

Once connected, an MCP server's tools appear to the model under a namespaced `mcp__<server>__<tool>` scheme and are governed by the same permission system as built-in tools (the `--disallowedTools` flag notes that `"mcp__*"` removes *every* MCP tool at once).

### The design intent

1. **Separation of capability from the agent runtime.** Instead of bolting "read Jira" into Claude Code's binary, the capability lives in an independently versioned, independently authored server. Claude Code stays small; the ecosystem grows around it. This is "compose small pieces" at ecosystem scale.
2. **Standardized interoperability.** Because MCP is an open protocol, *any* MCP server works with *any* MCP client (Claude Code, Claude Desktop, third-party agents, the Agent SDK). An organization invests in one MCP server and reuses it everywhere — Anthropic explicitly cross-links this: "Each surface connects to the same underlying Claude Code engine, so your `CLAUDE.md` files, settings, and MCP servers work across all of them" (*Overview*).
3. **Policy-grade governance.** MCP is powerful enough that Anthropic built a full managed-settings governance layer: allow/deny lists, managed-only lockdown, OAuth via `claude mcp login`/`logout` (v2.1.186+), and connector suppression (`disableClaudeAiConnectors`, v2.1.182+). Extensibility is granted at the *user/team* level and revoked at the *admin* level through the same config schema.

### Why MCP is the load-bearing surface for "connect your tools"

The overview's structure tells the story: under "Connect your tools," MCP is the *only* mechanism named; skills/hooks/agents handle *behavior* while MCP handles *integration*. The intended division of labor is: **MCP gives the model new things it can do and read; hooks/agents/skills shape how the model behaves with what it already has.**

---

## Plugins: packaging the four surfaces together

The newest tier of the philosophy is the **plugin** — a distributable bundle that can package *any combination* of the four surfaces:

> "Claude Code supports a plugin system that lets you extend functionality with **skills, agents, hooks, and MCP servers**. Plugins are distributed through marketplaces and can be configured at both user and repository levels." — *Settings reference*

Plugins are installed from **marketplaces** (`claude plugin install code-review@claude-plugins-official`) and managed via `/plugin`, which lets users "View plugin details (skills, agents, hooks provided)." A plugin is therefore *not* a fifth surface — it is a **distribution vehicle** for the existing four. This is the philosophy's capstone: the atomic units (skills/agents/hooks/MCP) stay small and composable, and plugins solve the orthogonal problem of *how to share and govern a bundle of them*.

The governance design confirms the architecture: `strictPluginOnlyCustomization` (v2.1.82+) can lock any subset of `[skills, agents, hooks, mcp]` so they "can only come from plugins or managed settings," and the documentation spells out, per surface, what still loads when locked (e.g., for skills: "Plugin skills, bundled skills, skills in the managed policy directory"). The four surfaces are first-class; the plugin is a container.

---

## Synthesis: why this architecture exists

Anthropic's extensibility design resolves a tension every agentic tool faces: **the more you let users extend the agent, the more you risk degrading it** (context bloat, unpredictable behavior, security surface, governance gaps). Claude Code's response is a layered architecture where each choice mitigates one risk:

- *Markdown + frontmatter + file-location convention* → extensions are readable, diff-able, and shareable in a normal git workflow (lowers the cost of authoring; raises the quality of review).
- *Model-invoked skills with a context budget* → capability can grow without forcing users to memorize a command palette, *and* the growth is bounded so context quality is protected.
- *Hooks over stdio* → deterministic control lives outside the model, so policy/format/lint never depend on LLM reliability.
- *Subagents with isolated context and scoped tools* → parallelism and specialization without polluting the lead's window or granting blanket privileges.
- *MCP as an open protocol* → capability scales as an ecosystem rather than ballooning the core binary, and is reusable beyond Claude Code.
- *Plugins + managed settings* → bundling and governance are solved orthogonally to the atomic surfaces, so an admin can lock the supply chain (`strictKnownMarketplaces` + `strictPluginOnlyCustomization`) without redesigning the extension model.

The throughline, stated in the overview and enforced in the settings, is that **extensibility is a first-class product concern with explicit budgeting, scoping, and governance built in from the start** — not a plugin API bolted on after the fact. The Unix-philosophy framing in the overview is not decorative; it is the actual design constraint: every surface is a small, composable, language-agnostic piece that does one thing and connects over a defined contract.

---

## Sources

Primary sources are Anthropic's official Claude Code documentation. The following pages were consulted directly (fetched as text into the project's working directory for verification):

1. **Claude Code Overview** (`cc_overview.txt`) — composability/Unix-philosophy statement; MCP as "open standard"; skills, hooks, and agent-teams framing; cross-surface parity ("`CLAUDE.md` files, settings, and MCP servers work across all of them"). docs.claude.com → Claude Code Overview.
2. **CLI Reference** (`cc_cli.txt`) — `claude mcp`, `claude agents`, `claude plugin` commands; `--agents`/`--agent`/`--bg` flags; `--mcp-config`/`--strict-mcp-config`; `--bare`, `--safe-mode`, `--disable-slash-commands`, `--init`/`--init-only`, `--include-hook-events`; MCP transport note ("HTTP, SSE, and claude.ai connector servers"). docs.claude.com → Reference → CLI reference.
3. **Settings Reference** (`cc_settings.txt`) — the `hooks` key; subagent configuration (Markdown + YAML frontmatter, `~/.claude/agents/` vs `.claude/agents/`); plugin system ("extend functionality with skills, agents, hooks, and MCP servers"); the four-surface `strictPluginOnlyCustomization` lock table (v2.1.82+); skill anti-clutter settings `skillListingBudgetFraction` (v2.1.105+), `maxSkillDescriptionChars`, `skillOverrides` (v2.1.129+); `disableBundledSkills` (confirming `.claude/commands/` ≡ skills surface); live settings reload + `ConfigChange` hook; MCP governance (`allowedMcpServers`, `deniedMcpServers`, `allowManagedMcpServersOnly`, `disableClaudeAiConnectors`); HTTP-hook allowlists (`allowedHttpHookUrls`, `httpHookAllowedEnvVars`, `allowManagedHooksOnly`); "Tools available to Claude … orchestrating subagents." docs.claude.com → Reference → Settings.
4. **Hooks Reference** (Anthropic, docs.claude.com → Reference → Hooks reference) — the documented lifecycle event set: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `Notification`, `SessionStart`, `SessionEnd`, `PreCompact`, plus the `Setup` matcher and `ConfigChange`. (Event set per the Hooks reference page; `SessionStart`, `Setup`, `Stop`, `Notification`, and `ConfigChange` additionally confirmed verbatim in the captured Settings and CLI references above.)
5. **Version-gated feature notes** embedded throughout the Settings and CLI references function as the public changelog and are cited inline by version (e.g., `strictPluginOnlyCustomization` v2.1.82, skill-listing budget v2.1.105, `skillOverrides` v2.1.129, `disableClaudeAiConnectors` v2.1.182, `claude mcp login`/`logout` v2.1.186). The dedicated "What's New" / changelog page (docs.claude.com → What's New) was not in the fetched set; the version annotations in the reference docs are used as changelog evidence here.
6. **Subagents documentation** (Anthropic, docs.claude.com → Subagents) — referenced from the Settings reference for the full frontmatter field set and authoring guidance.

> Note on sourcing: claims in this document are drawn from the four fetched Anthropic doc pages (Overview, CLI, Settings) plus the Hooks/Subagents reference pages they cite. Where a feature is version-gated, the version annotation from the Settings/CLI reference is cited as changelog evidence. The Model Context Protocol is additionally specified by the open MCP specification (modelcontextprotocol.io), which Anthropic open-sourced in November 2024.
