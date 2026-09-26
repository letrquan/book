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
| `key <name>...` | `enter esc tab shift-tab up down left right backspace space ctrl-c ctrl-d ctrl-e ctrl-j ctrl-l ctrl-o ctrl-r ctrl-t ctrl-u home end pageup pagedown`, and `alt-<key>` (ESC then the key: `alt-a`) |
| `sleep [ms]`, `resize <cols> <rows>` | Timing and layout. |
| `screen`, `raw`, `shot <name>` | Dump the screen to stdout, dump the raw tail, or write the screen to `<shots>/<name>.txt`. |
| `shotpng <name>` | Write the screen with colours and attributes kept, as `<shots>/<name>.html` and, via headless Edge or Chromium, `<name>.png` — which the Read tool can look at. The only way to judge a visual change (palette, weight, spacing): a text `shot` shows none of it. Block elements and rules are drawn edge to edge the way a terminal draws them, so a seam in the PNG is a real seam. |
| `rawbytes [n]` | Print the last `n` (default 3000) bytes of the PTY stream JSON-encoded, escapes kept — the only faithful record of what the renderer emitted when the xterm replay looks wrong. |
| `status` | Print whether the TUI process has exited, its exit code and the time, without sending a key: how a script tells "that press exited" from "that press only armed". |
| `quit` | Ctrl-C twice and wait for exit. |

Options: `--mock` (start the mock provider), `--mock-script <json>`, `--mock-port` (8919), `--sessions` (keep session persistence on, so sessions pre-seeded in `<book-home>/.book/sessions/*.jsonl` show on the title page and in `/resume`; a seeded file needs a `session_meta` line whose `cwd` is the workspace normalized as the store does it, lowercase on Windows, plus at least one `user` record, because the store recounts messages from the records),
`--workspace <dir>`, `--book-home <dir>` (default: a fresh temp dir, removed when the driver exits
unless it holds managed-agent worktrees or background jobs, which outlive Book; pass one to seed it
or read it afterwards — the driver never removes a home it was given), `--shots <dir>`
(`/tmp/book-shots`), `--cols` (120), `--rows` (40), `--timeout` (20000), `--ready-settle` (2500),
`--send-gap` (250), `--bin <exe>` (spawn another executable — the Go build's `bin/book.exe` — in
place of `node dist/index.js`, with the same flags; under `--mock` the `BOOKGO_*` variables are set
beside the `BOOK_*` ones). The driver sets `USERPROFILE` as well as `HOME` to the throwaway home:
on Windows `os.homedir()` and Go's `os.UserHomeDir()` read `USERPROFILE`, and with `HOME` alone the
driven binary found the developer's real `~/.claude/skills`.

`--chunk-delay-ms <n>` is forwarded to the mock, which then waits `n` ms before each streamed delta
(every 12-character content piece, and the tool call), so a reply arrives as a paced stream and the
TUI renders it frame by frame; the default, 0, sends everything back to back as before. It applies
to every turn, the reducer's matched checkpoint included, which is how a `/compact` is made to last
long enough to press keys during it. A scenario turn's own `"chunkDelayMs"` overrides it for that
turn, so a long history can arrive at once while only the turn under test is paced. To freeze one
frame of a stream, such as the live tail at an exact cutoff, end the turn's `text` there and add
`holdMs`.

The driver turns the startup splash off with a `--settings` layer of its own (a temp file holding
`ui.startupAnimation`), which outranks every settings file; it never writes the workspace's
`.book/settings.json`, and a value an older driver left there cannot win. `--startup-animation`
sets the layer's value to `true`, so the splash can be driven. A `--settings <file>` of your own
after `--` is merged into that layer, its keys winning (a file the driver cannot read fails the run
at once; the driver prints which temp file holds the merge, since Book's settings errors name it);
`--no-settings` after `--` skips every layer, the driver's too; `--bin` gets no layer (the Go build
reads a flat `startupAnimation` key).
The splash replaces the input bar that `ready` waits for, so such a script starts with `sleep` (the
splash plays for about three seconds) and a key that dismisses it.

A mock that exits before it is ready (a port another process holds, a bad `--mock-script`) fails the
driver at once with the mock's own error, instead of after a 10 s wait. The mock stops writing to a
response Book has closed (Esc, a timeout) and says so on stderr:
`mock-provider: chatcmpl-mock-3 closed by the client after 14 chunks; stopped`.

`--record <file>` writes every PTY chunk with its arrival time, as JSON, when the driver exits: the
input to `record-gif.mjs` below.

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
before every tool call. `"tools": [{...}, {...}]` in place of `tool` sends several calls in one
turn, the way a model that batches parallel reads does. `"thinkMs": 1500` holds a turn before its
first delta, the way a real model pauses to think, so the working spinner stays on screen. `"holdMs": 9000` keeps a turn open after its text is on the wire, which is
the only way to see the live (unsettled) rendering of a streaming message or a child's detail view
long enough to screenshot it. A reply's text may cite the events Book showed the reducer:
`{{event:N}}` becomes the Nth `session://current/event/<id>` reference in the request's last user
message, so a scripted `ConversationCheckpointV2` can carry sources the host's validator accepts
even though message ids are minted at runtime (a `match` turn on `BEGIN HISTORICAL EVENTS` with such
a `text` is how the fitter is exercised end to end; the deferred-compaction judge's prompt is matched
on `BEGIN CHECKPOINT UNDER REVIEW`). The mock reports `prompt_tokens: 100` on every reply, so Book's
usage-triggered compaction never fires against it; pass `--mock-usage-from-estimate` to the driver
(`--usage-from-estimate` to the mock) to report its own chars/4 estimate instead, then a model with
a small `contextWindow` in `<book-home>/.book/settings.json` of a `--book-home` you seed (the
driver sets `BOOK_HOME` to `<book-home>/.book`) and a couple of long replies put a request over the
threshold.

Three provider failure shapes can be scripted, one per turn. `{ "status": 503, "body": "…" }` answers
with that HTTP status and body instead of a stream (a router wrapping an upstream 4xx; the next
request consumes the next turn, so a retry is scripted as the turn after it). A text turn may carry
`"finishReason": "content_filter"`, or `"usage": { "prompt_tokens": 0, "completion_tokens": 0,
"total_tokens": 0 }` to override the usage block — the tell of a router that rendered an upstream
error as content. Count requests in the `.requests.jsonl` to tell "retried" from "not retried".

A tool turn may carry `"rawArguments": "<text>"` in place of `arguments`. The string is then sent
verbatim as the call's arguments, which is how a scenario reproduces the malformed JSON a real model
sometimes emits, such as an unescaped backslash or newline inside a string. Write such a scenario
with an editor, not a shell heredoc, since a heredoc eats backslashes.

### `smoke.sh` — the end-to-end check

`bash .claude/skills/run-book/smoke.sh` boots the real TUI against the mock and drives one full
flow — prompt, tool call, permission dialog, approval, file written on disk — and exits non-zero on
any failure. Run it after changing anything on that path. It listens on `BOOK_SMOKE_PORT` (8919)
and first checks the port is free, so a port another process holds (another smoke run included)
stops it with a message before it touches anything. Each run gets a fresh `mktemp` workspace and
scenario, removed when it passes and kept (the path is printed) when it fails; `BOOK_SMOKE_WS`
names a workspace of your own instead, which is emptied first and kept. Screens go to
`BOOK_SMOKE_SHOTS` (`/tmp/book-shots-<port>`). It kills no process itself: the driver kills the one
mock it started whenever it exits, a console Ctrl-C included (and SIGTERM or SIGHUP on POSIX). A hard kill of the driver (on Windows, `kill` and `process.kill` are
one) skips its handlers and orphans the mock; stop that one by its PID. Never clear a port with
`pkill -f mock-provider` or a `taskkill` by image name: on a shared machine the other mocks belong to
other runs.

### `record-gif.mjs` — a GIF or a screenshot from a recording

`node .claude/skills/run-book/record-gif.mjs <rec.json> <out.gif|out.webp|out.png> [options]`
replays a `--record` file into headless xterm, samples it at `--fps` (12), draws each distinct
screen the way `shotpng` does, screenshots the frames with headless Edge or Chromium, and joins them
with sharp. Identical frames merge into one longer frame and a pause is cut to `--max-hold` ms;
`--end-hold` sets the last frame's. `--start-at <regex>` starts at the first screen that matches,
and `--until <regex> --after <ms>` stops that long after one does. A `.png` output is the final frame
alone, which is how a screenshot of an exact moment is taken: `--until "Permission required"
--after 2000`. `--rows a:b` crops to screen rows a..b-1 (negative counts from the bottom), and
`--title <text>` adds a window title bar. Chunks less than 6 ms apart are applied together, so a
frame the renderer wrote in pieces is never sampled half-drawn.

### `readme-media.sh` — the README's GIF and screenshots

`bash .claude/skills/run-book/readme-media.sh` rebuilds `docs/media/`: it writes a small demo project
(`weather-api`, a config loader with a real bug and a test that catches it), drives the hero
session in `demo/hero.json` + `demo/hero-drive.txt` and the add-provider wizard in
`demo/add-provider-drive.txt`, and renders `demo.gif`, `title-page.png`, `permission.png`, and
`add-provider.png`. Everything runs in a temp workspace and BOOK_HOME, on `BOOK_MEDIA_PORT` (8931).
Run it after a change to how any of those surfaces look, then look at every image before committing
it: a still is one frame, and a timing bug can land in it.

## Traps the scripts do not cover

- **`--bin` replays without `convertEol`.** xterm.js with `convertEol: true` turns a bare LF into
  CRLF. Bubble Tea's renderer moves the cursor down with bare LFs (column kept), so every first
  body line of a tool row replayed at column 0 — a "missing indent" that does not exist in a real
  terminal. The driver passes `convertEol: !BIN`; Ink never emits a bare LF as cursor motion, so the
  TS build is unaffected either way. A second limit: the inline renderer's print-above of content
  taller than the screen (CSI L after homing) does not replay faithfully in headless xterm.js —
  judge such screens by `rawbytes` or a live terminal, not by `shot`.
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
  `--workspace`. `--book-home` already defaults to a temp dir, removed on exit.
- **Two settings shapes make Book refuse to start**, and the PTY just times out: `provider.<id>.models`
  is an object keyed by model id, not an array, and a model's `effort` is `false | {default, levels}`,
  never `true`. The validation error is on the first frame — read the timeout's last-screen dump
  before assuming the probe is wrong.
- **Reproduce any hazard in a fresh session.** Multi-step probes carry over kill-ring, composer
  contents, and permission rules; use distinct strings (`AAA` / `BBB`) so "applied twice" and "wrong
  value" look different.
