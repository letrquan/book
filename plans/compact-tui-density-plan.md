<!-- Hallmark pre-emit critique: P5 H5 E5 S5 R5 V4 -->

# Plan: Compact TUI Density Without Losing Polish

- **Date:** 2026-07-18
- **Status:** Implemented
- **Scope:** `src/tui/` visual layout and render tests only
- **Goal:** Increase useful transcript rows while preserving Book's color, hierarchy, borders, responsive behavior, and accessibility.

---

## Outcome

Make compact rhythm the default, not a narrow-terminal fallback. The new UI should use color, indentation, rules, and typography for hierarchy instead of repeated blank rows.

Primary targets:

- Recover 6-8 transcript rows by removing the conversation banner and compressing fixed bottom chrome.
- Reduce a simple user/assistant exchange from roughly 7 framing rows to 3-4 rows, excluding wrapped content.
- Keep semantic separation inside Markdown, but remove trailing and duplicated blank rows.
- Keep the full bordered input because it is a strong part of the TUI's visual identity.
- Preserve screen-reader order, terminal-width safety, and all interaction behavior.

## Current State

The excess spacing is cumulative rather than caused by one component:

| Surface | Current cost | Source |
| --- | ---: | --- |
| Conversation banner | 7 rows | Six-line `AsciiBanner` plus `marginBottom={1}` in `ChatPanel.tsx` |
| Turn separator | 3 rows | Separator row plus top and bottom margins |
| One-line user message | 3 rows | `paddingY={1}` in `UserMessage.tsx` |
| User-to-assistant transition | 1 row | `marginTop={1}` in `ChatPanel.tsx` |
| Markdown paragraph | 1 trailing row each | Per-paragraph `marginBottom={1}` |
| Markdown heading | 2 extra rows each | Both top and bottom margins |
| Idle bottom chrome | 5 rows | Three-row bordered input plus two-row bordered status |
| Active bottom chrome | 6+ rows | Separate working indicator above the idle chrome |
| Pickers and prompts | 2+ outer rows | Repeated `marginY={1}` plus internal section margins |

The UI already has good polish primitives: theme tokens, single/round borders, restrained animation, responsive width handling, truncation, and explicit screen-reader paths. The implementation should preserve those and change only density and information packing.

## Design Rules

1. **Compact is the baseline.** Do not add a settings toggle in the first release.
2. **One containment layer.** Keep a border where it identifies an interactive surface; remove outer blank margins around that border.
3. **No trailing whitespace.** Components may insert separation between blocks, never after their final block.
4. **Use hierarchy before whitespace.** Brand color, dim text, indentation, and rules should carry distinctions that currently depend on blank rows.
5. **Keep semantic gaps.** Separate true Markdown paragraphs and major block transitions; do not separate every render token uniformly.
6. **Height and width are different concerns.** Existing `compact` props mostly mean narrow-width copy. Introduce a separate vertical density model rather than overloading them.
7. **Accessibility does not get denser by omission.** Screen-reader output stays flat, explicit, and complete even when visual chrome is reduced.

## Target Layout

### Conversation

```text
Current                                  Target

[six-row BOOK banner]                    [banner only on empty welcome]
[blank]
-- 10:42 --------------------             -- 10:42 --------------------
[blank]                                   user message on one tinted row
[user padding row]
  user message                            assistant content starts next row
[user padding row]                          tool summary
[blank]                                      | expanded output
  assistant content
  tool summary
```

### Bottom chrome

```text
Current                                  Target

working indicator                        working indicator
+----------------------------------+      +----------------------------------+
| > prompt                         |      | > prompt                         |
+----------------------------------+      +----------------------------------+
------------------------------------      model | tok 9% | default
model | tokens | mode
```

The input remains a polished three-row box. The status becomes one row with no extra border because the input border already separates the transcript from the fixed footer.

---

## Implementation Plan

### Phase 1: Add row-budget tests before changing layout

**Files:**

- Modify `src/tui/components/ChatPanel.render.test.tsx`
- Modify `src/tui/components/MarkdownBlock.test.tsx`
- Modify `src/tui/components/StatusLine.test.tsx`
- Modify `src/tui/components/InputBar.test.ts`
- Add `src/tui/components/UserMessage.test.tsx`

Add stripped-frame helpers that count rendered rows and assert display width. Cover representative frames at 120x32, 80x24, 48x16, and screen-reader mode.

Required baseline/target assertions:

- A populated `ChatPanel` does not render the six-row ASCII banner.
- A one-line `UserMessage` renders in one row at standard widths.
- A simple user/assistant exchange keeps one deliberate separator row and stays within the agreed row budget.
- A single Markdown paragraph has no trailing blank row.
- Two Markdown paragraphs have one intentional separator row in compact mode.
- Heading/body, paragraph/code, code/paragraph, list/paragraph, and table/paragraph transitions have deterministic gaps.
- `StatusLine` stays one row, including near-limit and active states.
- `InputBar` remains exactly three rows and within terminal width.

Do not snapshot ANSI color codes. Assert content order, row count, border shape, and display width after stripping ANSI.

### Phase 2: Introduce a vertical density model

**Files:**

- Add `src/tui/density.tsx`
- Add `src/tui/density.test.ts`
- Modify `src/tui/app.tsx`

Create a small `DensityContext` with a default that keeps isolated component tests working:

```ts
export type TuiDensity = 'compact' | 'tight';

export interface DensityMetrics {
  panelMarginY: 0;
  turnMarginY: 0;
  userPaddingX: 1;
  userPaddingY: 0;
  headingGapBefore: 0 | 1;
  majorBlockGap: 0 | 1;
}
```

Policy:

- `compact`: default at normal terminal heights.
- `tight`: selected when terminal height is below 18 rows; it removes optional labels/help rows but does not remove required content.
- Existing `isNarrow`/`compact` width behavior remains separate for truncation and shortened copy.

Provide `resolveTuiDensity(rows)` and `useDensity()` so components do not invent their own height thresholds.

### Phase 3: Compact transcript turns

**Files:**

- Modify `src/tui/components/ChatPanel.tsx`
- Modify `src/tui/components/UserMessage.tsx`
- Modify `src/tui/components/AgentMessage.tsx`
- Modify `src/tui/components/AsciiBanner.tsx` only if its API needs an explicit welcome-only variant

Changes:

1. Render `AsciiBanner` only inside `WelcomeScreen`; remove it from populated conversations.
2. Make `TurnSeparator` one row with no top/bottom margins. Keep the timestamp and dim rule so turn boundaries remain visible.
3. Change user-message padding from `paddingX={2} paddingY={1}` to density-driven horizontal padding and zero vertical padding.
4. Keep one assistant `marginTop` row after a user message so the tinted user block remains visually distinct.
5. Keep assistant content and tool calls indented so role distinction survives without blank rows.
6. Remove `ThinkBlock`'s unconditional bottom margin; let Markdown block-gap logic decide the transition after it.

Expected result at 80 columns:

- First one-line user message: 1 row.
- User-to-assistant separator: 1 row.
- One-line assistant response: 1 row.
- Subsequent turn separator: 1 row.
- No additional decorative blank rows beyond the user-to-assistant separator.

### Phase 4: Replace per-token Markdown margins with adjacency spacing

**Files:**

- Modify `src/tui/components/MarkdownBlock.tsx`
- Modify `src/tui/components/markdown-layout.ts`
- Modify `src/tui/components/markdown-layout.test.ts`
- Modify `src/tui/components/MarkdownBlock.test.tsx`

Add a pure helper such as `markdownBlockGap(previousType, nextType, density)` and insert spacers only between meaningful neighboring tokens.

Recommended compact gap matrix:

| Previous -> next | Gap |
| --- | ---: |
| paragraph -> paragraph | 1 |
| paragraph/list -> heading | 1 |
| heading -> paragraph/list | 0 |
| paragraph/list <-> code/table/blockquote | 1 |
| list item -> list item | 0 |
| any block -> end of message | 0 |

Implementation details:

- Remove `marginBottom={1}` from paragraphs and tables.
- Remove both margins from heading renderers; spacing comes from the parent adjacency pass.
- Remove the language-label `marginBottom={1}` inside code blocks so code begins immediately below its label.
- Filter `space` tokens before gap calculation so blank source tokens do not double the visual gap.
- Preserve code/table borders and heading chrome; those are polish, not wasted space.
- Verify nested lists and blockquotes do not inherit a full top-level gap for each child token.

This phase is the highest regression risk because Markdown wrapping and nested token recursion are already heavily tested. Keep the gap helper pure and test it independently.

### Phase 5: Pack tool activity more efficiently

**Files:**

- Modify `src/tui/components/ToolCallBlock.tsx`
- Modify `src/tui/components/AgentMessage.tsx`
- Modify `src/tui/components/ToolCallBlock.test.tsx`
- Modify `src/tui/components/ChatPanel.render.test.tsx`

Changes:

1. Keep collapsed tool calls at one row.
2. Put successful file mutation stats inline when they fit: `Update(src/a.ts) +12 -3 240ms`.
3. Fall back to a second indented line only when width calculation says the inline form will wrap.
4. Remove the orphan `|` row before Markdown-like expanded output; the first output row should immediately follow the summary.
5. Reduce expanded-detail indentation from four columns to two where it does not conflict with diff gutters.
6. Keep nested-agent depth visible, but use one column per depth in visual mode and the existing flat path for screen readers.
7. Preserve error, pending, duration, retry, and truncation information; density must not hide state.

### Phase 6: Reduce fixed footer height

**Files:**

- Modify `src/tui/app.tsx`
- Modify `src/tui/components/StatusLine.tsx`
- Modify `src/tui/components/WorkingIndicator.tsx`
- Modify `src/tui/components/StatusLine.test.tsx`
- Modify `src/tui/components/WorkingIndicator.test.tsx`

Changes:

1. Remove the top border from `StatusLine`; the input box already supplies the separator.
2. Guarantee one status row in every state. Near-context warnings replace lower-priority segments instead of adding a second row.
3. Keep working/retry/permission/plan activity in `WorkingIndicator` directly above the input bar so the animated state remains visually prominent.
4. Keep `StatusLine` reserved for persistent metadata rather than mixing transient activity into the footer.
5. On narrow widths, prioritize status metadata in this order: mode, context warning, model, token details, tasks, cost.
6. Keep the three-row bordered `InputBar` unchanged in Phase 1 of the rollout. Revisit a two-row editor only if row-budget testing shows the footer is still too tall.

Target fixed height:

- Idle: 4 rows total (3 input + 1 status).
- Working/retrying: 5 rows total, preserving the dedicated animated activity row.
- Command/file menu: menu rows plus the same 4-row footer.

### Phase 7: Compact secondary panels and prompts

**Files:**

- Modify `src/tui/app.tsx`
- Modify `src/tui/components/CommandMenu.tsx`
- Modify `src/tui/components/FileMentionMenu.tsx`
- Modify `src/tui/components/ModelPicker.tsx`
- Modify `src/tui/components/SessionPicker.tsx`
- Modify `src/tui/components/PermissionButtons.tsx`
- Modify `src/tui/components/PlanApprovalButtons.tsx`
- Modify `src/tui/components/TaskList.tsx`
- Modify `src/tui/components/CompactDiffCard.tsx`
- Modify related component tests

Apply the same containment rule consistently:

- Remove outer `marginY={1}` from bordered panels.
- Remove internal `marginTop={1}` when a heading, border, or color already separates sections.
- Collapse multi-line keyboard help into one responsive footer line; hide only redundant help in `tight` density.
- Keep selected-row backgrounds, border colors, risk colors, and focus/navigation behavior.
- In permission prompts, place the title and tool summary on one line when width permits; keep warning text on its own row.
- Make compact-result cards use a one-line success/error state after their reveal completes.
- Remove one of the two stacked margins in `app.tsx` help/status/skills panels.

Do not remove borders from interactive modal/picker surfaces. Their containment is functional and should remain visually distinct from transcript content.

### Phase 8: Tighten the welcome screen without flattening it

**Files:**

- Modify `src/tui/components/WelcomeScreen.tsx`
- Modify `src/tui/components/WelcomeScreen.test.tsx`

Changes:

- Keep the ASCII banner on the empty state only.
- Remove the duplicate standalone `BOOK` label below the banner in the wide layout.
- Limit wide welcome content to banner + tagline + workspace/model/mode + one command-hint row.
- Keep compact welcome to four rows and tiny welcome to three rows.
- Retain brand color and one restrained reveal sequence; do not add new motion.

### Phase 9: Validate and tune

Run:

```powershell
npm install
npm run typecheck
npm test -- src/tui/components/ChatPanel.render.test.tsx
npm test -- src/tui/components/MarkdownBlock.test.tsx
npm test -- src/tui/components/StatusLine.test.tsx
npm test -- src/tui/components/InputBar.test.ts
npm test
npm run bench:ui
npm run format:check
npm run lint
```

`node_modules` is not present in the current worktree, so dependency installation is required before implementation validation.

Perform manual terminal checks at:

- 120x32: full desktop terminal.
- 80x24: primary acceptance viewport.
- 48x16: narrow/short split terminal.
- 36x12: tiny fallback.
- Screen-reader mode with reduced motion.

Check idle, streaming, retry, expanded tool output, permission prompt, plan approval, model picker, command menu, and context-near-limit states.

---

## Acceptance Criteria

- Populated conversations never show the ASCII banner.
- A one-line user message occupies one visual row at 80 columns.
- A plain one-line assistant message has no trailing blank row.
- A simple completed user/assistant exchange uses no more than four framing/content rows before the next turn.
- Markdown has no trailing spacer and no double spacer between adjacent blocks.
- The input and status area uses four rows while idle and five rows while working.
- Expanded tool output begins directly below its summary without an empty rail row.
- Bordered pickers/prompts have no outer blank row unless clipping safety requires it.
- All rendered lines stay within terminal width at 36, 48, 80, and 120 columns.
- Screen-reader output retains all labels, warnings, choices, and content in logical order.
- Existing keyboard navigation, permission resolution, plan approval, scrolling, retry, and wrapping tests continue to pass.
- UI benchmark shows no meaningful render regression from density context or Markdown adjacency calculation.

## Rollout Strategy

Implement in three reviewable batches:

1. **Transcript density:** Phases 1-5. Largest visible gain with limited interaction changes.
2. **Footer density:** Phase 6. Keep the dedicated activity row while compacting the persistent status footer.
3. **Secondary surfaces:** Phases 7-9. Consistency pass and full validation.

Keep each batch behaviorally complete and testable. Do not mix density changes with theme, copy, command behavior, or agent-loop changes.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Markdown blocks visually merge | Use a tested adjacency matrix rather than globally setting every margin to zero |
| Ink wraps an inline status/tool row | Precompute display width and retain a second-line fallback |
| Footer state loses important warnings | Keep transient activity in its dedicated row and test status priority independently |
| Small terminals become unreadable | Use `tight` only for optional chrome; never omit core content or actions |
| Screen readers lose context when visual labels are removed | Preserve dedicated screen-reader branches and add order assertions |
| Broad snapshot churn hides regressions | Assert row budgets and semantic content instead of large ANSI snapshots |
| Density context causes rerender churn | Keep the context value memoized and dependent only on terminal height class |

## Non-Goals

- No color palette or typography changes.
- No new user-facing density setting in the first release.
- No change to transcript scrolling or clipping architecture.
- No change to agent logic, command behavior, permissions, or provider state.
- No removal of borders from the input, pickers, permission prompts, or plan approval surfaces.
- No replacement of Ink or `ink-text-input`.
