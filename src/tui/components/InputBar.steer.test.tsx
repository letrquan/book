import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { InputBar } from './InputBar.js';
import type { ImageAttachment } from '../../types/messages.js';

/**
 * Steering in the composer (#661): while a user-started run is going, Enter hands the draft to
 * the running loop and Tab queues it for the end of the run. A slash command, a `!` line and a
 * completed run keep the rules they had.
 */

afterEach(() => cleanup());

function inputBar(
  onSubmit: (value: string, attachments?: ImageAttachment[]) => void,
  props: Partial<React.ComponentProps<typeof InputBar>> = {},
) {
  return React.createElement(
    ThemeContext.Provider,
    { value: DEFAULT_THEME },
    React.createElement(InputBar, {
      onSubmit,
      submissionMode: 'submit',
      mode: 'default',
      onCycleMode: () => {},
      commands: [],
      ...props,
    }),
  );
}

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('InputBar steering', () => {
  it('steers on Enter instead of submitting or queueing', async () => {
    const onSubmit = vi.fn();
    const onQueue = vi.fn(() => true);
    const onSteer = vi.fn(async () => true);
    const view = render(
      inputBar(onSubmit, {
        submissionMode: 'steer',
        onSteer,
        onQueue,
        canSteerWhileBusy: (value) => !value.startsWith('/') && !value.startsWith('!'),
        canQueueWhileBusy: (value) => !value.startsWith('/'),
      }),
    );

    view.stdin.write('use the other branch');
    await tick();
    view.stdin.write('\r');
    await tick(20);

    expect(onSteer).toHaveBeenCalledWith('use the other branch', undefined);
    expect(onQueue).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    // The words left the composer the moment they were handed to the run.
    expect(stripAnsi(view.lastFrame())).not.toContain('use the other branch');
  });

  it('queues on Tab while the agent is busy, which is what Enter used to do', async () => {
    const onSubmit = vi.fn();
    const onQueue = vi.fn(() => true);
    const onSteer = vi.fn(async () => true);
    const view = render(
      inputBar(onSubmit, {
        submissionMode: 'steer',
        onSteer,
        onQueue,
        canSteerWhileBusy: (value) => !value.startsWith('/'),
        canQueueWhileBusy: (value) => !value.startsWith('/'),
      }),
    );

    view.stdin.write('after you finish');
    await tick();
    view.stdin.write('\t');
    await tick(20);

    expect(onQueue).toHaveBeenCalledWith('after you finish');
    expect(onSteer).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(stripAnsi(view.lastFrame())).not.toContain('after you finish');
  });

  it('leaves a slash command to its own busy rules: neither steered nor queued by Tab', async () => {
    const onSubmit = vi.fn();
    const onQueue = vi.fn(() => true);
    const onSteer = vi.fn(async () => true);
    const view = render(
      inputBar(onSubmit, {
        submissionMode: 'steer',
        onSteer,
        onQueue,
        // A chat-typed menu command such as `/jobs` runs locally; the rest are refused while busy.
        canSubmitWhileBusy: (value) => value.startsWith('/jobs'),
        canSteerWhileBusy: (value) => !value.startsWith('/') && !value.startsWith('!'),
        canQueueWhileBusy: (value) => !value.startsWith('/'),
      }),
    );

    view.stdin.write('/diff');
    await tick();
    view.stdin.write('\t');
    await tick(20);

    expect(onQueue).not.toHaveBeenCalled();
    expect(onSteer).not.toHaveBeenCalled();
    // Tab left the draft alone: it is still the user's to submit.
    expect(stripAnsi(view.lastFrame())).toContain('/diff');
  });

  it('announces Enter as a steer and Tab as the way to wait', async () => {
    const view = render(
      inputBar(() => {}, {
        submissionMode: 'steer',
        onSteer: async () => true,
        canSteerWhileBusy: () => true,
      }),
    );

    await tick();
    const frame = stripAnsi(view.lastFrame());
    expect(frame).toContain('Enter sends after the current tool call');
    expect(frame).toContain('Tab queues');
  });

  it('falls back to queueing when no run is left to steer', async () => {
    const onQueue = vi.fn(() => true);
    // `onSteer` resolving false means the host queued the words itself; the composer still
    // clears, because the alternative is two copies of the same message.
    const onSteer = vi.fn(async () => false);
    const view = render(
      inputBar(() => {}, {
        submissionMode: 'steer',
        onSteer,
        onQueue,
        canSteerWhileBusy: () => true,
        canQueueWhileBusy: () => true,
      }),
    );

    view.stdin.write('too late');
    await tick();
    view.stdin.write('\r');
    await tick(20);

    expect(onSteer).toHaveBeenCalledWith('too late', undefined);
    expect(stripAnsi(view.lastFrame())).not.toContain('too late');
  });

  it('queues a `!` shell line on Enter: it was queueable before steering, and still is', async () => {
    const onSubmit = vi.fn();
    const onQueue = vi.fn(() => true);
    const onSteer = vi.fn(async () => true);
    const view = render(
      inputBar(onSubmit, {
        submissionMode: 'steer',
        onSteer,
        onQueue,
        // The host's own gate: a `!` line runs a command rather than talking to the model.
        canSteerWhileBusy: (value) => !value.startsWith('/') && !value.startsWith('!'),
        canQueueWhileBusy: (value) => !value.startsWith('/'),
      }),
    );

    view.stdin.write('!ls');
    await tick();
    view.stdin.write('\r');
    await tick(20);

    expect(onQueue).toHaveBeenCalledWith('!ls');
    expect(onSteer).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(stripAnsi(view.lastFrame())).not.toContain('!ls');
  });

  it('autofills the selected command on Tab with the slash menu open, instead of queueing', async () => {
    const onQueue = vi.fn(() => true);
    const view = render(
      inputBar(() => {}, {
        submissionMode: 'steer',
        onQueue,
        canSteerWhileBusy: () => true,
        canQueueWhileBusy: (value) => !value.startsWith('/'),
        commands: [
          {
            name: 'clear',
            description: 'Clear the conversation',
            body: 'Clear',
            source: 'project',
          },
        ],
      }),
    );

    view.stdin.write('/cle');
    await tick(20);
    expect(stripAnsi(view.lastFrame())).toContain('/clear');

    view.stdin.write('\t');
    await tick(20);

    // The menu's Tab is an autofill, not a submission: the menu closes, and the command stays in
    // the composer for the user to finish.
    expect(onQueue).not.toHaveBeenCalled();
    const frame = stripAnsi(view.lastFrame());
    expect(frame).toMatch(/^> \/clear/m);
    expect(frame).not.toContain('Clear the conversation');
  });

  it('still cycles agent focus on Tab from an empty prompt', async () => {
    const onQueue = vi.fn(() => true);
    const onCycleAgentFocus = vi.fn(() => true);
    const view = render(
      inputBar(() => {}, {
        submissionMode: 'steer',
        onQueue,
        onCycleAgentFocus,
        canSteerWhileBusy: () => true,
        canQueueWhileBusy: () => true,
      }),
    );

    view.stdin.write('\t');
    await tick(20);

    expect(onCycleAgentFocus).toHaveBeenCalledTimes(1);
    expect(onQueue).not.toHaveBeenCalled();
  });
});
