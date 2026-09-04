import { setTimeout as wait } from 'node:timers/promises';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import type { UserQuestionRequest } from '../../types/tools.js';
import { AskUserQuestionWizard } from './AskUserQuestionWizard.js';

const request: UserQuestionRequest = {
  id: 'reviewer:ask',
  source: { kind: 'subagent', agentPath: ['reviewer'] },
  questions: [
    {
      question: 'Which format?',
      header: 'Format',
      options: [
        { label: 'Summary', description: 'Brief response' },
        { label: 'Detailed', description: 'Long response' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which sections?',
      header: 'Sections',
      options: [
        { label: 'Intro', description: 'Opening context' },
        { label: 'Tests', description: 'Test details' },
      ],
      multiSelect: true,
    },
  ],
};

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

async function press(view: ReturnType<typeof render>, input: string) {
  act(() => {
    view.stdin.write(input);
  });
  await wait(20);
}

async function waitForText(view: ReturnType<typeof render>, text: string) {
  await vi.waitFor(() => expect(stripAnsi(view.lastFrame())).toContain(text), {
    timeout: 2_000,
    interval: 20,
  });
}

afterEach(cleanup);

describe('AskUserQuestionWizard', () => {
  it('walks through single and multi-select questions with a custom answer', async () => {
    const onResolve = vi.fn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <AskUserQuestionWizard request={request} onResolve={onResolve} />
      </ThemeContext.Provider>,
    );

    expect(stripAnsi(view.lastFrame())).toContain('? reviewer');
    await press(view, '\r');
    await waitForText(view, 'Which sections?');
    await press(view, ' ');
    await waitForText(view, '■ 1. Intro');
    await press(view, 'o');
    await waitForText(view, 'Your answer');
    await press(view, 'Custom appendix');
    await waitForText(view, 'Custom appendix');
    await press(view, '\r');

    await vi.waitFor(
      () =>
        expect(onResolve).toHaveBeenCalledWith({
          action: 'answer',
          answers: {
            'Which format?': 'Summary',
            'Which sections?': ['Intro', 'Custom appendix'],
          },
        }),
      { timeout: 2_000, interval: 20 },
    );
  });

  it('confirms multiple predefined choices with a multi-select question', async () => {
    const onResolve = vi.fn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <AskUserQuestionWizard
          request={{
            ...request,
            questions: [request.questions[1]],
          }}
          onResolve={onResolve}
        />
      </ThemeContext.Provider>,
    );

    await press(view, ' ');
    await press(view, '2');
    await press(view, '\r');

    await vi.waitFor(
      () =>
        expect(onResolve).toHaveBeenCalledWith({
          action: 'answer',
          answers: { 'Which sections?': ['Intro', 'Tests'] },
        }),
      { timeout: 2_000, interval: 20 },
    );
  });

  it('distinguishes decline from cancel', async () => {
    const decline = vi.fn();
    const declineView = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <AskUserQuestionWizard request={request} onResolve={decline} />
      </ThemeContext.Provider>,
    );
    await press(declineView, 'd');
    expect(decline).toHaveBeenCalledWith({ action: 'decline' });
    declineView.unmount();

    const cancel = vi.fn();
    const cancelView = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <AskUserQuestionWizard request={request} onResolve={cancel} />
      </ThemeContext.Provider>,
    );
    await press(cancelView, '\u001b');
    expect(cancel).toHaveBeenCalledWith({ action: 'cancel' });
  });

  it('fits the card to narrow terminals and exposes Other as a real row', () => {
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <AskUserQuestionWizard request={request} terminalWidth={42} onResolve={() => {}} />
      </ThemeContext.Provider>,
    );
    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('+ Other…');
    expect(output).toContain('1 of 2');
    expect(Math.max(...output.split('\n').map((line) => line.length))).toBeLessThanOrEqual(42);
  });

  it('returns from custom input to the choices with Escape', async () => {
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <AskUserQuestionWizard request={request} onResolve={() => {}} />
      </ThemeContext.Provider>,
    );
    await press(view, 'o');
    expect(stripAnsi(view.lastFrame())).toContain('Your answer');
    await press(view, '\u001b');
    expect(stripAnsi(view.lastFrame())).not.toContain('Your answer');
    expect(stripAnsi(view.lastFrame())).toContain('+ Other…');
  });

  it('answers with the option the arrow moved to, batched in one write', async () => {
    const onResolve = vi.fn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <AskUserQuestionWizard
          request={{ ...request, questions: [request.questions[0]] }}
          onResolve={onResolve}
        />
      </ThemeContext.Provider>,
    );

    // Ink splits a stdin chunk only at escape bytes, so this single write is
    // genuinely two keypresses inside one React batch — a paste, or an arrow
    // repeating faster than a frame. It is the case a per-keypress test cannot
    // reach.
    await press(view, '\u001b[B\r');

    expect(onResolve).toHaveBeenCalledWith({
      action: 'answer',
      answers: { 'Which format?': 'Detailed' },
    });
  });

  it('records the answer against the navigated-to question when back and choose are batched', async () => {
    const onResolve = vi.fn();
    const twoSingleSelectRequest: UserQuestionRequest = {
      id: 'test:two',
      source: { kind: 'root' },
      questions: [
        {
          question: 'Question 1?',
          header: 'Q1',
          options: [
            { label: 'Q1-A', description: 'Option A' },
            { label: 'Q1-B', description: 'Option B' },
          ],
          multiSelect: false,
        },
        {
          question: 'Question 2?',
          header: 'Q2',
          options: [
            { label: 'Q2-A', description: 'Option A' },
            { label: 'Q2-B', description: 'Option B' },
          ],
          multiSelect: false,
        },
      ],
    };

    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <AskUserQuestionWizard request={twoSingleSelectRequest} onResolve={onResolve} />
      </ThemeContext.Provider>,
    );

    // Step 1: answer Q1 with 'Q1-B' (down arrow then Enter)
    await press(view, '\u001b[B\r');
    await waitForText(view, 'Question 2?');

    // Step 2: On Question 2, send left arrow + Enter in a single batch.
    // This should navigate back to Question 1 and select 'Q1-A' (the top option).
    await press(view, '\u001b[D\r');
    // The frame shows Question 2 both before and after that chunk, so look at
    // Question 1 to see which option the batched Enter recorded.
    await press(view, '\u001b[D');
    await waitForText(view, '● 1. Q1-A');
    await press(view, '\r');
    await waitForText(view, 'Question 2?');

    // Step 3: Now answer Question 2 with 'Q2-B'
    await press(view, '\u001b[B\r');

    await vi.waitFor(
      () =>
        expect(onResolve).toHaveBeenCalledWith({
          action: 'answer',
          answers: {
            'Question 1?': 'Q1-A',
            'Question 2?': 'Q2-B',
          },
        }),
      { timeout: 2_000, interval: 20 },
    );
  });

  it('toggles a multi-select option on the navigated-to question when back and space are batched', async () => {
    const onResolve = vi.fn();
    const mixedRequest: UserQuestionRequest = {
      id: 'test:mixed',
      source: { kind: 'root' },
      questions: [
        {
          question: 'Question 1?',
          header: 'Q1',
          options: [
            { label: 'Q1-A', description: 'Option A' },
            { label: 'Q1-B', description: 'Option B' },
          ],
          multiSelect: true,
        },
        {
          question: 'Question 2?',
          header: 'Q2',
          options: [
            { label: 'Q2-A', description: 'Option A' },
            { label: 'Q2-B', description: 'Option B' },
          ],
          multiSelect: false,
        },
      ],
    };

    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <AskUserQuestionWizard request={mixedRequest} onResolve={onResolve} />
      </ThemeContext.Provider>,
    );

    // On Q1, select Q1-A and advance to Q2
    await press(view, ' ');
    await press(view, '\r');
    await waitForText(view, 'Question 2?');

    // On Q2, batch left arrow + down arrow + space: go back to Q1, move to Q1-B, toggle Q1-B
    await press(view, '\u001b[D\u001b[B ');
    // Confirm Q1 and advance to Q2
    await press(view, '\r');
    await waitForText(view, 'Question 2?');

    // Answer Q2
    await press(view, '\r');

    await vi.waitFor(
      () =>
        expect(onResolve).toHaveBeenCalledWith({
          action: 'answer',
          answers: {
            'Question 1?': ['Q1-A', 'Q1-B'],
            'Question 2?': 'Q2-A',
          },
        }),
      { timeout: 2_000, interval: 20 },
    );
  });

  function singleSelect(n: number) {
    return {
      question: `Question ${n}?`,
      header: `Q${n}`,
      options: [
        { label: `Q${n}-A`, description: 'Option A' },
        { label: `Q${n}-B`, description: 'Option B' },
      ],
      multiSelect: false,
    };
  }

  it('shows the next question after a custom answer edited mid-text, instead of answering it', async () => {
    const onResolve = vi.fn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <AskUserQuestionWizard
          request={{
            id: 'test:edit',
            source: { kind: 'root' },
            questions: [singleSelect(1), singleSelect(2)],
          }}
          onResolve={onResolve}
        />
      </ThemeContext.Provider>,
    );

    await press(view, 'o');
    await waitForText(view, 'Your answer');
    await press(view, 'foo');
    // Left then a character re-orders Ink's input listeners so the text input
    // sees Enter before the wizard does. With two owners of Enter, the wizard
    // then read the mode flag already flipped and answered Question 2 unseen.
    await press(view, '\u001b[D');
    await press(view, 'x');
    await press(view, '\r');
    await waitForText(view, 'Question 2?');
    expect(onResolve).not.toHaveBeenCalled();

    await press(view, '\r');
    await vi.waitFor(
      () =>
        expect(onResolve).toHaveBeenCalledWith({
          action: 'answer',
          answers: { 'Question 1?': 'foxo', 'Question 2?': 'Q2-A' },
        }),
      { timeout: 2_000, interval: 20 },
    );
  });

  it('lets a second Enter in the same write act on the next question, not the closed editor', async () => {
    const onResolve = vi.fn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <AskUserQuestionWizard
          request={{
            id: 'test:paste',
            source: { kind: 'root' },
            questions: [singleSelect(1), singleSelect(2), singleSelect(3)],
          }}
          onResolve={onResolve}
        />
      </ThemeContext.Provider>,
    );

    await press(view, 'o');
    await waitForText(view, 'Your answer');
    await press(view, 'foo');
    // Enter, Down, Enter in one chunk: use the custom answer, then choose
    // Q2-B. The still-mounted text input used to re-submit "foo" against
    // Question 3 on the second Enter and resolve the whole request.
    await press(view, '\r\u001b[B\r');
    await waitForText(view, 'Question 3?');
    expect(onResolve).not.toHaveBeenCalled();

    await press(view, '\r');
    await vi.waitFor(
      () =>
        expect(onResolve).toHaveBeenCalledWith({
          action: 'answer',
          answers: { 'Question 1?': 'foo', 'Question 2?': 'Q2-B', 'Question 3?': 'Q3-A' },
        }),
      { timeout: 2_000, interval: 20 },
    );
  });

  it('treats custom text that names an option as that option', async () => {
    const onResolve = vi.fn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <AskUserQuestionWizard
          request={{ ...request, questions: [request.questions[1]] }}
          onResolve={onResolve}
        />
      </ThemeContext.Provider>,
    );

    await press(view, ' ');
    await waitForText(view, '■ 1. Intro');
    await press(view, 'o');
    await waitForText(view, 'Your answer');
    await press(view, 'intro');
    await press(view, '\r');

    // Not ['Intro', 'intro']: the host rejects that as a duplicate and drops
    // every answer in the request.
    await vi.waitFor(
      () =>
        expect(onResolve).toHaveBeenCalledWith({
          action: 'answer',
          answers: { 'Which sections?': ['Intro'] },
        }),
      { timeout: 2_000, interval: 20 },
    );
  });

  it('renders a question named after an Object.prototype member', async () => {
    const onResolve = vi.fn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <AskUserQuestionWizard
          request={{
            id: 'test:proto',
            source: { kind: 'root' },
            questions: [{ ...singleSelect(1), question: 'constructor' }],
          }}
          onResolve={onResolve}
        />
      </ThemeContext.Provider>,
    );

    expect(stripAnsi(view.lastFrame())).toContain('constructor');
    await press(view, '\r');
    expect(onResolve).toHaveBeenCalledWith({ action: 'answer', answers: { constructor: 'Q1-A' } });
  });

  it('ignores a pasted line that merely starts with a digit', async () => {
    const onResolve = vi.fn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <AskUserQuestionWizard
          request={{ ...request, questions: [request.questions[0]] }}
          onResolve={onResolve}
        />
      </ThemeContext.Provider>,
    );

    await press(view, ' 1');
    await press(view, '1.0');
    expect(onResolve).not.toHaveBeenCalled();

    await press(view, '1');
    expect(onResolve).toHaveBeenCalledWith({
      action: 'answer',
      answers: { 'Which format?': 'Summary' },
    });
  });
});
