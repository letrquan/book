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

A project command file also has to stay in the repository: it loads only when its real path is a
Markdown file inside the git repository (the workspace without one), so a `.book/commands/leak.md`
committed as a link to a file outside it is skipped with a start-up warning instead of sending the
target to the provider. This covers a linked `.book` or `.book/commands` directory too. Your user
commands, in `$BOOK_HOME/commands/` (default `~/.book/commands/`), are never checked.

**An `@path` mention in a project command's body inlines only a committed file.** A mention is
inlined into the turn sent to the provider, and a checked-in command needs no approval unless it
substitutes shell, so a body that mentions `@.git/config`, `@.book/settings.local.json` or `@.env`
would otherwise send your clone credentials, local provider key or secrets when you run it. In a
`.book/commands/*.md` body, a mention is inlined only when the file it really reads (the target,
for a link) is one git tracks in the workspace's repository with no local change, staged or not,
so it holds exactly what the repository already published. Anything else stays as written, with a
one-line notice (in the TUI, and on stderr in print mode) naming the path and the reason. With no
git repository, nothing in a project command's body is inlined; a `.git` in your home directory (a
dotfiles repository) does not count as one. The rule covers the whole resolved body, arguments
included, so `/review-file @notes.md` inlines `notes.md` only if it is committed and unchanged;
mention a changed file in a message of your own instead. A line of the body that starts with `!`
is not run either, in the TUI as in print mode: only the approved substitution above runs. Mentions
you type, and mentions in commands in `$BOOK_HOME/commands/`, are not affected. Every mention, typed or not, also stays inside the
boundary the Read tool uses: the workspace and your `additionalDirectories`.

**A `!` line runs only in a message you type.** In the TUI, a line of your message that starts with
`!` runs and its output replaces it. In a command's body, your own commands included, and in a
built-in command's prompt, such a line stays text: run shell from a command with the substitution
syntax above. Print mode and the SDK run no `!` line at all.

**`allowed-tools` narrows what a command, skill, or agent role may run.** A rule such as
`Bash(git *)` admits a Bash call only if the whole command matches the pattern, and only if the
command is a single command: one that chains, pipes, redirects or substitutes outside quotes
(``; & | < > ` $ ( ) { }``) is refused. Quotes are read, so `git commit -m "fix(x): y"` and
`git stash show 'stash@{0}'` are admitted (on Linux and macOS, and on Windows under Git Bash, see the tools guide). `$` or a backtick inside double quotes, a line break
anywhere, an unterminated quote, and quote characters a shell could read differently (a backslash
or caret before a quote, a typographic quote) are still refused, and on Windows any single quote is
refused unless the session shell is Git Bash, which reads it exactly as on Linux. Under PowerShell (which reads it as a quote), cmd.exe (which does not) and the other Windows shells, use double quotes instead. Book scans quotes but does not parse shell, so it fails closed;
split a compound command into separate Bash calls, each matching the rule, or quote the argument
that holds such characters (a commit message in double quotes, say). Whitespace around the
command, such as a trailing newline, is ignored. A bare `Bash` rule (no pattern) admits any
command.

A `Bash(<pattern>)` rule constrains the command's text, not what the program does with its
options, and it is not a sandbox. `Bash(git *)` still admits `git -c alias.x='!…' x` or
`git -c core.fsmonitor=… status`, which run other programs; when that matters, narrow the pattern
(`Bash(git status)`, `Bash(git log *)`).

Built-ins include session controls (`/clear`, `/resume`, `/compact`, `/rewind`, `/queue`, `/exit`,
`/help`), task and job controls (`/task`, `/jobs`, with `/tasks` as an alias), managed-agent
controls (`/agents`, `/agent`), config (`/model`, `/providers`,
`/effort [low|medium|high|xhigh|max]`, `/config`, `/permissions`), inspection
(`/status`, `/mcp`, `/cost`, `/usage` with `/stats` as an alias, `/context`, `/diff`, `/skills`,
`/memory`), local output and reload (`/export`, `/reload-skills`), release/support
(`/release-notes`, `/feedback`), agent prompts (`/init`, `/security-review`), and code review
(`/review`, see below). `/memory` shows what Book remembers for this repository: each memory
file from its frontmatter (type, and "from a delegated run" for what a session another agent
drove saved), the `MEMORY.md` index against its 200-line and 25,000-byte load limits, the
directory, and whether the model may write. `/memory delete <file>` removes a memory file and
every `MEMORY.md` line linking to it; `/memory path` prints the directory; `/memory on` and
`/memory off` turn the model's writes on and off (`memory.autoSave`). The model writes memory
itself, with the file tools; there is no inbox to review. `/memory consolidate [focus]` runs one
agent pass over the memory directory in the current session, so you watch its edits as ordinary
tool rows: it merges near-duplicates (deleting the extra files with `rm`), rewrites or deletes a
memory the code or a newer memory contradicts, turns relative dates into absolute ones, checks
that what a memory names still exists, and prunes `MEMORY.md` (one `- [Title](file.md) — hook`
line per file, under 150 characters, no dangling pointer, within 200 lines and 25,000 bytes). It
also reconciles feedback and project memories with `CLAUDE.md` / `AGENTS.md`: a memory that
contradicts them is deleted or rewritten to agree, and one that is clearly newer is never allowed
to edit them — it gets the line `Contradicts CLAUDE.md — verify which is current.` and is listed in
the summary for you to resolve. Optional focus text narrows the pass (`/memory consolidate the
build notes`). The pass runs with a narrow tool set: `Read`, `Glob` and `Grep` anywhere, `Write`,
`Edit` and `MultiEdit` for `*.md` files in the memory directory, and `Bash` for a plain
`rm <memory dir>/<file>.md` only; `ApplyPatch`, MCP tools and everything else are refused, and the
memory write guard still applies (secrets, the `learnings` ownership rule, the provenance stamp). It
is refused, with no prompt sent, when memory is disabled, when the model cannot write memory in
this session (`memory.autoSave` off, or a `deny` rule on memory writes), in plan mode, or when the
directory holds no memory files. `/help` is generated from the command registry: every visible built-in, in
groups, with its visible aliases, followed by your custom commands. `/release-notes` lists the
installed version's changes from the CHANGELOG that ships with Book, one line each.

In the TUI the lookups (`/cost`, `/usage`, `/context`, `/diff`, `/mcp`, `/skills status`,
`/memory` or `/memory status`, and `/release-notes`) open in a sheet above the composer, as `/help`
and `/status` do, rather than in the transcript. One sheet shows at a time, so asking for another
report replaces it. Esc closes it, and so does sending your next prompt, since its figures describe
the moment you asked. A report is not stored in the session, so it does not come back on resume.
Print mode and the SDK print the same text as before.

`/cost` and `/usage` (alias `/stats`) bill the whole session, not the last request: every response
is accumulated from the first turn of the current session, and the total survives a send, a
compaction (the summarizer spends too, and is included) and a `/rewind`. It is reset by `/clear`,
`/new` and a resume, which start a different session; a resume starts the bill again at the resume,
so both reports say the figure is counted from there — the persisted totals are still in
`book status <id>`. Both count the managed agents this session spawned, attributing each to the
model it actually ran on and adding them to the headline figure, which names how many agents it
includes; `/cost` appends the per-model breakdown once more than one model has run, and `/usage`
prints the same alongside the turn, duration and tool-call counters.
The USD figure is a local estimate from the price table. Each of the lead session's responses is
priced at the model that served it, and at the rate for that request's size where a model charges
by prompt length (`claude-haiku-5-5` charges more above 100,000 prompt tokens); the per-model
breakdown still lists the lead's tokens under the active model, so a mid-session `/model` switch is
not split out by row. A delegated agent reports only its summed tokens, so a model priced by prompt
length is charged at its higher rate there, and the report says the figure is an upper bound.

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

The wizard is a sheet, like every other decision the TUI asks for: a rule reading
`Add BYOK provider`, with the `Step N/9` counter set at the far end of it, and the step's body two
columns in so its text lands on the same column as the transcript above. It draws no box of its
own, and it is drawn at the same measure as the model picker it opens from, so the surface never
jumps wider than the panel it replaced.

Every text field in the wizard — and in every other sheet — is Book's own single-line editor, with
the readline chords a terminal user expects: `Ctrl+A` and `Ctrl+E` for the start and end of the
line, `Ctrl+U` to kill to the cursor, `Ctrl+K` to kill to the end, `Ctrl+W` to kill the word to
the left, and `Ctrl+D` to delete the character under the cursor. Any other `Ctrl` chord is ignored
rather than typed into the value.

An already-configured provider keeps both routes. With one of its models selected in the picker,
`Alt+R` re-reads the catalog from the endpoint and `Alt+M` adds model IDs by hand. A refresh
replaces what discovery previously returned, but hand-entered models survive it — they exist
precisely because the endpoint does not list them, and are recorded as `"manual": true` in
settings. Neither action changes the active model or touches the provider's stored credentials,
and the highlighted model stays highlighted when the list re-sorts underneath it. Both are offered
only for the `[BYOK]` providers you added, on the same ownership rule as `Alt+D`: catalog edits are
written to `~/.book/settings.json`, so applying one to a provider inherited from a project layer
would copy that provider's credential into a second file.

`Alt+K` on the same rows replaces the provider's API key, for one that was rotated or has expired,
without removing the provider and running the wizard again. It opens an `Update API key` sheet that
names the provider and the endpoint, with a masked field (`•` per character) that takes whatever the
wizard's key step takes, including `{env:VAR}` and `{file:path}` references. Enter tests the key
against that endpoint's model-list API, and only that endpoint's; a provider with no base URL is
not asked at all. When the endpoint accepts it, the key is saved. When it refuses, or does not
answer, the sheet shows the error and offers `s` to save anyway (some endpoints have no model-list
API), `r` to retry the test, and `Esc` to edit the key; `Esc` on the field, or `Ctrl+C` anywhere,
cancels with nothing saved. Only `apiKey` changes: the catalog, the active model and every
per-model override stay, and the running session sends the new key from its next request. From the
shell, `book config provider-key <id>` does the same (see
[Configuration](configuration.md#scopes)).

**Slash commands in print mode.** `book -p "/name args"` resolves the command through the same
registries, the same `$1..$9` / named-argument / `${BOOK_*}` variable / shell substitution, and the
same `allowed-tools` and `model` frontmatter enforcement as the TUI — it is never forwarded to the
model as literal text. What differs is only what a host with no interactive surface is allowed to
do with the result:

| Command                                                                                          | In print mode                                                                     |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `/init`, `/security-review`, `/memory consolidate`, any `.book/commands/*.md`                    | Run as the prompt for that turn                                                   |
| `/review` (and `/review --help`)                                                                 | Performed by the host itself; see [Code review](agents-and-review.md#code-review) |
| Everything else — session controls, pickers, panels, `/config`, `/export`, other `/memory` forms | Refused with an error listing what _is_ supported, and exit code 1                |

Refusal happens _before_ the command's own code runs, so a command with a side effect (`/config`
writes `settings.local.json`, `/export` writes a file, `/memory delete` removes a memory) can never
half-fire in a host that cannot show its result. A `/name` that is not a command at all is still
forwarded to the model verbatim, so an ordinary prompt like `book -p "/etc/hosts is a file"` is
unaffected. A `.book/commands/*.md` command whose shell substitution has not been approved is
refused the same way and for the same reason: this host cannot ask for the decision.

A command that runs as a prompt (`/init`, any `.book/commands/*.md`, in the TUI and in print mode)
names a new session after the line you typed, such as `Init` or `Deploy staging`, not after the
prompt it generated. The line is taken before argument and shell substitution. A session that
already has a name keeps it. The fresh session a plan handoff starts takes the planning session's
name.

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

## Goals and the advisor

Both are modelled on the Claude Code commands of the same names.

**`/goal <condition>`** keeps the agent working until the condition holds. Setting a goal starts a
turn toward it (mid-turn, it applies to that turn). From then on, each time the agent stops
without calling a tool, a separate model reads the transcript and answers whether the condition is
satisfied: the compact model (`compactModel`, else the session model) at `low` effort, with no
tools and a 30-second limit, using Claude Code's evaluator prompt.

- **Not met**: the evaluator's reason goes back to the agent as a host-authored turn
  (`Stop hook feedback: [<condition>]: <reason>`), the transcript shows
  `Goal not yet met… continuing`, and the run goes on.
- **Met**: the goal clears itself and the transcript shows
  `● Goal achieved (<time> · <turns> · <tokens>)`.
- **Impossible** (the evaluator judges it can never hold): the goal clears, and the transcript
  shows `Goal could not be achieved: <reason>`.
- **Still unmet after eight rounds of feedback**: as in Claude Code, the agent is sent back eight
  times within one run, and a ninth unmet check ends the run with
  `Goal paused · … · send a message to continue`; the goal stays set, and the next message
  resumes checking with a fresh count.
- **A check that fails** (provider error, timeout, unreadable answer) lets the run end and keeps
  the goal. A broken evaluator never traps the agent.

Only a stop the agent chose is checked: a plan stop or handoff, a cancel, and the continuation
brakes (`no_progress`, `continuation_limit`, the wall-clock ceiling) all end the run as they would
without a goal. A stop on the last turn `--max-turns` allows is checked too: a met goal clears as
usual, and an unmet one ends the run `failed / max_turns` with the goal kept. A run whose goal was
judged impossible, or is still unmet after the eight rounds, ends `failed / goal_unmet`, and one
whose last check could not run ends `failed / goal_unverified`, so `book -p "/goal …"` exits
non-zero whenever nothing confirmed the goal; a met goal ends as a normal completion. A goal set
while a check is running is checked in its place against the same stop, with its own count. The
token figure counts the output tokens the agent and its goal checks spent while the goal was set.

While a goal is set, the status line shows `◎ /goal active (<elapsed>)`: the time since the goal
was set, written as in `● Goal achieved (…)` (`45s`, `4m`, `1h 12m`) and left out for the first
second. A goal brought back by `--resume` keeps its original start. The chip goes away when the
goal is met, judged impossible, or cleared; a goal that paused after eight rounds is still set, so
its chip stays.

Write the condition so the transcript can prove it: "`npm test` exits 0 and the output is shown"
is checkable; "the code is good" is not. `/goal` with no argument shows the goal, how many checks
it has failed, and the last reason; `/goal clear` (or `stop`, `off`, `reset`, `none`, `cancel`)
drops it early. A new session started with `/goal` is named after the condition rather than the
`Goal set:` line. A goal is recorded in the session file, so `--resume` and `/resume` bring back an
unmet one; `/clear` drops it. Only the root agent is checked — subagents and managed agents work
toward their own tasks. In print mode, `book -p "/goal <condition>"` runs the same loop, with each
check on stderr as `goal: …` (or as a `goal_status` event under `--output-format stream-json`).
`--quiet` hides those progress lines but still prints the paused or failed line that explains a
non-zero exit.

**`/advisor <model>`** gives the agent an `Advisor` tool backed by a stronger model, which it is
told to call before substantive work, when stuck, and before declaring a task done. The tool takes
no arguments: Book sends the system prompt the agent works under (the project's `CLAUDE.md` and
`AGENTS.md` rules among it) and the whole conversation — including the text the agent wrote just
before calling it and any call it made earlier in the same turn, with tool results whole while
they fit — to the advisor model through that model's own provider, at the session's effort capped
at `high` and with its output capped at what that model accepts, and returns the advice as the
tool's result (marked when it was cut off at the output limit). The advisor cannot run tools.
`/advisor` alone opens a picker of the models you have configured, followed by an **Off** row, with
the cursor on the current choice, so no model id has to be typed from memory. It is the same picker
as `/model`, aimed at the advisor, and the **Advisor** row of `/config` (shortcut `V`) opens it
too; a saved advisor that matches no listed model, such as a mistyped id, is flagged in it.
`/advisor status` (or `show`, `version`, and Claude Code's other status words) prints the current
advisor instead, and marks a stored id that would be refused. `/advisor <model>` sets one by id,
`/advisor off` removes it, and the choice is saved to `~/.book/settings.json` as `advisorModel`
(`BOOK_ADVISOR_MODEL` outranks it, and the picker says so while it is set). The advisor fails closed
on an id that is not `<provider>/<model>` for a provider in `settings.provider`: such an id
(`/advisor claude`) is refused with a message and saves nothing, whether it is typed as
`/advisor <id>` or picked in the picker, and an `advisorModel` of that kind already in settings
makes the tool fail (`advisor_unconfigured`, not retryable) before anything is sent. It is
allowed only when it is the main model, when `BOOK_BASE_URL` is set (the legacy `baseUrl` does
not count), or when it resolves to exactly the endpoint and key the main session already uses,
so `/advisor claude` is refused in the common case. Even then, with no key at all the tool
refuses. A prefix that matches no configured provider (`/advisor antropic/x`) is saved with a
warning, and any other id that is not in your model list is saved with a note. So name the provider:
`/advisor <provider>/<model>`. See "Model ids and provider prefixes" in the configuration guide. The
consultation is billed to the session at the advisor model's rates, and `/cost` lists it, and the
goal checks, as their own lines. Like `TodoWrite`, the tool needs no permission prompt (an
explicit `deny` or `ask` rule naming it still applies).

Unlike Claude Code, whose advisor is a server-side tool available only on Anthropic's API, Book's
runs client-side, so any provider and any model can be the advisor. For Claude models, `/advisor`
notes when the advisor ranks below the main model (Claude Code's ranking); any other pairing is
accepted as given.

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
root to the current working directory. A `.git` in your home directory itself (a dotfiles
repository) is not a Git root, so a project under your home without its own `.git` scans only its
own directory. Deeper project directories and native `.book` roots win;
duplicate names are shadowed rather than merged and are shown in `/skills` diagnostics. Skill
directories may be symlinked after canonical path and size checks; resource symlinks are rejected.
On Windows, skill discovery skips a project skill root, skill directory or `SKILL.md` that is, or
reaches through a link, a network (UNC) path such as `\\host\share`, without resolving it; your own
user roots are not checked.

Visibility controls determine whether metadata participates in automatic matching: `auto` exposes
name and description, `name-only` exposes only the name, `manual` requires explicit `$skill-name`,
and `off` disables the skill. Only a `$skill-name` you type invokes a skill, in your message or in
the line that runs a command (`/triage $review`); in a command's body, the REVIEW.md that
`/security-review` carries, a file a mention inlines, or a subagent's task, it is plain text. Project-sourced implicit activation requires consent. `ask` always
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

`/rewind` first selects an active user prompt, then restores Conversation, Code, or Both to the state immediately before that prompt. Conversation and Both put the prompt you typed back in the composer (for a command's turn, the line that ran it); a turn with no typed prompt on record, such as a notification, a print-mode turn, or one saved by an earlier version, leaves the composer as it is. Files are captured into local content-addressed snapshots under `~/.book/rewind/`; `--no-session-persistence` uses temporary storage that is removed on exit. `.git` and workspace-local `.book/` state are never captured by default, Git HEAD and the index are never moved, and Code/Both are disabled when HEAD drifted or a checkpoint exceeded its safety limits. Use `.book/rewindignore` to override the default exclusions for dependency, build, cache, coverage, and virtual-environment directories, or to explicitly opt selected `.book` paths back in. Other hidden, gitignored, and secret-like workspace files remain restorable; their contents stay in local blobs and are never written to session JSON or model context.
