import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { PlanApprovalActions, PlanApprovalButtons } from './PlanApprovalButtons.js';

function withTheme(children: React.ReactElement): React.ReactElement {
  return <ThemeContext.Provider value={DEFAULT_THEME}>{children}</ThemeContext.Provider>;
}

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

/** Polls rather than sleeps: returns on the first frame that shows `text`. */
async function waitForText(view: ReturnType<typeof render>, text: string) {
  await vi.waitFor(() => expect(stripAnsi(view.lastFrame())).toContain(text), {
    timeout: 2_000,
    interval: 20,
  });
}

afterEach(() => cleanup());

describe('PlanApprovalButtons', () => {
  it('rejects with Escape', async () => {
    const onResolve = vi.fn();
    const view = render(
      withTheme(<PlanApprovalButtons plan="Review the proposed changes." onResolve={onResolve} />),
    );

    view.stdin.write('\x1b');
    await vi.waitFor(() => expect(onResolve).toHaveBeenCalledOnce());
    expect(onResolve).toHaveBeenCalledWith('reject');
  });

  it('resolves only once when multiple approval keys arrive', () => {
    const onResolve = vi.fn();
    const view = render(
      withTheme(<PlanApprovalButtons plan="Review the proposed changes." onResolve={onResolve} />),
    );

    view.stdin.write('a');
    view.stdin.write('r');
    view.stdin.write('\r');

    expect(onResolve).toHaveBeenCalledOnce();
    expect(onResolve).toHaveBeenCalledWith('approve');
  });

  it('resolves approve-fresh with the F shortcut', () => {
    const onResolve = vi.fn();
    const view = render(
      withTheme(<PlanApprovalButtons plan="Review the proposed changes." onResolve={onResolve} />),
    );

    view.stdin.write('f');

    expect(onResolve).toHaveBeenCalledOnce();
    expect(onResolve).toHaveBeenCalledWith('approve-fresh');
  });

  it('offers the fresh-context approval option', () => {
    const view = render(
      withTheme(<PlanApprovalButtons plan="Review the proposed changes." onResolve={vi.fn()} />),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('Approve, fresh context');
    // The shortcut key is set beside what the choice does.
    expect(output).toMatch(/Approve, fresh context\s+F\s+implement it clean/);
  });

  it('collects feedback when the user requests plan adjustments', async () => {
    const onResolve = vi.fn();
    const view = render(
      withTheme(<PlanApprovalButtons plan="Review the proposed changes." onResolve={onResolve} />),
    );

    // Each key waits for the frame it produced. A fixed sleep is a race with the
    // render, and on a loaded runner the composer can still be closed when the
    // feedback is typed, or unanswered when Enter arrives.
    view.stdin.write('e');
    await vi.waitFor(() => expect(stripAnsi(view.lastFrame())).toContain('Adjust the plan'));

    view.stdin.write('Keep the migration backward compatible.');
    await vi.waitFor(() =>
      expect(stripAnsi(view.lastFrame())).toContain('Keep the migration backward compatible.'),
    );
    view.stdin.write('\r');
    await vi.waitFor(() => expect(onResolve).toHaveBeenCalledOnce());

    expect(onResolve).toHaveBeenCalledWith({
      decision: 'revise',
      feedback: 'Keep the migration backward compatible.',
    });
  });

  it('renders markdown tables inside the proposed plan', () => {
    const view = render(
      withTheme(
        <PlanApprovalButtons
          plan={'| Agent | Work |\n|---|---|\n| **Book** | Review |'}
          terminalWidth={40}
          onResolve={vi.fn()}
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('━');
    expect(output).toContain('Book');
    expect(output).not.toContain('**Book**');
  });

  it('strips indented heading markers and counts only top-level steps', () => {
    const view = render(
      withTheme(
        <PlanApprovalButtons
          plan={'  ### Details\n1. First\n   1. Nested\n2) Second'}
          onResolve={vi.fn()}
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('  Details');
    expect(output).not.toContain('### Details');
    expect(output).toContain('2 steps · awaiting approval');
    expect(output).toContain('1. Nested');
  });

  it('resolves the button armed by an arrow in the same batch', async () => {
    const onResolve = vi.fn();
    const view = render(
      withTheme(<PlanApprovalButtons plan="Review the proposed changes." onResolve={onResolve} />),
    );

    // Ink splits a stdin chunk only at escape bytes, so this single write is
    // genuinely two keypresses inside one React batch — a paste, or an arrow
    // repeating faster than a frame. It is the case a per-keypress test cannot
    // reach.
    view.stdin.write('\u001b[C\r');
    await vi.waitFor(() => expect(onResolve).toHaveBeenCalledWith('approve-fresh'));
  });

  // The sheet shares the screen with the transcript, which re-measures its
  // viewport only when the app hears that the footer's height changed. The
  // feedback editor is a different shape from the choices, and its one-row
  // error is another, and either one landed on top of a transcript row that
  // was there a moment earlier.
  it('reports a height change for the feedback editor and its error row', async () => {
    const onLayoutChange = vi.fn();
    const view = render(
      withTheme(
        <PlanApprovalActions
          plan={'1. Step one\n2. Step two'}
          onResolve={vi.fn()}
          onLayoutChange={onLayoutChange}
        />,
      ),
    );
    // Opening the sheet is a change of height too.
    expect(onLayoutChange).toHaveBeenCalled();

    const onChoices = onLayoutChange.mock.calls.length;
    view.stdin.write('e');
    await waitForText(view, 'Adjust the plan');
    expect(onLayoutChange.mock.calls.length).toBeGreaterThan(onChoices);

    const onEditor = onLayoutChange.mock.calls.length;
    view.stdin.write('\r');
    await waitForText(view, 'Add feedback before requesting changes.');
    expect(onLayoutChange.mock.calls.length).toBeGreaterThan(onEditor);

    // The error row is the one that grows the sheet, and editing hands the row
    // back — the sheet reports the way back down, not only the way up.
    const withError = onLayoutChange.mock.calls.length;
    view.stdin.write('x');
    await vi.waitFor(() =>
      expect(stripAnsi(view.lastFrame())).not.toContain('Add feedback before requesting changes.'),
    );
    expect(onLayoutChange.mock.calls.length).toBeGreaterThan(withError);

    // With no error row, typing is not a height change.
    const whileTyping = onLayoutChange.mock.calls.length;
    view.stdin.write('y');
    await waitForText(view, 'xy');
    expect(onLayoutChange.mock.calls.length).toBe(whileTyping);
  });

  it('reports the editor taking and giving up the readline chords', async () => {
    // While the feedback editor has the focus, Ctrl+U clears it and Ctrl+D
    // deletes under the cursor. The app gates the transcript's paging chords on
    // this, the same way the sheet reports its height.
    const onEditorFocusChange = vi.fn();
    const view = render(
      withTheme(
        <PlanApprovalActions
          plan={'1. Step one'}
          onResolve={vi.fn()}
          onEditorFocusChange={onEditorFocusChange}
        />,
      ),
    );
    expect(onEditorFocusChange).toHaveBeenLastCalledWith(false);

    view.stdin.write('e');
    await waitForText(view, 'Adjust the plan');
    expect(onEditorFocusChange).toHaveBeenLastCalledWith(true);

    view.stdin.write('\x1b');
    await waitForText(view, 'Approve');
    expect(onEditorFocusChange).toHaveBeenLastCalledWith(false);
  });
});
