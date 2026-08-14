import { setTimeout as wait } from 'node:timers/promises';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import type { ElicitationRequest } from '../../types/tools.js';
import { McpElicitationForm, optionWindowStart } from './McpElicitationForm.js';

const ENTER = '\r';
const DOWN = '[B';
const UP = '[A';
const ESC = '';

function request(overrides: Partial<ElicitationRequest> = {}): ElicitationRequest {
  return {
    id: 'azure-devops:1',
    server: 'azure-devops',
    message: 'Select the Azure DevOps project.',
    fields: [
      {
        name: 'project',
        title: 'Project',
        required: true,
        kind: 'enum',
        options: [
          { value: 'alpha', label: 'Alpha' },
          { value: 'beta', label: 'Beta' },
        ],
      },
      { name: 'note', title: 'Note', required: false, kind: 'string' },
    ],
    ...overrides,
  };
}

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function mount(props: Partial<Parameters<typeof McpElicitationForm>[0]> = {}) {
  const onResolve = vi.fn();
  const view = render(
    <ThemeContext.Provider value={DEFAULT_THEME}>
      <McpElicitationForm request={request()} onResolve={onResolve} {...props} />
    </ThemeContext.Provider>,
  );
  return { view, onResolve };
}

async function press(view: ReturnType<typeof render>, input: string) {
  act(() => {
    view.stdin.write(input);
  });
  await wait(20);
}

afterEach(cleanup);

describe('McpElicitationForm', () => {
  it('shows which server is asking, its message, and the required marker', () => {
    const { view } = mount();
    const frame = stripAnsi(view.lastFrame());
    expect(frame).toContain('azure-devops');
    expect(frame).toContain('Select the Azure DevOps project.');
    expect(frame).toContain('Project*');
    expect(frame).toContain('Note');
  });

  it('collects a choice and free text, then sends the form', async () => {
    const { view, onResolve } = mount();

    await press(view, ENTER); // open the project picker
    await press(view, DOWN); // move to Beta
    await press(view, ENTER); // choose it
    expect(stripAnsi(view.lastFrame())).toContain('Beta');

    await press(view, ENTER); // edit Note
    await press(view, 'hi');
    await press(view, ENTER); // save
    await press(view, ENTER); // send

    expect(onResolve).toHaveBeenCalledWith({
      action: 'accept',
      content: { project: 'beta', note: 'hi' },
    });
  });

  it('omits an untouched optional field from the answer', async () => {
    const { view, onResolve } = mount();
    await press(view, ENTER);
    await press(view, ENTER); // accept the first choice
    await press(view, DOWN); // skip Note, land on send
    await press(view, ENTER);

    expect(onResolve).toHaveBeenCalledWith({ action: 'accept', content: { project: 'alpha' } });
  });

  it('refuses to send while a required field is empty', async () => {
    const { view, onResolve } = mount();
    await press(view, DOWN);
    await press(view, DOWN); // send row
    await press(view, ENTER);

    expect(onResolve).not.toHaveBeenCalled();
    expect(stripAnsi(view.lastFrame())).toContain('Project is required');
  });

  it('rejects text that is not a valid number', async () => {
    const { view, onResolve } = mount({
      request: request({
        fields: [{ name: 'count', title: 'Count', required: true, kind: 'number', integer: true }],
      }),
    });
    await press(view, ENTER);
    await press(view, 'abc');
    await press(view, ENTER);

    expect(stripAnsi(view.lastFrame())).toContain('Count must be a number');
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('toggles a boolean field in place', async () => {
    const { view, onResolve } = mount({
      request: request({
        fields: [{ name: 'force', title: 'Force', required: false, kind: 'boolean' }],
      }),
    });
    expect(stripAnsi(view.lastFrame())).toContain('no');
    await press(view, ENTER);
    expect(stripAnsi(view.lastFrame())).toContain('yes');

    await press(view, DOWN);
    await press(view, ENTER);
    expect(onResolve).toHaveBeenCalledWith({ action: 'accept', content: { force: true } });
  });

  it('filters a long option list and keeps the cursor windowed', async () => {
    const options = Array.from({ length: 40 }, (_, index) => ({
      value: `p${index}`,
      label: `Project ${index}`,
    }));
    const { view, onResolve } = mount({
      request: request({
        fields: [{ name: 'project', title: 'Project', required: true, kind: 'enum', options }],
      }),
    });

    await press(view, ENTER);
    expect(stripAnsi(view.lastFrame())).toContain('40 choices');
    await press(view, 'Project 37');
    await press(view, ENTER);
    await press(view, ENTER); // send

    expect(onResolve).toHaveBeenCalledWith({ action: 'accept', content: { project: 'p37' } });
  });

  it('declines with D and cancels with Escape', async () => {
    const declined = mount();
    await press(declined.view, 'd');
    expect(declined.onResolve).toHaveBeenCalledWith({ action: 'decline' });

    const cancelled = mount();
    await press(cancelled.view, ESC);
    expect(cancelled.onResolve).toHaveBeenCalledWith({ action: 'cancel' });
  });

  it('leaves the form open when Escape closes an editor instead', async () => {
    const { view, onResolve } = mount();
    await press(view, ENTER); // open picker
    await press(view, ESC); // close picker only
    expect(onResolve).not.toHaveBeenCalled();
    await press(view, UP);
    expect(stripAnsi(view.lastFrame())).toContain('Send to azure-devops');
  });

  it('resolves once even if the user keeps typing', async () => {
    const { view, onResolve } = mount();
    await press(view, 'd');
    await press(view, 'd');
    expect(onResolve).toHaveBeenCalledTimes(1);
  });
});

describe('optionWindowStart', () => {
  it('keeps the cursor centered without running past either end', () => {
    expect(optionWindowStart(0, 3, 6)).toBe(0);
    expect(optionWindowStart(0, 40, 6)).toBe(0);
    expect(optionWindowStart(20, 40, 6)).toBe(17);
    expect(optionWindowStart(39, 40, 6)).toBe(34);
  });
});
