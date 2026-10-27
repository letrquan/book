# Configuration

Where settings live, what they mean, and the environment variables that override them.

## Settings files

Settings are loaded in priority order (later wins):

1. `~/.book/settings.json` (user-global)
2. `.book/settings.json` (project)
3. `.book/settings.local.json` (local, should be gitignored)
4. `--settings <path>` CLI flag

In a session started in your home directory with `BOOK_HOME` unset, the workspace's
`.book/settings.json` is the user file itself: it is read once, as the user layer, and nothing in
it is held back as a repository declaration. Instruction files are compared by real path, so a
home reached through a symlink still counts its own files once, as the user's, and a project skill
folder is folded into a user one only when their real paths match.

One family is not "later wins". `sandbox.*` is a boundary between a command and your machine, so
a **workspace layer may only tighten it** — see [The sandbox](#the-sandbox).

### Scopes

`book config set` and the TUI's `/config <key>=<value>` write the **user-global** layer
(`<BOOK_HOME>/settings.json`, normally `~/.book/settings.json`) unless told otherwise, so a
preference you set once applies in every checkout. Pass `--project` to write the checked-in
`.book/settings.json`, or `--local` to write the gitignored `.book/settings.local.json`.
`-g`/`--global` states the default explicitly; passing more than one scope is an error. Both
surfaces run the same guards through one shared write, so they cannot disagree about which file a
preference lands in.

A write is checked against the _merged_ configuration, not just the file it lands in, so a value
that is valid on its own but would leave a configuration nothing can load is refused before it
lands rather than bricking every later command. A configuration that is already broken stays
writable, since repairing one is what the command is for.

Book's own workspace writes (`.book/settings.json`, `.book/settings.local.json`,
`.book/migrations.json`, a project `.mcp.json`, `/export`, and the default `.book/debug.log`) only
touch regular files: each is written only while it is a regular file or does not exist yet.
Anything else at that path is left as it is, and the write stops with a one-line notice naming the
file; for the debug log, debug logging stops for the session. `/export` also writes only inside the
workspace. `<BOOK_HOME>/settings.json` and `<BOOK_HOME>/mcp.json` are written as before.

`book config get` and `book config list` report the _resolved_ merge of all layers by default.
Given a scope they read that one file verbatim instead, which is how you find the stray value
overriding you — the local layer resolves last, so anything left there outranks a later global
write. `book config unset <key>` removes a key from a scope (also user-global by default). A
user-global write that a workspace layer still shadows says so, and names the `unset` that clears
it.

`book config provider-key <id>` replaces the API key of a provider in your user file, the shell
twin of `/model`'s `Alt+K`. It reads the key from stdin, never from the command line: hidden input
on a terminal, and otherwise the piped text with its trailing line ending dropped
(`printf '%s' "$KEY" | book config provider-key openrouter`). A key passed as an argument is
refused, without being echoed. The input takes what the add-provider wizard takes, including
`{env:VAR}` and `{file:path}`. Before saving, the key is tested against that provider's own
endpoint (its model-list API); on a terminal a failure offers save anyway, retry, a different key,
or cancel, and otherwise the command exits non-zero having written nothing. `--force` saves despite
a failed test, and `--no-check` skips the test, for an endpoint without a model-list API. An id
that is not in `<BOOK_HOME>/settings.json` fails with the ids that are; one only a repository
declares (`.book/settings.json` or `.book/settings.local.json`) is refused, on the ownership rule
the picker uses, and `--project`, `--local`, `--settings` and `--no-settings` are refused too: the
target is always your user file. Like every `config` subcommand it needs no working credential.
The test is one request with a 20-second limit, so a dead host fails quickly; retry it if the
endpoint was only briefly unavailable. A relative `{file:path}` is read from the workspace you run
in, for the test and in every later session, since the user file applies to every workspace; use
`~/` or an absolute path for a key file kept in one place.

Two groups of keys are refused in every scope. Trust decisions
(`mcp.projectServers`, `permissions.projectAllowRules`, `hooks.projectEntries`,
`commands.projectCommands`, `projectDirectories`, `workspaceProviders`) live in
`<BOOK_HOME>/trust.json` and are recorded with `book trust`. The store is version 4; an older build
reads a v4 store as unreadable and withholds every gated declaration until it is upgraded, rather
than silently writing over the decisions it does not understand.
The `shell` setting is not writable by `book config` in a workspace scope — it names the program
every `Bash` command is handed to, so edit the user-global file directly, pass `--settings`, or
use `BOOK_SHELL`.

### Model ids and provider prefixes

A `model` written as `<provider>/<model>` is resolved through the `provider` registry: the prefix
selects the base URL, credential, and model catalog. The same spelling is also how many endpoints
name a single model (`meta-llama/llama-3-70b`), so a prefix that matches nothing is not an error —
Book passes the whole id through to the default endpoint.

That fallback is silent by design for the second form, but wrong for a typo. So when you have
configured providers and the prefix matches none of them, Book says so — on stderr at startup and
inline in `book doctor` — instead of leaving `Credentials: not resolved` as the only symptom of a
misspelled provider id.

**Which key a model gets.** A provider entry with its own `apiKey` uses it. An entry without one,
and a bare id that goes to the default endpoint, gets `BOOK_API_KEY` when it is set. Otherwise it
gets the key the session already sends, but only when its endpoint is the very one the session
already sends that key to; any other endpoint gets no key. A provider that only a repository
declares is the exception: it never inherits a key (see
[Providers a repository declares](#providers-a-repository-declares)). Endpoints are compared after
normalisation, so a trailing slash or the case of the scheme and host does not make a different
one, while another host, port, scheme or path does. A key configured for one provider is never
carried to another endpoint, so switching to a bare id cannot hand your Anthropic key to
`https://api.openai.com/v1`. The default endpoint is `BOOK_BASE_URL` (or the legacy
`.bookrc.json` `baseUrl`) when set, and `https://api.openai.com/v1` otherwise.

**Provider requests refuse HTTP redirects.** An endpoint that answers with a 3xx fails the request
with an error naming the redirect target (scheme, host and path only), and nothing is sent there,
so your key and prompt never reach a URL you did not configure. The usual causes are `http` where
the endpoint wants `https`, a missing or extra path segment such as `/v1`, or a host that has moved.
If the host the error names is the endpoint you meant, set the provider's base URL to that address
without the endpoint path Book adds (`/messages`, `/chat/completions`, `/responses` or `/models`): for example,
`https://gw.example/v1/chat/completions` becomes the base URL `https://gw.example/v1`.

**The advisor fails closed.** `advisorModel` (and `BOOK_ADVISOR_MODEL`, and `/advisor`) is a
request you do not make yourself, so an id that is not `<provider>/<model>` for a provider in
`provider` is refused, and nothing is sent, unless one of these holds:

1. it is the main model;
2. `BOOK_BASE_URL` is set. Only that variable counts: the legacy `.bookrc.json` `baseUrl` still
   sets the default endpoint, but a repository can ship that file, so it does not show that you
   chose the endpoint;
3. it resolves to exactly the endpoint and key the main session already uses, as a bare
   `gpt-5` does next to a bare `gpt-4o` on the default endpoint with `BOOK_API_KEY`.

An id that starts or ends with `/` is refused whatever the base URL. `/advisor <id>` reports the
refusal and saves nothing, and an `advisorModel` already in settings makes the `Advisor` tool fail
with `advisor_unconfigured` instead of making a request; `/advisor` alone shows such an id as
`(refused: …)`. A provider prefix that matches no configured provider (`antropic/x`) is saved, as
for `model`, and `/advisor` warns that it is probably a typo. Name the provider:
`anthropic/claude-opus-5-5`.

A consult that fails is marked retryable only when a repeat could succeed: rate limits, overload,
server errors, network errors and timeouts. A rejected key or account, a retired or misspelled
model, a transcript too long for the advisor's window, and any verdict on the request itself
(400, 404, 422, a content filter) are not, so the agent does not send the same consult again.

### Providers a repository declares

A `provider` entry names two things you care about: where a request goes (`baseURL`) and which
credential rides along (`apiKey`, a literal or a `{env:VAR}` / `{file:path}` reference that Book
reads for the entry). A checked-in `.book/settings.json`, a force-added `.book/settings.local.json`
or a legacy `.bookrc.json` can write both, so a workspace layer does not get to decide them
unchecked. Without this gate, a cloned repository could send your provider key, `BOOK_API_KEY`, any
file under `~` or any environment variable, plus the transcript, to an endpoint it named. Your own
layers (`~/.book/settings.json`, `--settings`) are trusted and unchanged.

- **A provider you define keeps your origin, key and type.** A workspace layer cannot change
  `baseURL`, `baseUrl`, `apiKey`, `type` or `api` on a provider your own settings (the user file or
  `--settings`) define. `type` and `api` decide how the key is sent (a bearer token to
  `/chat/completions` or `/responses`, or `x-api-key` to `/v1/messages`), so changing them would
  re-route your key without moving the origin. The override is dropped and reported, at launch and in `book doctor`. Only its `models`
  still merge, so a repository can still add a model to your provider. The model picker's refresh
  and hand-typed models write only what your own file holds, never a value a workspace layer
  merged in.
- **A provider only a repository declares is withheld.** It is not in effect until
  `book trust provider <id>` approves it. The decision is recorded in `~/.book/trust.json`, which
  nothing a repository ships can write, and it is keyed by a fingerprint of the declaration's
  `type`, origin and `apiKey` text, and its `api` when it sets one. Changing the `baseURL` or the key reference needs a new
  approval; editing its `models` does not. `book trust provider` shows what a request would
  actually reach, in full: the parsed protocol, host and port of the origin (a URL with userinfo
  before the host, or one that does not parse, is flagged), the variable an `{env:…}` reference
  names, and the normalised file a `{file:…}` reference opens, with `~` expanded and `..`
  resolved. It never shows a resolved value, and a literal key is not echoed at all.
- **The id `.bookrc.json` is reserved.** The decision about a legacy `baseUrl` is stored under that
  key, so a workspace provider named `.bookrc.json` can never be approved: it stays withheld
  whatever the trust store holds, and is reported as reserved. Rename it.
- **It never inherits a key.** A workspace provider does not get `BOOK_API_KEY` or the key the
  session already sends, even once approved. It sends its own `apiKey` or none, so an approved
  keyless workspace provider fails at startup with the missing-key error
  (`BOOK_API_KEY or provider.<id>.apiKey not set`) until its declaration carries its own key.
  Changing the declaration to add one is a new approval.
- **Its key reference is not read before approval.** A `{env:…}`, `{file:~/…}` or absolute
  `{file:…}` reference on a withheld provider is never resolved: no environment variable is read
  and no file is opened. Approving the provider is what allows that reference to be read, so
  review it in the `book trust provider` listing first.
- **A workspace selection that names a withheld provider falls back.** A workspace `model`,
  `compactModel`, `advisorModel`, `agents.profiles.<name>.model` or a legacy `.bookrc.json` `model`
  of the form `<id>/<model>` for a withheld provider is ignored, with a notice and a line in
  `book doctor`, and your own value applies (or the default, when you set none). A model a
  repository chooses any other way fails with a message naming `book trust provider <id>` instead
  of falling back: the `model:` frontmatter of an agent definition and a `model` passed to
  `AgentSpawn`. Nothing is sent to the default endpoint in its place. The id is read trimmed, by one
  function, in the loader and in the resolver, so a value with surrounding whitespace is treated
  the same on both sides.
- **Your own model that shares a prefix is unaffected.** A repository can pick any provider id, so
  a declared `meta-llama` collides with your own `model: "meta-llama/llama-3-70b"`, which is one
  vendor-namespaced id and names no provider of yours. A selection from your own settings,
  `--settings`, `--model`, `BOOK_MODEL`, `/model` or an `agents.profiles` override of yours whose
  prefix names only a withheld workspace provider starts and resolves exactly as it would if the
  workspace had not declared that provider, and is reported once ("provider `meta-llama` declared
  by the workspace is withheld; your model `meta-llama/…` is unaffected"). **Approving that
  provider changes this:** the same selections then go to the workspace's origin, so the
  `book trust provider` listing names each of your selections that would be routed there before you
  decide. An intentional `--model teamsrv/x` keeps working once `teamsrv` is approved.
- **A legacy `.bookrc.json` `baseUrl` is gated the same way.** It would receive `BOOK_API_KEY`, so
  it is ignored until `book trust provider .bookrc.json` approves it. Approving it makes the URL
  the default endpoint, so the listing names everything that is then sent there: `BOOK_API_KEY`,
  the requests and key of every provider with no `baseURL` of its own (by id, with the shape of its
  key reference), and every plain model id and every `<vendor>/<model>` id that names none of your
  providers. `BOOK_BASE_URL` is yours and is not gated.
- **`/advisor off` outranks a checked-in advisor, while one is declared.** When a checked-in
  `.book/settings.json` still declares an `advisorModel`, `/advisor off` also writes
  `advisorModel: "off"` to `.book/settings.local.json`, which resolves after it, so the
  repository's advisor does not come back at the next launch. `off` reads as "no advisor". The
  checked-in file is never edited. The `off` applies only while a checked-in layer declares an
  advisor: once the repository stops declaring one, the local `off` is ignored and your own value
  applies again. `/advisor <model>` clears it too.

```bash
book trust provider                    # list the providers awaiting a decision
book trust provider evil               # approve it, as declared now
book trust provider evil --reject      # refuse it, and stop being told about it
book trust provider --all-pending      # every provider awaiting a decision
book trust provider .bookrc.json       # a legacy baseUrl
```

All of them take `--workspace <path>`, and every command Book suggests (in the launch notices,
the refusal errors, the listing and `book doctor`) names the workspace whenever it is not the
current directory. A provider id is any key a repository writes, so it is quoted for your shell
when it is made of plain characters and a space; an id with anything else (`$`, a quote, a
backtick, `!`, `%`, `\`, a control character, a leading `-` or a non-ASCII letter) is never put on a
command line, and the suggested command is the listing instead. Print mode and the SDK report each
withheld provider, dropped override and ignored selection on stderr; the TUI shows the same lines in the transcript at launch,
and they are not saved to the session or sent to the model. `book doctor` lists every workspace
provider with its state (approved, rejected or not in effect), the dropped overrides and the
ignored selections. A provider you rejected is not reported again at launch.

Set `BOOK_HOME` to replace the default `~/.book` user-state root. This relocates user settings,
sessions, memory, managed-agent state and worktrees, jobs, rewind snapshots, telemetry, tool output,
learned context windows (`model-windows.json`), MCP configuration, and user-level skills, commands,
agents, and `AGENTS.md` discovery. Project-local `.book/` directories are unchanged.

### Learned context windows

When a provider refuses a request for exceeding its context limit, Book records a ceiling for that
model in `<BOOK_HOME>/model-windows.json` so the next session sizes compaction against a number the
provider has actually shown it will not exceed. The value is a fraction of the refused size, never
the refused size itself, and it only ever ratchets **down** — a later refusal at a smaller size
lowers it, a larger one does not raise it. It is never read from the workspace, so a repository
cannot declare a ceiling for a clone.

A window you declare yourself always wins: set `contextWindow` on the model in settings and nothing
is learned or applied over it. `book doctor` lists every learned window with how long ago it was
learned, and `/context` and the status line mark which source the current window came from
(`declared`, `learned`, `reported`, `family`, or `default`). To discard one, delete its entry from
`model-windows.json`, or delete the file to forget them all — it is rebuilt on demand.

Adding or refreshing models through `/model` against an Anthropic endpoint records each model's
reported `max_input_tokens` as `reportedContextWindow`, and every refresh updates it (or removes it
when the endpoint stops reporting one). Discovery never writes `contextWindow`. The order is: a
`contextWindow` you set yourself always wins; then a learned ceiling; then the reported window; then
the family table; then the default. A reported window is not a declaration, so an overflow can still
lower it by learning a ceiling, and `/context` shows its source as `reported`.

A save from `/model` (a new provider, a model added by hand, or a catalog refresh) writes your user
file, and replaces only the connection keys (`baseURL`, `baseUrl`, `apiKey`, `type` and `api`) of a
same-named entry in `.book/settings.local.json`, plus the local `model` when the save activates a
model. Per-model overrides in that entry (`contextWindow`, `maxOutputTokens`, `vision`,
`editFormat`, `effort`) are kept, so a `contextWindow` you set there survives a refresh.

A key update (`Alt+K` in `/model`, or `book config provider-key`) follows the same rule, narrower
still: it sets only `apiKey` on your user file's entry, leaving every other byte of it as it was,
and removes the connection keys of a same-named entry in `.book/settings.local.json`, so a stale
local key cannot look as though it overrides the new one. It leaves that entry's
`reportedContextWindow` and the local `model` alone, since no catalog was refreshed and no model
activated, and it never creates a local entry or file.

### The OpenAI Responses API

A `type: "openai"` provider speaks Chat Completions (`POST <baseURL>/chat/completions`) unless its
entry sets `"api": "responses"`, which switches it to OpenAI's Responses API
(`POST <baseURL>/responses`). Nothing else changes: the same key, model catalog, effort levels,
retry, redirect and stall policy, and the same tool calls, reasoning display and `/cost` figures.
Without the key, or with `"api": "chat"`, an entry behaves exactly as before, and a bare model id
on the default endpoint always uses Chat Completions.

```json
{
  "model": "openai/gpt-5",
  "provider": {
    "openai": {
      "type": "openai",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "{env:OPENAI_API_KEY}",
      "api": "responses"
    }
  }
}
```

Every Responses request sends `"stream": true` and `"store": false`: Book sends the whole
conversation each turn and never refers to an earlier response, so OpenAI keeps nothing. The system
prompt goes in `instructions`, and a chosen `effort` is sent as
`"reasoning": {"effort": <level>, "summary": "auto"}`, which is what makes the model's reasoning
summary stream into the transcript; no effort sends no `reasoning` object, as on Chat Completions.
`max` is sent as `xhigh`, the API's highest level. An endpoint that refuses the summary (an
organization OpenAI has not verified for reasoning summaries, or a compatible server without them)
gets the same request once more without it, so the reply arrives with no reasoning row.
Reasoning is replayed as text, the way the Chat Completions path does it, not as OpenAI's encrypted
reasoning items. An Anthropic entry ignores `api`.

### Sign in with ChatGPT (experimental)

Someone with a ChatGPT Plus or Pro plan can bill Book's requests to that plan instead of an API
account. The route is OpenAI's self-serve
[Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) for
open-source and locally hosted apps. It is **experimental** and **opt-in**: it is never
auto-detected, never a default, and nothing changes for a provider that uses an API key. Usage is
subject to OpenAI's terms and counts toward your plan's limits. You manage it, including a per-app
weekly cap, at [ChatGPT settings → Usage](https://chatgpt.com/settings/usage).

```bash
book auth login                 # sign in in the browser; records the plan's models
book --model chatgpt/<model>    # or choose a "ChatGPT plan (experimental)" row in /model
book auth status                # the sign-in on this machine; no network, no credential needed
book auth logout                # revoke the sign-in and delete its tokens
```

`book auth login` opens your browser, where you continue with ChatGPT and allow Book to use your
plan. It prints the sign-in URL too, so it also works over SSH: use `--no-browser`, or set
`$BROWSER` to choose the program. `$BROWSER` is read the way Python reads it: commands with
arguments, separated by `:` (`;` on Windows), where `%s` stands for the URL. When it finishes, it records the models your plan lists as a
provider entry in your user file (`<BOOK_HOME>/settings.json`), under `chatgpt` unless you
already have an entry of this type:

```json
{ "provider": { "chatgpt": { "type": "chatgpt", "models": { "<model>": { "label": "…" } } } } }
```

It never sets `model`. Only a session whose model is one of these entries (`chatgpt/<model>`) is
billed to the plan. A `type: "chatgpt"` entry always sends to `https://api.openai.com/v1` with the
Responses API and your sign-in, so it ignores `baseURL`, `apiKey` and `api`. To refresh the model
list, run `book auth login` again. Some things differ from an API-key provider:

- **Tokens never travel as keys.** The access token is read for each request and sent only on it,
  so no other provider or bare model id can inherit it. A chatgpt request never sends
  `BOOK_API_KEY` either. Book uses your sign-in only for an entry in your own settings: an entry
  that only a repository declares (`.book/settings.json`) is refused, even after
  `book trust provider` approves it.
- **Only you choose a plan model.** A `model`, `compactModel`, `advisorModel` or agent-profile
  `model` that a workspace layer (or a legacy `.bookrc.json`) sets to one of your chatgpt models
  is ignored, with a notice at launch and in `book doctor`. Your own value applies instead, or the
  default (`gpt-4o`) when you set none. If that leaves a run with no API key, the error names the
  ignored model. An agent definition or a delegated model id that names one is refused. Your own
  settings, `--model`, `BOOK_MODEL` and `/model` choose plan models as usual.
- **The plan route has its own request shape.** Every request sends `"store": false` and
  `"stream": true`, groups Book's tools in one namespace, and sends no `max_output_tokens`. So no
  output cap applies on this route: not one you set, and not the caps compaction and the advisor
  ask for.
- **No sign-in fails the request; Book never opens a browser for one.** Print mode and the SDK stop
  at startup with an error naming `book auth login`. The TUI starts, and each turn reports the same.
- **A plan limit stops the run** with "Usage limit reached", plus a link to ChatGPT's usage
  settings. Book doesn't retry it, and it never switches to your API key.

Under the hood:

- **Sign-in.** The first sign-in registers Book with OpenAI for this machine (dynamic client
  registration), and every later sign-in reuses that registration. Each attempt uses a fresh
  state, nonce and PKCE (S256) value, and the browser returns to a one-time listener on
  `http://127.0.0.1:<port>/auth/callback`. Book verifies the ID token against OpenAI's published
  keys (issuer, audience, expiry, nonce), and requires the plan scope `chatgpt.tokens.use.direct`.
  OpenAI identifies the machine by an opaque random host id (`urn:uuid:…`), never your email or
  account id.
- **Storage.** The registration, host id and tokens are kept in `<BOOK_HOME>/chatgpt-signin.json`,
  mode 0600, never in a workspace file. That is not the `auth.json` the removed 0.3 subscription
  login wrote, which `book doctor` still reports as a leftover to delete.
- **Refresh.** Access tokens last an hour, and Book refreshes them before expiry, or once when a
  request is refused with a 401. Refresh tokens rotate, so concurrent sessions refresh one at a
  time under a lock file, and a rotated pair is saved as soon as it arrives, even if the turn that
  asked for it is cancelled. A refresh token OpenAI reports as spent clears the tokens, and you
  sign in again.
- **Sign-out.** `book auth logout` revokes the refresh token with OpenAI and deletes the tokens. It
  keeps the registration, so the next sign-in skips registration. If OpenAI doesn't confirm the
  revocation, disconnect Book in ChatGPT Settings → Security and login → Sign in with ChatGPT.
- **Another account.** `book auth login --new-account` registers the machine again, to sign in
  with a different ChatGPT account, and revokes the account it replaces. A plain
  `book auth login` as a different account is refused instead of replacing the saved one.
- **Redaction.** The tokens are redacted from tool output like a provider key.
- **Doctor.** `book doctor` reports the sign-in on a machine that uses or configured it.
- **Testing.** `BOOK_CHATGPT_ISSUER` and `BOOK_CHATGPT_API_BASE` point the flow at a local test
  server, for tests only. Book accepts them only for a loopback address.

**There is no Anthropic sign-in, and there will not be.** Anthropic's
[terms](https://code.claude.com/docs/en/legal-and-compliance) forbid third-party apps from using
Claude Free, Pro or Max plan credentials, so Anthropic models in Book always use an API key.

### Prompt caching on OpenAI-compatible providers

On the Anthropic Messages API, Book places its own cache breakpoints: the last tool, the cached
system block, and the last message. On an OpenAI-compatible endpoint it sends no cache markers.
OpenAI and DeepSeek cache without them, and 9router's Claude routes place their own; a router that
needs a client's markers before it caches an Anthropic model (OpenRouter documents this) caches
nothing for Book today. What Book does on that path is read the cache counts a provider reports:
`prompt_tokens_details.cached_tokens`, DeepSeek's `prompt_cache_hit_tokens`, Moonshot's top-level
`cached_tokens`, OpenRouter's `cache_write_tokens`, 9router's `cache_creation_tokens`, DashScope's
`prompt_tokens_details.cache_creation_input_tokens`, and LiteLLM's top-level
`cache_read_input_tokens` / `cache_creation_input_tokens`. `/cost`, `/usage` and
`--max-budget-usd` then price cached input at the model's cache rates. A cache read on a model with
no listed cache-read rate is priced at its input rate, and a cache write with no listed rate at
twice it, the highest write premium a provider charges: both are upper bounds, so
`--max-budget-usd` keeps working.
A model priced by prompt length, such as `claude-haiku-5-5` (more above 100,000 prompt tokens), is
priced per request at that request's rate; where only summed tokens are known, it is priced at the
higher rate, which is also an upper bound.

**9router** (checked against 0.5.91): its Claude routes (`cc/claude-*`) do cache. 9router adds its
own breakpoints on the system prompt, the last tool and the last message, and drops the ones a
client sends. In a five-turn Book session on `cc/claude-opus-5`, all but about 1,000 of the
roughly 60,000 input tokens were read from or written to the cache upstream. 9router's streamed
usage reports neither count, though, and adds about 2,000 tokens to `prompt_tokens` on every
request. So Book shows every input token as uncached on those routes, and its dollar estimate runs
about three times the real cost. The real counts are on 9router's own usage dashboard. The `cmc/`
and `ag/` routes report no caching at all, and `prompt_cache_key` changes nothing on them.

## The sandbox

`sandbox.enabled` turns on the bubblewrap namespace `Bash` and `Check` commands run in. It
defaults to `false`, so nothing is sandboxed until you opt in. The rest of the family decides what
that namespace looks like and what happens to a command that cannot get one:

| key                         | default | meaning                                                                            |
| --------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `failIfUnavailable`         | `false` | fail the command when no backend exists, instead of running it                     |
| `allowUnsandboxedCommands`  | `true`  | allow a command to run outside the sandbox when it cannot be wrapped               |
| `autoAllowBashIfSandboxed`  | `true`  | skip the default permission ask for a genuinely sandboxed `Bash`                   |
| `excludedCommands`          | `[]`    | command patterns that run outside the sandbox on purpose                           |
| `filesystem.allowWrite`     | `[]`    | extra paths bound read-write inside the namespace                                  |
| `filesystem.denyWrite`      | `[]`    | paths made read-only where a command could write them; never made visible          |
| `filesystem.denyRead`       | `[]`    | paths masked entirely (directories) or unreadable (files)                          |
| `filesystem.allowGitWrites` | `false` | bind every git directory of the workspace read-only; true allows git writes        |
| `network.allowedDomains`    | `[]`    | not enforceable in bubblewrap; declaring any domain policy disables network access |
| `network.deniedDomains`     | `[]`    | not enforceable in bubblewrap; declaring any domain policy disables network access |

`allowUnsandboxedCommands: false` is the setting that refuses a command outright — it names the
setting and the reason rather than running the command anyway. Because `enabled` defaults to
`false`, that setting alone refuses everything until you turn sandboxing on too.

### A workspace layer may only tighten `sandbox.*`

A checked-in `.book/settings.json` is input from the repository, and so is a
`.book/settings.local.json` a clone was force-fed — `.gitignore` does not keep one out of a fresh
clone. So from **both** workspace layers these keys are honoured only in the direction that narrows
the sandbox:

| key                                | honoured from a workspace layer | ignored   |
| ---------------------------------- | ------------------------------- | --------- |
| `enabled`                          | `true`                          | `false`   |
| `failIfUnavailable`                | `true`                          | `false`   |
| `allowUnsandboxedCommands`         | `false`                         | `true`    |
| `autoAllowBashIfSandboxed`         | `false`                         | `true`    |
| `excludedCommands`                 | —                               | any value |
| `filesystem.allowWrite`            | —                               | any value |
| `filesystem.allowGitWrites`        | `false`                         | `true`    |
| `network.allowedDomains`           | —                               | any value |
| `filesystem.denyWrite`, `denyRead` | adds entries                    | —         |
| `network.deniedDomains`            | adds entries                    | —         |

The deny lists **accumulate** across layers like `permissions.deny`, so a project can add to your
`denyRead` without erasing it — a _trusted_ layer still replaces them, which is the one way to
narrow a list that turned out to be too broad. Set anything in the ignored column in
`~/.book/settings.json`, or pass it with `--settings`.

`enabled: true` is the one loosening-adjacent key a workspace layer may set, and it costs the
session its auto-allow: the loader pairs it with `autoAllowBashIfSandboxed: false`, because a
repository that could switch the sandbox on and stop the asking in one checked-in file would be
using the sandbox to authorize itself.

`book config set` and `/config` refuse a workspace write of an ignored value before it lands, and
they judge the **value**, not the key — so `book config set sandbox.enabled true --local` and a
`denyRead` entry are written while the ignored column is refused with the file it belongs in. The
refusal is scoped to the two workspace layers: the **user scope takes every value**, since
`<BOOK_HOME>/settings.json` is not repository input, so `book config set sandbox.enabled false` — what
that command targets by default — is written. `book doctor` lists every key a workspace layer asked
for and did not get, with the resolved path and a truncated value, and a print or SDK run reports the
same keys on stderr, reading both workspace layers and naming the file each one came from:

```
Ignored from /home/you/project/.book/settings.json: sandbox.enabled=false — workspace settings may only tighten the sandbox; set it in ~/.book/settings.json or pass --settings
```

The line about a workspace file turning the sandbox on is printed for the layer that actually flipped
`enabled` on. Once a trusted layer has enabled the sandbox, a checked-in `enabled: true` repeats a
decision you already made and costs nothing, so it is not reported as one the repository made.

### What is read-only inside the sandbox

The workspace is bound read-write, with exceptions for the files your machine itself acts on after
a command exits:

- `.book/` — read-only. When the directory does not exist, Book masks it with an empty read-only
  directory so a command cannot create it either. **That masking creates an empty `.book/`
  directory on your disk as a side effect** of running a sandboxed command in such a workspace.
- `.book/settings.local.json` — masked with a read-only `/dev/null`, so the provider credential it
  can hold is not merely unwritable inside the sandbox but unreadable.
- `.bookrc.json` — read-only when it exists. An absent file is left alone, since bubblewrap cannot
  mount a tmpfs over a file path.
- Every git directory of the workspace (`.git`, linked worktree admin directories, and submodule
  git directories) — bound read-only by default (issue 373). The directory is found by following
  a `.git` file (`gitdir: …`), a `commondir` file, `.git/worktrees/*`, and nested `.git/modules/*` —
  including a multi-segment submodule path whose git dir is at `.git/modules/libs/deep` under the
  container directory `libs` — so linked worktrees and submodules are covered as well as a plain
  repository. Candidates must look like a git directory (`HEAD` exists and either an `objects` directory
  or a `commondir` file exists); a pointer naming the workspace root or an ordinary directory does not
  bind it read-only. If a candidate that passes canonicalises to the workspace root itself, the sandbox
  refuses the run because the root cannot be made read-only without making the whole workspace read-only.
  A `core.hooksPath` naming a path inside the workspace stays read-only in both modes, and a git directory
  outside the workspace is left alone. This closes the pointer-file redirect gap where a command could
  create a file like `.git/commondir`. In read-only mode, each ancestor directory strictly between the
  workspace root and every protected mount is pinned with a writable self-bind (`--bind <dir> <dir>`).
  A pinned directory cannot be renamed or removed inside the sandbox (failing with `EBUSY`), which prevents
  renaming a parent directory to redirect a protected file or directory (such as `sub/.git`, `.husky/_`,
  or an included config). Sandboxed git writes (`git commit`, `git checkout`, `git add`, `git fetch`)
  fail with a note explaining that the repository's git directory is read-only inside the sandbox
  (`sandbox.filesystem.allowGitWrites` is off), advising the model not to retry the command or change
  settings itself, and directing the user to run it outside the sandbox or allow it in
  `~/.book/settings.json` (where `sandbox.excludedCommands` runs matching commands unsandboxed while
  `sandbox.allowUnsandboxedCommands` is true and `sandbox.filesystem.allowGitWrites` lets sandboxed git
  write again; workspace settings cannot enable either). Caveat: `git stash` in read-only mode fails
  silently with exit 1 and no output, so no note can match. A sandboxed `git worktree remove` deletes
  the work tree and then fails on its read-only admin directory; `git worktree prune` outside the sandbox
  cleans up.
- When `sandbox.filesystem.allowGitWrites: true` is set (the opt-out), the previous behaviour applies:
  git directories stay writable, and their `hooks/`, `config`, `config.worktree`, `commondir`,
  `gitdir` and work tree `.git` pointer files are bound read-only (masked when absent). In this mode
  only the **workspace's own top-level git directory** is pinned, with a read-write self-bind, so
  renaming or replacing it fails with `EBUSY` rather than redirecting the host's git. Pinning work tree
  directories is omitted here because doing so would make a sandboxed `git worktree remove` of an
  in-workspace worktree fail halfway, which is the reason this mode exists. Consequently, the rename gap
  remains open in opt-out mode: an ancestor directory holding a protected file can still be moved away.
- An `allowWrite` entry at or below a protected path is applied after the protection — an explicit
  opt-in — while a broader one stays ahead of it and cannot reopen the path. An `allowWrite` entry on
  a git directory reopens what it names, but not the control paths strictly below it (`hooks/`,
  `config`, `config.worktree`, `commondir`, `gitdir`, pointer files, or an included config or
  `core.hooksPath` directory inside the git dir), which stay read-only; an entry directly naming that
  control path (such as `<workspace>/.git/hooks`) still reopens it. A `hidden-file` mask is
  re-applied after every deferred opt-in so a trusted `allowWrite: ["<ws>/.book"]` cannot reopen
  `settings.local.json`.
- A **symlinked** control path — `.book`, `.git`, `.git/hooks`, `.bookrc.json`, or any path component
  strictly below the workspace root on the way to every protected mount (pointer files, hooksPath
  directories, included config files), discovered git directory, or pointer target — is
  **refused**, naming the path and saying the sandbox cannot protect a symlinked control path. A component
  that is a symlink is safe only if the link itself lives inside a present read-only directory mount
  (such as `.git/modules/x` inside a bound `.git` in read-only mode; refused in opt-out mode) or inside a
  `sandbox.filesystem.denyWrite` / `denyRead` directory (bound read-only or masked with tmpfs so changes
  cannot reach the host). Binding the target read-only is not enough: the link sits in the writable
  workspace, so `rm .book && mkdir .book` replaces it and every protection goes with it.
- A git config is read with a **1 MiB** cap. A config larger than that is refused rather than
  truncated, because a truncated read is a `core.hooksPath` past the cut that the namespace never
  saw. `[include]` and `[includeIf]` files are followed, relative to the including file's directory,
  and a followed file inside the workspace is bound read-only and parsed for `hooksPath` in turn.

**What this does not cover.** The pointer-file gap (`.git/commondir`) is closed by default because
every git directory is bound read-only; opting into `sandbox.filesystem.allowGitWrites: true` reopens
it. Still not covered: a nested repository that is not a submodule stays writable, a workspace with
no `.git` can still have one created by a sandboxed command (`git init` succeeds; its hooks only
become protected once Book sees the directory), a git directory outside the workspace is left alone,
and an `[includeIf]` condition whose target does not exist when the mounts are built is not followed,
so a file the sandbox creates later can carry a `core.hooksPath` the namespace never saw.

`Check` runs under the same decision as `Bash`: a check is a project-supplied command, so it is
sandboxed too, refused when unsandboxed commands are refused, and marked `[sandboxed]` in its
output.

## Example `.book/settings.json`

```json
{
  "model": "claude-opus-4-6",
  "compactStrategy": "summary",
  "compactModel": "9router/ag/gemini-3.6-flash-high",
  "advisorModel": "claude-opus-5-5",
  "effort": "high",
  "defaultMode": "default",
  "permissions": {
    "allow": ["Read(*)", "Glob(*)", "Grep(*)"],
    "deny": ["Bash(rm *)", "Write(.env)"]
  },
  "sandbox": {
    "enabled": false
  },
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash(*)", "command": "my-validator" }]
  },
  "memory": {
    "enabled": true,
    "autoSave": true
  },
  "ui": {
    "showThinking": true,
    "startupAnimation": true
  },
  "toolDiscovery": {
    "mode": "auto",
    "eagerToolCount": 10,
    "schemaTokenBudget": 8000,
    "maxLoadedTools": 15,
    "searchLimit": 5,
    "intentRouting": true
  },
  "toolExecution": {
    "maxConcurrent": 4
  },
  "agents": {
    "mode": "adaptive",
    "maxConcurrent": 3,
    "maxSpawned": 8,
    "maxDepth": 1,
    "persist": true,
    "includeUntrackedInSnapshot": true,
    "telemetry": true,
    "retentionDays": 30,
    "checks": {
      "test": "npm test",
      "typecheck": "npm run typecheck"
    },
    "checkTimeoutMs": 120000
  }
}
```

Memory lives in `<BOOK_HOME>/projects/<slug>/memory/` (`~/.book/projects/<slug>/memory/` by default), where `<slug>` is the path of the git repository root with path separators and any character other than letters, digits, `.`, `_` and `-` turned into `-`. A linked worktree uses its main checkout's root, and a workspace outside a repository uses its own path, so subdirectories and worktrees of one repository share one memory. A `.git` file counts as a linked worktree only when the main checkout lists it back, as `git worktree add` leaves it: its pointer names `<main>/.git/worktrees/<name>`, whose `gitdir` file names this `.git`; any other `.git` file (one copied from an archive, say) keys its directory by itself, as does a worktree moved without `git worktree move` until `git worktree repair` relinks it. On Windows nothing on a network (UNC) path is opened for this: a workspace on one keys by itself, as written; a `.git` that links to one keys the workspace by itself; and a `.git` whose git dir, `commondir` or worktree back-pointer is on one keys its own directory. A `.git` in your home directory itself (a dotfiles repository) does not count as a repository, so a project under your home without its own `.git` keeps its own memory; memory saved earlier under the home directory's key stays there and is not moved. A directory under the old, workspace-path key is moved there on first run. `memory.enabled` controls loading and reading the project memory index at session start (the first 200 lines or 25,000 bytes of `MEMORY.md`, with a warning line when it is cut); `memory.autoSave` controls whether the model may write memory: the model writes it with `Write`/`Edit`/`MultiEdit`/`ApplyPatch`, and with `autoSave` off those tools are refused in the memory directory ("memory is read-only in this session"), the prompt drops the save instructions, and the index still loads. A `deny` rule that covers a write to a memory file does the same to the prompt, for that rule's tools. Those are the only two memory keys.

Three memory keys were removed with the approval inbox, the external-content quarantine and background extraction: `memory.requireApproval`, `memory.quarantineExternal` and the `memory.extraction` block. They are no longer read. A settings file that still carries one loads without error, and `book doctor` names the key and what to do about it. A permission rule that names the retired `MemorySave` tool (`MemorySave`, `MemorySave(*)`) matches nothing now and is reported the same way; to restrict memory writes, write a rule on `Write`, `Edit`, `MultiEdit` or `ApplyPatch` for the memory directory, or set `memory.autoSave` to `false`. An `.inbox/` directory an old version left in the memory directory is not read or deleted.

`toolDiscovery.intentRouting` (default `true`) loads a deferred tool before a turn's first model call
when what you typed asks for it: a URL loads `WebFetch`, search intent `WebSearch` (see
[Tool discovery](tools-and-safety.md#tool-discovery)). It only loads tools the run already
authorizes, so any settings layer may set it.

`agents.checkTimeoutMs` caps one `Check` run (default 120 s, maximum 2 h). A check that exceeds it
is killed and reported as `check_timed_out` — explicitly _not_ as a failing check, so an agent does
not "fix" code that was passing. Raise it for repositories whose full suite runs longer than the
default; `npm test` here builds first and routinely does.

`agents.taskTimeoutMs` caps one foreground `Task` delegation. Precedence is `agents.taskTimeoutMs`,
then `BOOK_TOOL_TIMEOUT_MS`, then the 30 min default, and the host's backstop ranks them the same
way, so it always outlasts the ceiling. Both clocks start when the `Task` call does, so a slow
spawn (a worktree snapshot) counts against the ceiling instead of letting the backstop fire first
and lose the child's partial result. The registry's 120 s default assumed a fast model; on a
route where one max-effort turn takes minutes the child was cut off mid-survey, its result
discarded, and — because nothing stopped it — it ran and billed for an hour afterwards. When the
ceiling passes the child is now stopped, and the parent gets whatever the child had finished: its
last complete assistant text and its summary, both often empty when the ceiling lands mid-turn,
plus the agent id. The stopped child holds no further result, so there is nothing more to fetch.
Cancelling the parent stops the child too, including a cancel that lands while the child is still
being spawned.

The run `Task` waited on never comes back to the parent as a completion notification, stopped or
not: `Task` already returned its result, and the notification only made the parent run another
turn to re-read it. A later run of the same child does report back, because nothing is waiting on
it. That covers an `AgentSend` follow-up, a re-run after Book restarts, and a queued message
after a failed run.

## Cross-session messaging (experimental)

```json
{ "messaging": { "enabled": true } }
```

`messaging.enabled` (default `false`) gives each interactive TUI session an inbox that other Book
sessions on the same machine can deliver messages to (#620). **It is not usable yet**: this
release has the transport only, and the tools that send and the delivery into the conversation
come later. Print mode, the SDK and agents never open an inbox, and on Windows the setting starts
nothing yet.

The key is read **only from `~/.book/settings.json` (`<BOOK_HOME>/settings.json`) and a
`--settings` file**. It loosens what a session lets in, and a clone can force-add its own
`.book/settings.local.json`, so a value in either workspace file is ignored at any value, and
`book doctor` names the file. `book config set --project`/`--local` and `/config` refuse to write
it there.

With it on, the inbox is a socket (`0600`) in a private directory (`0700`):
`<BOOK_HOME>/socks/` when `BOOK_HOME` is set, otherwise `$XDG_RUNTIME_DIR/book-socks/` on Linux,
falling back to `<tmp>/book-socks-<uid>/` when that path is too long for a socket or the directory
is refused (a symlink, another user's, or inside a directory others can write without the sticky
bit). macOS has no system runtime directory, so `XDG_RUNTIME_DIR` is not used there, and the
sandbox keeps sandboxed commands out of `<tmp>/book-socks-<uid>/`. The key other sessions
authenticate with is a `0600` file beside the session's record in
`<BOOK_HOME>/live-sessions/`. Both go when the session ends. `book doctor` shows the socket
directory and whether it passes those checks. A session whose inbox cannot start shows one notice
and runs normally.

## Environment variables

| Variable                                                                                          | Purpose                                                                                    |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `BOOK_API_KEY`                                                                                    | Default API key (or `{env:VAR}` in provider settings)                                      |
| `BOOK_BASE_URL`                                                                                   | Default OpenAI-compatible base URL                                                         |
| `BOOK_MODEL`                                                                                      | Default model                                                                              |
| `BOOK_PROVIDER`                                                                                   | `anthropic` \| `openai` \| `auto`                                                          |
| `BOOK_EFFORT`                                                                                     | Thinking effort level                                                                      |
| `BOOK_HOME`                                                                                       | User-state root (default `~/.book`)                                                        |
| `BOOK_SHELL`                                                                                      | Shell for `Bash`: `bash`, `pwsh`, `powershell`, `cmd`, or a path                           |
| `BOOK_WORKSPACE`                                                                                  | Default workspace                                                                          |
| `BOOK_MAX_TOKENS` / `BOOK_MAX_TURNS`                                                              | Generation / turn limits                                                                   |
| `BOOK_COMPACT_MODEL`                                                                              | Model used only for compaction checkpoints                                                 |
| `BOOK_ADVISOR_MODEL`                                                                              | Model the `Advisor` tool consults (outranks `advisorModel`; see `/advisor`)                |
| `BOOK_RETRY_*` / `BOOK_REQUEST_TIMEOUT_MS` / `BOOK_STREAM_STALL_TIMEOUT_MS` / `BOOK_TOOL_RETRIES` | Retry and timeout tuning                                                                   |
| `BOOK_THINKING_STALL_TIMEOUT_MS` / `BOOK_FIRST_DELTA_STALL_TIMEOUT_MS`                            | Stall ceilings while a model thinks, and before a stream's first delta                     |
| `BOOK_TOOL_TIMEOUT_MS` / `BOOK_TOOL_TELEMETRY_DIR`                                                | Tool timeout (`Bash` included) and telemetry location                                      |
| `BOOK_WEB_ALLOW_HTTP`                                                                             | Opt into plain HTTP for `WebFetch` (disabled by default)                                   |
| `BOOK_WEB_ALLOW_PRIVATE_NETWORK`                                                                  | Opt into local/private web destinations for every `WebFetch` (disabled by default)         |
| `BOOK_WEB_MAX_REDIRECTS`                                                                          | Same-origin redirect limit for `WebFetch` (default 5, maximum 10)                          |
| `BOOK_TUI_RENDERER`                                                                               | `safe`, `incremental`, or experimental scroll renderer                                     |
| `BOOK_INK_OUTPUT_CACHE`                                                                           | `off` disables the cross-frame row cache of Ink's output, which is on by default           |
| `BOOK_INK_RENDER_CULL`                                                                            | `off` draws transcript rows outside the viewport as before; skipping them is on by default |
| `BOOK_INK_FRAME_CLIP`                                                                             | `off` stops cutting frame rows at the terminal width, a safety net that is on by default   |
| `BOOK_STARTUP_ANIMATION`                                                                          | Startup splash on or off; outranks `ui.startupAnimation`, as `BOOK_MODEL` does for `model` |
| `BOOK_SESSION_DRIVER`                                                                             | `human` or `agent`, over `CLAUDECODE`/`AI_AGENT`; agent-driven runs save learnings only    |
| `BOOK_DEBUG` / `BOOK_DEBUG_UI` / `BOOK_DEBUG_RENDER` / `BOOK_DEBUG_FLOW`                          | Debug logging flags                                                                        |
| `BOOK_DEBUG_FILE` / `BOOK_DEBUG_STDERR` / `BOOK_DEBUG_MAX_BYTES` / `BOOK_DEBUG_BACKUPS`           | Debug log destination and rotation controls                                                |

`BOOK_STARTUP_ANIMATION` holds wherever the effective settings are read, not only at startup:
`book config get ui.startupAnimation` and `book config list` report the value in force and name the
variable as its source, and the settings a provider removal re-reads keep it. It is never written
into a settings file, so `/config` says the variable decides at every launch when the row is toggled
while it is set — the saved value applies once it is unset.

`WebFetch` requires HTTPS by default, validates DNS results and the address used by the network
connection, blocks private/special-use destinations, and stops on cross-origin redirects so the
new origin receives its own permission decision. A cross-origin redirect is reported before its
target is resolved, since that target is one the model did not ask for: following it is a new
`WebFetch` with its own decision. When the checks that need no lookup (scheme, plain HTTP,
credentials, a local name or a private address literal) already refuse the target, the model is
told not to follow it, and a target's credentials or a non-web URL are never shown. It returns
Markdown by default; `format` can be `markdown`, `text`, or sanitized `html`. `WebSearch` works
without configuration through the built-in Exa MCP provider and accepts optional `limit`,
`domains`, `recencyDays`, and `country` hints. Its provider endpoint is built in and cannot be overridden through settings or environment
variables.

An IPv6 address in one of these IPv4-embedding ranges is judged by the IPv4 address it carries:
IPv4-mapped `::ffff:0:0/96`, SIIT's IPv4-translated `::ffff:0:0:0/96`, IPv4-compatible `::/96`,
NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, and Teredo `2001::/32`, where either the server or the
client address being private blocks it. An ISATAP address (interface identifier `0:5efe` or
`200:5efe` followed by an IPv4 address, RFC 5214) is refused when that IPv4 address would be
refused, whatever its prefix, except under Teredo's `2001::/32`, where that part of the address is
the Teredo client. In the local-use NAT64 prefix `64:ff9b:1::/48`, an address laid out like the /96 (bits
48-95 zero) is judged by its last 32 bits, and any other shape is blocked, because where its IPv4
bits sit depends on a prefix length only the local network knows.

So on a network whose NAT64 uses another layout inside `64:ff9b:1::/48`, such as the prefix
`64:ff9b:1:fffe::/96`, every address in it is refused, public or not, and `WebFetch` cannot reach
IPv4-only sites through DNS64 there. Book has no setting that names the local prefix: decoding by a
configured prefix would turn a wrong setting into a way past the policy, for a layout few networks
use. The only way through is `BOOK_WEB_ALLOW_PRIVATE_NETWORK=true`, which turns the private-network
check off for every destination. A network-specific NAT64 prefix outside `64:ff9b::/96` and
`64:ff9b:1::/48` (RFC 6052) is not recognized either: an address in it is judged as plain IPv6,
whatever IPv4 host it reaches.

The TUI defaults to the full-frame `safe` renderer on Windows to avoid ConPTY footer corruption
during deep transcript scrolling. Other interactive terminals default to `incremental`. Set
`BOOK_TUI_RENDERER=incremental` to opt into incremental rendering explicitly on Windows.

## Themes

Book uses the `rubric` theme by default. It is set like a rubricated manuscript: the body is in ink (warm ivory and greys), and one cinnabar red is kept for the marks you navigate by. Those marks are the `>` that opens each of your turns and prompts the composer, the pilcrow `¶` that heads a decision prompt, the section sign `§` before a heading, list markers, the drop cap on an empty page, and the ink of Book's spinner: a quill that writes a flourish, `∞`, dot by dot while the agent works, the ink fresh in red at the nib and drying to grey behind it. The agent writes in ink, so red never reads as an alarm. Errors are rose and warnings amber, to stay distinct from the rubric.

The layout follows the same idea. Your turns hang a red `>` in the margin and are set upright in the brightest ink, a step above the agent's prose, with one blank row before each new turn in the default density (tight density, on a short terminal, keeps none). The composer and the menus that open above it are drawn as hairlines rather than boxes. Tables are ruled the way a book sets them, with no vertical lines. The status line carries a folio, the turn count in lowercase Roman numerals, at its right edge. An empty session opens on a title page: a five-row drop cap B in rubric, the rest of the word, a rule and a table of contents. The contents list this workspace's five most recent sessions as chapters, with Roman numerals, dot leaders and each one's age where a book prints the page, and `/resume` opens one. Before a first session, the contents list what a new reader needs, with the key to press as the page. When a menu shrinks the transcript, the page folds to its drop cap and never cuts through a glyph. Decision prompts such as the permission prompt are headed by a rule led by a `¶` rather than drawn as boxes.

A turn is drawn as a list of items with one blank row between them. Every item opens on one mark in the margin, `●`, whose colour carries its state: green for a call that finished, rose for one that failed, amber while it waits for your approval or when it was skipped, grey for a folded run of reads or a call Book refused before it ran, and blinking while it runs. No row carries a check or a cross. A call is headed `Name(argument)`, as in `Bash(npm test)` or `Read(src/config.ts)`; a search is a `Search`, an edit an `Update` and a new file a `Write`. Its result hangs under it after `⎿`, in words and with no timings: `Read 40 lines`, `Found 67 matches`, `Added 1 line, removed 1 line`, `Wrote 5 lines`. A command shows its first line of output instead, then `… +N lines`. The sentence the agent says before acting is the caption of the call under it, in the secondary grey with no mark and no blank row between them, so the final answer, which opens on its own `●` once it settles, is the only full-ink text in a turn. A sentence whose only call updated the plan is a step too once more work follows it in the same turn. One that closes the turn, or that hands it back to you (a question, plan approval, a memory save), keeps its blank rows and its full ink.

The transcript keeps the agent's reading out of the way. In the default compact transcript, a run of read-only calls (`Read`, `Glob`, `Grep`, the git read tools, `ToolSearch`, task lookups, `BashOutput`, session history) collapses into one grey item, `● Search(memory), Read(2 files)`, with the files it read under `⎿`. A call Book refused before it ran (a tool name nothing answers to, or arguments that did not parse or fit the tool's schema) is the model's slip rather than an event in your workspace, so its mark is grey too; a command that ran and failed is rose. Only the failure's mark and its `Error:` label take the rose; its message and output keep the result's grey. A failure opens on `Error: exit N` or on the first line of its message, and a failed command shows its last 4 lines under `… +N lines (Ctrl+E)`. When it also printed to stdout, the footer says how many rows Ctrl+E then draws for it (a line of spaces is a row; an empty line, such as the one after a final newline, is none): after those lines (`… +N lines of output (Ctrl+E)`), or, when stderr cuts lines of its own, joined to their count above them (`… +2 lines, +1 line of output (Ctrl+E)`). Stdout with no text in it is not named, and neither is stdout that is shown as the detail because stderr says nothing: it is empty or only whitespace, so the message is only `Exit code: N`. Expanding the row (Ctrl+E, or Ctrl+O then Ctrl+E) shows the whole output, and a line wider than the row continues on the rows below it instead of being shortened as `… 1 long line shortened (Ctrl+E)` says. A call the model addressed with a namespace (`default.Bash`, `functions.Read`) runs, and is shown, as the tool it names. The run can span one parallel batch or several turns in a row, and the model's reasoning before each call does not break it; only prose between calls starts a new one. The compact transcript draws no thought at all: not behind a call, not before an answer, and not while one streams. Ctrl+O's detailed transcript and screen-reader mode show every thought, and `ui.showThinking: false` hides them everywhere. A `Bash` command folds like a read when Book can prove it harmless from its text alone: `cat`, `head`, `tail` (never following), `bat` (only with `--paging=never`), `sed -n`, `rg`, `grep`, `ag`, `find` without actions, `fd`, `ls`, read-only `git`, and the same joined by `|`, `&&`, `;` with small formatters such as `wc` or `head` after a pipe. Read-only `git` is `git status`, `log`, `diff`, `show`, `grep` and `ls-files`, and `git branch` in its listing forms (no branch name, and none of `-d`, `-m`, `-c`, `-f`, `--set-upstream-to` and the like; `--list` with a pattern is fine), behind only `-C <dir>`, `--no-pager`, `-P` and `--no-optional-locks`. `git -c`, `--git-dir`, `--work-tree`, `--exec-path`, any `--output`, `git grep -O`, a `--format` or `--pretty` that asks for a signature (`%G?`), an alias and every other subcommand keep their row. `git grep` counts as a search on its pattern, `git ls-files` as a listing, and the rest as lookups named by the subcommand (`git status`); a `-C` directory and every pathspec or path operand must stay inside the workspace. `ack` does not fold: it reads a project-level `.ackrc`. A command Book cannot prove read-only keeps its own row: any redirection, `$` expansion, backticks, background `&`, wrapper (`sudo`, `xargs`, `bash -c`), mutating flag (`sed -i`, `find -delete`, `rg --pre`), pager (`bat --pager`), follow mode (`tail -f`, `tail +1f`), glob that could expand to `..` (`.*/x`), or option that names a file outside the workspace (`rg --ignore-file`, `find -newer`, `du --files0-from`). A command that outlived its timeout and was moved to a background shell keeps its row too. Edits, other `Bash` commands, web and MCP calls, delegation, failures (a read-only command that failed, was blocked or timed out included; `git diff --exit-code` exiting 1 is a failure), a `BashOutput` read of a shell that exited non-zero, anything awaiting permission, background commands, and reads or commands that reach outside the workspace keep their own rows. A diff has one line-number column and no rail. A new file previews its first 5 lines, and in the compact transcript an edit previews up to 12 rows of its changes with one line of context around each, its footer giving the total as `… N lines hidden (Ctrl+E)`; a change that spans several files previews from the top, every row under its file's name, and ends in `… +N lines (Ctrl+E)`. The detailed transcript shows a change-focused preview of up to 80 rows instead, with two lines of context. In the compact transcript Ctrl+E shows the whole output of the running tool while a turn is in progress, else of the row you clicked while it is still cut, else of the newest row on screen whose preview hides lines (a diff, an output, or a failed command's error or stdout); each press then moves up to the next truncated row, and only that row's footer names the key (`… +140 lines (Ctrl+E)`, the others `… +140 lines`). Ctrl+O's detailed transcript shows every call, and so does screen-reader mode. A row you have expanded is never folded.

The ink itself is tuned for a long read: on a dark terminal the body text sits at about 12:1 rather than near-white, the headings and your own prompt are brighter than the body, and inline code takes a warm tone rather than a cool hue.

The agent's plan is not a standing block. While a step is in flight, the working line names it and the status line shows `step 3/7` beside the folio. Each TodoWrite item in the transcript names the step it started and where the plan stands (`● Steps(Fix the parser)` with `⎿  2 of 7 done` under it). Scrolling back shows how the plan moved. Ctrl+T opens the whole list as a `§ Steps` sheet, marked `◌` to do, `◔` in hand and a grey `✓` done, and Ctrl+T closes it again. A bare `/task` shows your own task list.

Two other built-in palettes use the same layout. `folio` swaps the red for a single gilt accent and uses it on the spinner as well. `apple` is the previous palette: near-black neutral surfaces, bright grey text, a blue composer and user accent, cyan for the agent, and a distinct hue per role. Select one with `"theme": "folio"` or `"theme": "apple"` in `settings.json`. A palette changes colours only: the layout above applies to every theme.

Project themes can override any token in `.book/themes/<name>.json`, starting from `rubric`:

```json
{
  "brand": "#AFC19D",
  "userAccent": "#D3A17E",
  "surface": "#20221D",
  "surfaceActive": "#30362B",
  "border": "#4B4D45",
  "selectionText": "#F3EEE4",
  "assistantAccent": "#AFC19D",
  "toolRail": "#6B7164"
}
```

A theme that sets `text` but not `userText` uses its `text` for your prompt too.

## Tool-use telemetry

When `observability.toolTelemetry` is enabled (default), Book appends one JSON line per finalized tool call to `~/.book/telemetry/tool-use.jsonl` (override the directory with `BOOK_TOOL_TELEMETRY_DIR`). Each record captures the canonical tool, the final status the model saw, a derived `isFailure` flag (`error`/`timed_out` only — permission blocks, plan-mode blocks, user declines, and cancellations are never counted as failures), the error code, duration, retries, model, the session it ran in (`sessionId`, the stored session id, which a subagent shares with its parent; `session` is the trace id of the session runtime in this process, shared by every run while the session is open and new each time it is reopened with `--resume`), and subagent attribution. The write is best-effort and off the hot path; it never blocks or fails a session, and the active log is size-rotated into a single `.1` backup.

`book tool-stats` reads this log and reports, per tool, calls / failures / fail rate / p50 / p95 duration / retry rate, plus a per-model split and the most frequent error codes:

```
$ book tool-stats
Tool use — 1,204 calls across 37 sessions (2026-06-30 → 2026-07-27)
18 failed (1.5%)

TOOL          CALLS   FAIL   FAIL%      P50      P95   RETRY%
Bash            412     12    2.9%    120ms    2.1s      4.4%
ApplyPatch      210      4    1.9%     38ms    140ms     5.7%
Read            402      0    0.0%     15ms     34ms     0.0%
```

Use `--json` for a machine-readable aggregate, `--since <days>` to change the window, `--all` for full history, and `--prune` to drop records older than the window from disk. `observability.toolTelemetryRetentionDays` sets the default reporting window and the `--prune` target; disk use is otherwise bounded by log rotation. Records store outcomes and hashes only, never prompts or file contents. This is separate from the ephemeral in-session counters shown by `/usage`.
