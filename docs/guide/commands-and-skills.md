# Slash commands and skills

Built-in commands, your own commands, and skills.

## Slash commands

Create custom slash commands by adding Markdown files to `.book/commands/`:

```markdown
---
description: Check for spelling errors
---

Run a spell check on the codebase and fix any issues found.
```

**Shell substitution needs approval when the command is checked in.** A command body can run
shell and paste the output into the prompt — an inline ``!`git log --oneline -5` `` span, or a
fenced ` ```! ` block. That happens before the model sees anything, and it runs outside the
permission system and outside the sandbox: no rule is consulted, no sandbox applies, and nothing
is asked. A `.book/commands/*.md` file is repository-controlled, so cloning a project and typing
its command name would otherwise be enough to execute whatever that file says — including under
`book -p`, where no terminal is present to notice.

Book therefore requires a one-time decision per project command that substitutes shell. It is
recorded in `~/.book/trust.json`, keyed by workspace path — outside the working tree, like the
`.mcp.json`, `permissions.allow`, and hook decisions. Nothing a repository ships can reach it:

```bash
book trust command deploy          # or --all-pending for every command awaiting a decision
book trust command deploy --reject # refuse it
```

`book doctor` lists which project commands are approved, rejected, or still refused, and prints
the command that decides the pending ones. Until a decision exists the command is refused — in
the TUI and in print mode alike — naming the shell it wanted to run.

The decision is keyed by command name but _validated_ by fingerprint: a name is the handle you
already have for `/deploy`, and the fingerprint recorded alongside it is re-checked on every
invocation, so editing what the body runs re-asks under the same name. That fingerprint covers
the shell the body runs, in order, not the prose around it: rewording the instructions does not
ask again. Commands in `~/.book/commands/` are yours and are never gated, and a project command
that substitutes no shell has nothing to approve.

Built-ins include session controls (`/clear`, `/resume`, `/compact`, `/rewind`, `/exit`,
`/help`), task and job controls (`/task`, `/jobs`, with `/tasks` as an alias), managed-agent
controls (`/agents`, `/agent`), config (`/model`, `/providers`,
`/effort [low|medium|high|xhigh|max]`, `/config`, `/permissions`), inspection
(`/status`, `/mcp`, `/cost`, `/usage` with `/stats` as an alias, `/context`, `/diff`, `/skills`,
`/memory`), local output and reload (`/export`, `/reload-skills`), release/support
(`/release-notes`, `/feedback`), agent prompts (`/init`, `/security-review`), and code review
(`/review`, see below). `/help` is generated from the command registry: every visible built-in, in
groups, with its visible aliases, followed by your custom commands. `/release-notes` lists the
installed version's changes from the CHANGELOG that ships with Book, one line each.

Commands say only what the screen does not already show. Switching the model or the effort writes
nothing into the transcript, since the status line names the model and its effort. Other settings,
`/reload-skills`, provider changes and MCP connections confirm with a note above the composer that
fades after a few seconds; errors stay in the transcript.
`/model` switches models, while `/providers` opens the same picker for provider management. BYOK
providers you add - their credentials, model catalog, and active model selection - are saved to the
user-global `~/.book/settings.json` so they are shared across projects; such providers are labeled
`BYOK`, and selecting one of their models and pressing `Alt+D` removes it. `/effort` opens a
picker when called without an argument and saves successful selections to
`.book/settings.local.json`.

After the base URL and API key, the add-provider wizard asks where the model list should come
from: **discover automatically** (Book calls the endpoint's model-list API and you pick from the
result) or **enter model IDs manually** (comma-separate to add several at once). Manual entry is
the answer for an endpoint that exposes no model-list API, and it is still offered as a fallback
if discovery fails.

An already-configured provider keeps both routes. With one of its models selected in the picker,
`Alt+R` re-reads the catalog from the endpoint and `Alt+M` adds model IDs by hand. A refresh
replaces what discovery previously returned, but hand-entered models survive it — they exist
precisely because the endpoint does not list them, and are recorded as `"manual": true` in
settings. Neither action changes the active model or touches the provider's stored credentials,
and the highlighted model stays highlighted when the list re-sorts underneath it. Both are offered
only for the `[BYOK]` providers you added, on the same ownership rule as `Alt+D`: catalog edits are
written to `~/.book/settings.json`, so applying one to a provider inherited from a project layer
would copy that provider's credential into a second file.

**Slash commands in print mode.** `book -p "/name args"` resolves the command through the same
registries, the same `$1..$9` / named-argument / `${BOOK_*}` variable / shell substitution, and the
same `allowed-tools` and `model` frontmatter enforcement as the TUI — it is never forwarded to the
model as literal text. What differs is only what a host with no interactive surface is allowed to
do with the result:

| Command                                                                              | In print mode                                                                     |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `/init`, `/security-review`, any `.book/commands/*.md`                               | Run as the prompt for that turn                                                   |
| `/review` (and `/review --help`)                                                     | Performed by the host itself; see [Code review](agents-and-review.md#code-review) |
| Everything else — session controls, pickers, panels, `/config`, `/export`, `/memory` | Refused with an error listing what _is_ supported, and exit code 1                |

Refusal happens _before_ the command's own code runs, so a command with a side effect (`/config`
writes `settings.local.json`, `/export` writes a file, `/memory approve` mutates memory) can never
half-fire in a host that cannot show its result. A `/name` that is not a command at all is still
forwarded to the model verbatim, so an ordinary prompt like `book -p "/etc/hosts is a file"` is
unaffected. A `.book/commands/*.md` command whose shell substitution has not been approved is
refused the same way and for the same reason: this host cannot ask for the decision.

A command the host performed itself produces no model turn. Under `text` its output is written to
stdout; under `stream-json` it is announced as
`{"type":"command_result","command":…,"output":…,"data":…}`; and for `json`, `stream-json`, and the
SDK it is also carried on the result payload as `commandResults`. `output` is the human rendering
and `data` is the command's machine contract. `--output-format json` therefore remains a single
top-level JSON document.

Expansion covers both print-mode input paths (`--print "…"` and `--input-format stream-json`
stdin) and can be turned off with `expandSlashCommands: false` on `HeadlessOptions`, which forwards
every prompt verbatim — appropriate for a host relaying untrusted end-user text. `query()` does not
surface that option yet, so the SDK always expands.

`/skills` opens the interactive skill manager. Select a skill with `↑`/`↓`, press `Space` to cycle its visibility (`auto`, `name-only`, `manual`, or `off`), press `E` to cycle execution consent (`inherit`, `ask`, or `deny`), and press `Enter` to prepare an explicit `$skill-name` request. `G` toggles the global emergency switch, `R` reloads the catalog, and `/reload-skills` performs the same reload from the command line. Overrides are saved in `.book/settings.local.json` under `skills.overrides`, `skills.execution`, and `skills.enabled`.

## Skills

Book reads interoperable directory packages whose entrypoint is `SKILL.md`:

```text
<root>/<skill-name>/
  SKILL.md
  references/   optional text references
  assets/       optional templates or other files
  scripts/      optional packaged scripts (never auto-executed)
```

`SKILL.md` must start with YAML frontmatter containing `name` and `description`. The body is loaded
only after activation; metadata, validation issues, resource manifests, and digests are available
for inspection without putting the body in the initial prompt. Use `references/` and `assets/` for
supporting material; Book reads declared resources only through `ReadSkillResource`, as untrusted
content. Scripts remain ordinary resources and can run only through Book's existing execution tools
and their normal approvals.

Discovery scans these roots from lowest to highest precedence: user `~/.claude/skills`, user
`~/.agents/skills`, user `~/.config/opencode/skills`, user `~/.book/skills`, then the matching
`.claude/skills`, `.agents/skills`, `.opencode/skills`, and `.book/skills` directories from the Git
root to the current working directory. Deeper project directories and native `.book` roots win;
duplicate names are shadowed rather than merged and are shown in `/skills` diagnostics. Skill
directories may be symlinked after canonical path and size checks; resource symlinks are rejected.

Visibility controls determine whether metadata participates in automatic matching: `auto` exposes
name and description, `name-only` exposes only the name, `manual` requires explicit `$skill-name`,
and `off` disables the skill. Project-sourced implicit activation requires consent. `ask` always
requests consent, while `deny` fails closed; no skill can grant tools, bypass permissions, alter the
sandbox, or execute a packaged script implicitly. Active instructions are scoped to the current run
by default (or the next model step for `lifetime: turn`) and tool declarations are intersections
with Book's existing authorized surface.

Newly discovered skills start in `manual` mode. After evaluating representative positive and
negative prompts, enable automatic matching per skill from `/skills` or by setting its override to
`auto`; this keeps implicit activation available without treating unmeasured skill descriptions as
a safe release default.

Use `/skills status` for a body-free runtime report containing the catalog digest, active and
previous activation frames, effective tool intersection, validation failures, prompt-catalog
omissions, and recent lifecycle outcomes. The equivalent settings shape is:

```json
{
  "skills": {
    "enabled": true,
    "overrides": {
      "review": "auto",
      "deploy": "manual"
    },
    "execution": {
      "deploy": "ask"
    }
  }
}
```

For portable packages, move an existing `.claude/skills/<name>/` or
`.opencode/skills/<name>/` directory to `.agents/skills/<name>/` without changing its `SKILL.md`.
Book continues to discover the compatibility locations, so migration can be gradual; use
`.book/skills/<name>/` only when the package intentionally depends on Book-specific behavior.

Book watches skill roots and applies changes at the next safe run boundary. If an editor, network
filesystem, or platform watcher misses an update, use `R` in the manager or `/reload-skills` and
inspect `/skills status`; watcher errors are also shown in the manager. Reload clears lazy body
caches, expires affected frames, refreshes the catalog digest, and invalidates agent context without
rewriting an in-flight request.

Activation quality can be gated with
`npm run eval:skills -- observations.jsonl [report.json] [report.md]`. The report measures precision,
recall, false-activation cost, prompt/body token cost, activation latency, consent prompts, task
completion, corrections, and skill-caused tool failures across direct, indirect, negative,
ambiguous, conflicting, disabled, invalid, missing-body, and missing-resource cases. Reports retain
prompt hashes and aggregate evidence rather than raw prompts, skill bodies, or resource contents.
Run `npm run eval:skills -- --help` to print the command syntax.

`/rewind` first selects an active user prompt, then restores Conversation, Code, or Both to the state immediately before that prompt. Files are captured into local content-addressed snapshots under `~/.book/rewind/`; `--no-session-persistence` uses temporary storage that is removed on exit. `.git` and workspace-local `.book/` state are never captured by default, Git HEAD and the index are never moved, and Code/Both are disabled when HEAD drifted or a checkpoint exceeded its safety limits. Use `.book/rewindignore` to override the default exclusions for dependency, build, cache, coverage, and virtual-environment directories, or to explicitly opt selected `.book` paths back in. Other hidden, gitignored, and secret-like workspace files remain restorable; their contents stay in local blobs and are never written to session JSON or model context.
