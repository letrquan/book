import { setTimeout as wait } from 'node:timers/promises';
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
  view.stdin.write(input);
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
});
