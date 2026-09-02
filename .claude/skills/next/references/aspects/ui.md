# Aspect: UI/UX

Question the interface, don't audit it. The discipline is Apple's: step back from the implemented
surface and ask whether it should exist in this form at all. Fixing a misaligned row is board
work; this aspect exists to notice that the row is noise. The expected finding is a subtraction —
"this picker shouldn't exist", "these two overlays are one thing", "this prompt should be a
default" — not an addition.

## Scope

Everything the owner sees and touches in a session: the transcript, composer, pickers and
overlays, the status line, permission prompts, the `/command` surface, the color and glyph
vocabulary, and print-mode output framing. Rendering-correctness bugs are board candidates, not
aspect findings — cite one here only as evidence that a surface is overbuilt.

## One surface per run

Pick exactly one surface and go deep. Choose by, in order: the surface dominating recent
`src/tui/` hotspots or repeated `CHANGELOG.md` fix entries (repeated fixing is the smell of a
surface fighting its own design); then the surface longest unexamined. Name the choice and the
reason before reviewing it.

## Evidence

- Real TUI first: run the built binary in a scripted PTY and look at actual frames. Stripped PTY
  logs are presence-only evidence — they hide cursor movement, so layout claims need frame
  replay, not grep.
- This skill cannot build that harness mid-review (it writes nothing but the refresh doc). Use a
  PTY setup only if one already exists in the session or repo; otherwise go straight to the
  fallback rather than improvising one.
- The fallback: critique from the component source, `src/tui/layout.ts`, and snapshot tests —
  and label every visual claim `unobserved`.
- Quote what the user actually sees, never the JSX that produces it.

## The questions

Ask in order, and answer by counting, not describing:

1. What is the user trying to DO here? One sentence, naming no UI element. Every later judgement
   is against this sentence.
2. If this surface could show only one thing, what would it be? What currently competes with it?
3. What can be removed outright? Each element justifies itself against the task sentence, not
   against "someone might want it".
4. Could two surfaces be one? Could a prompt be a default? A choice the user makes repeatedly
   with the same answer is a wrong default wearing a preference's clothes.
5. Is state visible without asking? Anything the user must remember or query, the surface has
   failed to show.
6. Does it look designed? One alignment grid, one glyph vocabulary, one accent logic. Count the
   distinct colors and glyph families on screen and justify each.
7. Would you demo this surface unprompted?

## Findings

A removal, a merge, or a default replacing a prompt is a first-class candidate and must not be
down-ranked for adding no capability. Every finding states a countable before/after on the chosen
surface: keystrokes to complete the task, decisions forced on the user, elements or lines on
screen, distinct colors/glyphs, or things that must be read before acting. A finding with no
count is an observation, not a candidate.

## Output

Produce 0-3 candidates in ranking.md's block form with `aspect: ui`, tiered honestly: a surface
that misleads, buries state, or forces a repeated decision breaks the surface's implicit promise
(T2); pure polish is T3. Zero candidates is a valid result — say the surface passed and which
question came closest to failing.
