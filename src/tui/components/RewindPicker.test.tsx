import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RewindTarget } from '../../types/sessions.js';
import { RewindPicker } from './RewindPicker.js';

const targets: RewindTarget[] = [
  {
    id: 'cp-new',
    userEventId: 'u-new',
    prompt: 'newest prompt',
    timestamp: Date.now(),
    snapshotId: 'snapshot-new',
    codeAvailable: true,
  },
  {
    id: 'cp-old',
    userEventId: 'u-old',
    prompt: 'older prompt',
    timestamp: Date.now() - 60_000,
    codeAvailable: false,
    codeUnavailableReason: 'capture exceeded the file limit',
  },
];

afterEach(cleanup);

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe('RewindPicker', () => {
  it('shows active prompts newest-first and enters the action stage', async () => {
    const view = render(
      <RewindPicker targets={targets} isRewinding={false} onAction={vi.fn()} onCancel={vi.fn()} />,
    );

    const frame = view.lastFrame() ?? '';
    expect(frame.indexOf('newest prompt')).toBeLessThan(frame.indexOf('older prompt'));
    expect(frame).toContain('code ready');
    expect(frame).toContain('conversation only');

    view.stdin.write('\r');
    await tick();
    expect(view.lastFrame()).toContain('Conversation');
    expect(view.lastFrame()).toContain('Code');
    expect(view.lastFrame()).toContain('Both');
  });

  it('disables code actions with the checkpoint failure reason', async () => {
    const onAction = vi.fn(async () => ({ ok: true as const }));
    const view = render(
      <RewindPicker targets={targets} isRewinding={false} onAction={onAction} onCancel={vi.fn()} />,
    );

    view.stdin.write('\u001B[B');
    await tick();
    view.stdin.write('\r');
    await tick();
    view.stdin.write('\u001B[B');
    await tick();
    expect(view.lastFrame()).toContain('Code (unavailable)');
    expect(view.lastFrame()).toContain('capture exceeded the file limit');
    view.stdin.write('\r');
    await tick();

    expect(onAction).not.toHaveBeenCalled();
  });

  it('completes a two-stage choice delivered in one chunk', async () => {
    // Enter advances target -> action, the arrow moves within the action list,
    // and the second Enter acts. All three used to depend on React flushing the
    // stage between keys; in one chunk the second Enter re-ran the first branch.
    const onAction = vi.fn(async () => ({ ok: true as const }));
    const view = render(
      <RewindPicker targets={targets} isRewinding={false} onAction={onAction} onCancel={vi.fn()} />,
    );

    view.stdin.write('\r\u001B[B\r');
    await tick();

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith(targets[0], 'code');
  });

  it('treats choosing Code as the final confirmation', async () => {
    const onAction = vi.fn(async () => ({ ok: true as const }));
    const view = render(
      <RewindPicker targets={targets} isRewinding={false} onAction={onAction} onCancel={vi.fn()} />,
    );

    view.stdin.write('\r');
    await tick();
    view.stdin.write('\u001B[B');
    await tick();
    view.stdin.write('\r');
    await tick();

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith(targets[0], 'code');
  });

  it('supports backing out, cancellation, working state, and empty history', async () => {
    const onCancel = vi.fn();
    const view = render(
      <RewindPicker targets={targets} isRewinding={false} onAction={vi.fn()} onCancel={onCancel} />,
    );
    view.stdin.write('\r');
    await tick();
    view.stdin.write('\u001B');
    await tick();
    expect(view.lastFrame()).toContain('older prompt');
    view.stdin.write('\u001B');
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);

    view.rerender(
      <RewindPicker targets={targets} isRewinding onAction={vi.fn()} onCancel={onCancel} />,
    );
    expect(view.lastFrame()).toContain('Restoring...');

    view.rerender(
      <RewindPicker targets={[]} isRewinding={false} onAction={vi.fn()} onCancel={onCancel} />,
    );
    expect(view.lastFrame()).toContain('no user prompts to rewind');
  });
});
