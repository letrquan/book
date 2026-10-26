# Tool deferral plan

Status: **owner decisions recorded 2026-10-25** (§6); PR 1 not started. It is split out of
`plans/cross-session-messaging-plan.md` §4.4, because deferral affects every tool and both provider
paths.

The problem: the owner has seen models fail to find `WebFetch` and `WebSearch`. The root causes
are in Book's design, and they hit weaker models hardest:

- the model is never told which tools exist;
- a model that does know a tool's name is refused until it searches;
- every activation throws away the prompt cache.

## 1. How Book defers today

| Fact                                                                                                                                                                                                                                                                                                                                                            | Where                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `toolDiscovery.mode` defaults to `auto`. That means deferring once there are more than `eagerToolCount` tools (default **10**), or once their schemas exceed the budget. The default registry has about 50 tools, so **deferral is always on**.                                                                                                                 | `src/tools/catalog.ts:404–415`, `src/settings.ts:390–396`                   |
| The core set is `ALWAYS_CORE` (Read, Glob, Grep, AskUserQuestion, TodoWrite, ToolSearch), `MUTATION_CORE` (ApplyPatch, Write, Edit, MultiEdit, Bash), `MANAGED_TASK_CORE`, and the runtime shell tools. **Everything else is deferred**, including WebFetch, WebSearch, every Git tool, Task, the Agent tools, NotebookEdit, SessionHistory, and all MCP tools. | `catalog.ts:28–31`, `exposureFor` at `catalog.ts:120`                       |
| **The model sees category counts, never names**: "N authorized tools are deferred: git (6), web (2), … Call ToolSearch when the active tools do not cover the task." The text sits in the uncached system suffix, and the counts change on every activation.                                                                                                    | `catalogSummary`, `catalog.ts:666–691`; `src/agent/context.ts:638`          |
| ToolSearch scores each word of the query against names (weight 4), aliases (3), keywords (2), and descriptions and categories (1), with Fuse.js as a fallback. Matches load "on the next model turn".                                                                                                                                                           | #283 (fixes #265 and #270); `src/tools/tool-search.ts`                      |
| **Direct calls are refused**: a call to an authorized tool that has not been activated fails with `tool_not_active`, even when the model knows the name and arguments. That costs a round trip.                                                                                                                                                                 | `canExecute` / `isActive`, `catalog.ts:626–655`                             |
| **The budgets hit small-context models**: `schemaTokenBudget` is `min(8000, max(1000, 5% of context))`, so a 32K model gets 1,600 tokens. `maxLoadedTools` is 15 and evicts least-recently used. When nothing fits, ToolSearch fails with `tool_discovery_budget_exceeded`.                                                                                     | `effectiveBudget`, `catalog.ts:208–215`; `trimLoaded`, `catalog.ts:427–444` |
| **Every activation breaks the cache**: an activation or eviction rebuilds the provider's tools array for the next request. The Anthropic provider sends no `defer_loading`. On Anthropic the tools come first in the cached prefix, so the whole conversation is billed again as a cache write. OpenAI-style prefix caches also start at the tools (inferred).  | `activeDefinitions()`, `src/agent/loop.ts:1324`; grep of `src/provider/`    |

## 2. How Claude Code 2.1.310 does it

Observed in the binary. The evidence and offsets are in `plans/cross-session-messaging-plan.md`
§1.11.

- **Names are listed.** A meta user message (`deferred_tools_delta`) names every deferred tool:
  "The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded …
  Use ToolSearch with query `select:<name>[,<name>...]`". Later deltas announce tools that are now
  available or no longer available. Because it is a message, not system-prompt text, it never
  touches the cached prefix.
- **Exact selection**: `select:A,B` loads tools by name. Keyword search is the fallback.
- **The tools array stays fixed on the Anthropic API.** Deferred tools are sent with
  `defer_loading: true` and surfaced by `tool_reference`, so a discovery never rewrites `tools[]`.
  The `claude-api` skill confirms that discovered schemas "are appended to the request, not
  swapped - this preserves the prompt cache".
- **Direct calls are refused here too** ("calling them directly will fail with
  InputValidationError"). Even CC's own `claude-api` skill carries a recovery line: "If you
  cannot call WebFetch yet and ToolSearch is among your tools, call ToolSearch with
  `select:WebFetch` first; of the tools it loads, call only the one named exactly `WebFetch`."
  So models stumble on this in CC as well.
- **The harness routes some intents itself**: `@session` mentions name `SendMessage` and the
  exact `select:` query (`peer_mention`).

## 3. Evidence from Book's own sessions

Searched on 2026-10-25 with read-only scanners:

- the 89 local Book sessions in `~/.book/sessions` (2026-09-30 → 2026-10-25);
- the 44 sessions on zain-1 (back to 2026-09-18);
- the 368 Terminal-Bench `agent/book.jsonl` trajectories on zain-1 under `~/bench-harbor/jobs`;
- the Claude Code transcripts in `~/.claude/projects`.

- **Before #283 (zain-1, 2026-09-18 → 09-24)**, natural queries matched nothing:
  - "git checkout branch status" (category `git`);
  - "spawn explorer agent for repository research" (category `agents`);
  - even the exact name `AgentSpawn`, with category and namespace `agents`.

  Each returned `No authorized deferred tools matched`. These are the misses #265 and #270 fixed.

- **After #283, every ToolSearch for a web tool found it.** The models were
  stealth/space-bunny-alpha, Sonnet 5.5, Opus 5.5, Muse Spark and Gemini 3.8 Flash. They used
  queries such as "fetch web page url" and "web search".
- **But each success cost a full extra turn.** Every web use began with a ToolSearch call, and on
  Anthropic models that rewrote the cache.
- **Muse Spark's first call was `ToolSearch {}`**, with empty arguments, as in #403.
- **Models that never ask fall back to `curl` in Bash** instead of `WebFetch`. One example:
  MiniMax M3.1 Flash, 2026-10-24, read npm download counts this way.
- **No `tool_not_active` or `tool_discovery_budget_exceeded` refusal for a web tool** appears in
  any local or zain-1 session.
- **Terminal-Bench trajectories** (stealth/space-bunny-alpha, 1,098 transcript files across 368
  trials):
  - Web tools: ToolSearch ran in 23 trials, WebFetch in 16 and WebSearch in 15. All 14 web-word
    queries matched, for example "web fetch url download" and "fetch web page URL huggingface".
  - **The misses were for capabilities Book doesn't have**: "transcribe audio speech to text",
    "view image render picture vision ocr", "huggingface leaderboard dataset rows API", and
    "spawn subagent agent" in a run with agents off. Each cost a turn, and the model learned only
    "No authorized deferred tools matched".
  - **The direct-call refusal happened**: two trials (`protein-assembly`, `sanitize-git-repo`)
    called `AgentSpawn` without searching first and got
    `Tool "AgentSpawn" is not active for this turn`. That is the round trip §4.3 removes.
- **Not reachable**: the Windows machines (`desktop-2eudst4`, `lap`) were offline.

Reading:

- No surviving session shows a web tool that was searched for and not found. The miss the owner
  remembers fits the pre-#283 matching failures (late September), or a session on a machine that
  couldn't be scanned.
- Today's failures are structural:
  - every deferred tool costs an extra turn and, on Anthropic, a cache rewrite;
  - a known name is refused until the model searches;
  - weak models silently fall back to `curl`;
  - searches for capabilities Book doesn't have spend a turn to learn nothing. Listing the names
    (§4.1) answers those up front.

## 4. Proposed design

1. **List deferred tools by name.**
   - Each name gets a hint of eight words or fewer: about 5 tokens a tool, or about 250 tokens
     for 50.
   - The list includes every _authorized_ deferred tool, whether or not it is active, so an
     activation never changes it.
   - It stays in the uncached system suffix. It changes only when authorization changes: the
     mode, a skill restriction, or an agent role.
2. **Add `select:Name[,Name…]` to ToolSearch.** Exact names skip scoring, and the catalog text
   teaches the syntax, as CC does.
3. **Run a direct call to an authorized deferred tool just in time.**
   - If the arguments validate against the tool's schema, Book runs the call and activates the
     tool, instead of refusing with `tool_not_active`.
   - If they don't validate, the error carries the schema, so the next call can succeed.
   - Authorization is unchanged: role, capability rules, permission mode and hooks all still
     apply. Only the extra search step is skipped.
   - This helps most for weak models that name `WebFetch` from training.
4. **Route intent in the harness** before a turn's first model call:
   - a URL in the user's message activates `WebFetch`;
   - "search", "look up", "latest", "news", "tìm" or "tin tức" activates `WebSearch`;
   - `@session` activates `SessionSend` (messaging plan PR 3).

   It is never worse than a ToolSearch activation, and it saves the turn.

5. **Keep the tools array stable.**
   - **Anthropic**, on models with the mid-conversation tool-change beta
     (`mid-conversation-tool-changes-2026-07-01`: Opus 5, Opus 5.5, Opus 4.8, Fable 5 and 5.1,
     Mythos 5 and 5.1, Sonnet 5.5; not Sonnet 5; not on Foundry, per the `claude-api` skill):
     - send every authorized tool from the first request, with `defer_loading: true` on the
       deferred ones;
     - surface an activation as a `tool_addition` (`tool_reference`) in an appended system
       message.
   - **Other Anthropic models and OpenAI-compatible endpoints**:
     - make activation append-only: no LRU eviction during a session;
     - batch activations, so the array changes at most once a turn.
   - **Experiment, not default**: returning a schema in the ToolSearch result and letting the
     model call a tool that isn't declared. Strict function calling on some endpoints rejects
     undeclared names, so this needs a probe per provider first.
6. **Retune the core set and budgets from eval data.**
   - Candidates for core: `WebFetch` and `WebSearch` (small schemas, often needed), and
     `SessionList`/`SessionSend` when messaging is on.
   - Give the 5%-of-context floor a minimum of the largest single deferred schema, so a 32K model
     can always load at least one tool.

## 5. PRs

1. **Names and `select:`** (§4.1–4.2): the catalog renders every authorized deferred name, stable
   across activation. Includes unit tests, and a prompt-snapshot test that activation leaves the
   text unchanged.
2. **Just-in-time execution** (§4.3): `canExecute` admits an authorized, valid call and activates
   the tool; an invalid one gets a schema-bearing error. A permission-matrix test proves no mode
   or rule gets looser.
3. **Intent routing and the eval harness** (§4.4, and §4.6's measurement):
   - Tasks that each need one deferred tool: fetch a URL, search the web, read git history, edit a
     notebook, search session history.
   - Models: weak (MiniMax M3.1 Flash, Muse Spark, Gemini 3.8 Flash, Haiku 5.5) and strong
     (Sonnet 5.5, Opus 5.5).
   - Arms: today's behaviour, then names added, then just-in-time execution, then routing.
   - Metrics: success, turns to the first correct call, `curl` fallbacks, wasted calls, and the
     Anthropic cache-read ratio.
4. **Stable tools on Anthropic** (§4.5): `defer_loading` plus `tool_addition` on supported
   models, append-only activation elsewhere, and no mid-session eviction.
5. **Retune core and budgets** (§4.6) from PR 3's numbers.

Each PR updates `docs/guide/tools-and-safety.md` (the tool discovery section) and
`docs/guide/configuration.md` (`toolDiscovery.*`), plus `CHANGELOG.md`.

## 6. Owner decisions (2026-10-25)

1. **Just-in-time execution of authorized deferred tools (§4.3): yes.**
2. **Anthropic mid-conversation tool-change beta where the model supports it (§4.5): yes.**
3. **Promote `WebFetch`/`WebSearch` to core: deferred.** Decide on the PR 3 eval numbers.
4. **Who writes the code: Claude agents**, not Book in print mode. Each PR still has to be watched
   in the real TUI (`run-book` skill) before it is called done.
5. **Eval budget**: still open. Estimate the cost of the strong-model arms before running them.

## 7. Unknowns

- Whether OpenAI-compatible routers (9router, OpenRouter, DeepSeek) cache the tools prefix the way
  Anthropic does. If not, activation churn costs them little, and §4.5 matters mainly for
  Anthropic.
- How an undeclared-tool call behaves on each OpenAI-compatible endpoint (the §4.5 experiment).
- Whether listing 50 names makes weak models call tools they don't need. The PR 3 eval measures
  wasted calls.
