---
name: run-book
description: Build Book by running Book, and prove a change works in the real TUI. Carries the project mandate — new features are implemented by driving Book as the coding agent, not by hand-editing `src/`, and no change is done until it has been watched in the interactive TUI — plus the toolkit that satisfies it: a PTY driver, a mock OpenAI-compatible provider, and an end-to-end smoke test that boot the real CLI and drive it with scripted keystrokes. Load before implementing any new feature or behavior change in Book, before claiming a change works, and whenever evidence about the TUI (rendering, the transcript grid, streaming, status, overlays, key handling) is needed. Also use to run, drive, screenshot, or smoke-test the Book CLI.
---

# Building Book with Book

New Book features are built by **running Book**, not by editing the source directly. Drive it with
`npm run dev` or a built/linked `book` binary and hand it the task; `--print` mode is convenient for
driving it non-interactively. Hand-editing `src/` is the fallback for what Book cannot yet do to
itself, not the default way work gets done here.

**Print mode alone does not finish the job — watch the change in the TUI.** The TUI is the primary
mode and shares almost none of the print path: rendering, the transcript grid (`src/tui/layout.ts`),
streaming updates, status, overlays, and key handling are exercised nowhere else. A change can pass
`npm run check` and behave correctly under `--print` while the interactive surface it touches is
misaligned, silent, or throwing. So open the feature in the TUI and watch it run before calling it
done, and treat what you see there as first-class evidence. A print-only session has established
nothing about the TUI.

Defects Book shows during that work are in scope. Fix them, or file them, before the feature counts
as done; a feature branch is expected to carry both the feature and the incidental fixes found while
building it. A blocker that stops Book from doing the job at all outranks the feature that exposed
it.

The reason is that this project's north star is whether Book is good enough to use instead of Claude
Code, and that cannot be answered from outside. The failures that decide it only surface in real
multi-turn use — a settings layer that bricks startup, a stall ceiling tuned for chat rather than for
a thinking model, a flag that is parsed and then discarded — and none of them are visible to code
review.

## The two halves

1. **Build**: Book is the agent. `npm run dev` (or a linked `book`) against a real provider, given
   the task. This is the half that needs credentials and cannot be mocked — a scripted model does
   not write the feature.
2. **Verify**: the real TUI, driven and read back. This half needs no credentials and no real model;
   use the scripts below. Script only the model's decisions — the TUI, the tools, the network call
   and the rendering all stay real.

## Toolkit

Everything lives beside this file. Prerequisites: `npm run build` (the driver runs `dist/index.js`,
not `src/`) and a built `node-pty` (`npm rebuild node-pty` if it errors on load).

### `driver.mjs` — spawn the TUI in a PTY and script it

Commands come from stdin or `--script <file>`, one per line, as a batch rather than a REPL, so a
whole flow is one Bash call. Exit code is 0 only if every command succeeded, which makes any script
double as a test.

```bash
node .claude/skills/run-book/driver.mjs --mock <<'EOF'
ready 30000
shot 01-boot
send hello
wait MOCK-OK @30000
shot 02-reply
quit
EOF
```

| Command | Effect |
| --- | --- |
| `ready [ms]` | Wait for the input bar, then settle. **Always start here** — the placeholder renders before Ink's stdin handler is live, and keystrokes sent earlier are swallowed. |
| `wait <regex> [@ms]` | Wait for a match on the rendered screen. |
| `waitraw <regex> [@ms]` | Same, against the raw stripped-ANSI stream. |
| `expect <regex>` | Assert the current screen matches now; fail otherwise. |
| `send <text>` | Type text, then submit. Writes the text and `\r` as separate PTY reads — one chunk would be parsed as a paste and the submit dropped. |
| `type <text>` | Type without submitting. |
| `key <name>...` | `enter esc tab shift-tab up down left right backspace space ctrl-c ctrl-d ctrl-r ctrl-l ctrl-o pageup pagedown` |
| `sleep [ms]`, `resize <cols> <rows>` | Timing and layout. |
| `screen`, `raw`, `shot <name>` | Dump the screen to stdout, dump the raw tail, or write the screen to `<shots>/<name>.txt`. |
| `quit` | Ctrl-C twice and wait for exit. |

Options: `--mock` (start the mock provider), `--mock-script <json>`, `--mock-port` (8919),
`--workspace <dir>`, `--book-home <dir>` (default: a fresh temp dir), `--shots <dir>`
(`/tmp/book-shots`), `--cols` (120), `--rows` (40), `--timeout` (20000), `--ready-settle` (2500),
`--send-gap` (250).

### `mock-provider.mjs` — a provider without an API key

Book refuses to start without `BOOK_API_KEY`, and a real key costs money and makes runs
non-deterministic. This serves the OpenAI-compatible SSE subset that
`src/provider/openai-compatible.ts` consumes, replying with a scripted sequence — turn N answers the
Nth request, the last turn repeats forever. Every request is appended to a `.requests.jsonl` so you
can assert on what Book actually sent.

```json
[
  { "tool": { "name": "Write", "arguments": { "file_path": "smoke.txt", "content": "hi\n" } } },
  { "text": "Wrote the file. DONE" }
]
```

A turn with both `text` and `tool` streams the text first and the tool call after it on the same
turn — how a router that inlines reasoning delivers the `<think></think>` a thinking model emits
before every tool call. `"holdMs": 9000` keeps a turn open after its text is on the wire, which is
the only way to see the live (unsettled) rendering of a streaming message or a child's detail view
long enough to screenshot it.

### `smoke.sh` — the end-to-end check

`bash .claude/skills/run-book/smoke.sh` boots the real TUI against the mock and drives one full
flow — prompt, tool call, permission dialog, approval, file written on disk — and exits non-zero on
any failure. Run it after changing anything on that path.

## Traps the scripts do not cover

- **Most tools are deferred.** A direct call to an inactive tool returns `status:'blocked'` /
  `code:'tool_not_active'`. Script a `ToolSearch` turn first. Book's `ToolSearch` takes only `query`
  (no `select:` syntax, closed schema — an extra argument is rejected), matched against the keywords
  in `src/tools/catalog.ts`.
- **The transcript renames things.** `WebFetch` renders as **`Fetch`**, and `status:'blocked'`
  renders as **`skipped`** (`src/tui/tool-presentation.ts`). Grepping for a canonical tool name
  reports false while the row is plainly on screen; a "skipped" row means refused, not absent.
- **A stripped-ANSI log is presence-only evidence.** It hides cursor moves, so any claim about
  layout or alignment needs replayed frames — `replayTerminalOutput` in
  `src/tui/terminal-screen.ts`, which is what `shot` already uses.
- **Probes write real state.** A permission granted during a run lands in the
  `.book/settings.local.json` of whatever workspace you pointed at, so pass a throwaway
  `--workspace`. `--book-home` already defaults to a temp dir.
- **Two settings shapes make Book refuse to start**, and the PTY just times out: `provider.<id>.models`
  is an object keyed by model id, not an array, and a model's `effort` is `false | {default, levels}`,
  never `true`. The validation error is on the first frame — read the timeout's last-screen dump
  before assuming the probe is wrong.
- **Reproduce any hazard in a fresh session.** Multi-step probes carry over kill-ring, composer
  contents, and permission rules; use distinct strings (`AAA` / `BBB`) so "applied twice" and "wrong
  value" look different.
