import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PeerIdleNoticeEvent } from '../../messaging/idle-notify.js';
import type { SessionMessaging, SessionMessagingEvent } from '../../messaging/session-messaging.js';
import { usePeerMessageDelivery } from './usePeerMessageDelivery.js';

/**
 * The TUI's half of `notify_when_idle` (#620 PR 6): an idle notice is a turn for the model only
 * when the runtime says the receive policy accepts its sender, and a row for the user always; and
 * the host work that will start a turn is reported, while merely being blocked is not.
 */

function fakeMessaging() {
  const listeners = new Set<(event: SessionMessagingEvent) => void>();
  return {
    subscribe: (listener: (event: SessionMessagingEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prepareDelivery: vi.fn(() => undefined),
    setHostWork: vi.fn(),
    /** The class a notice's turn runs in now, or undefined once the policy no longer accepts it. */
    noticeTurnClass: vi.fn((): 'prompting' | 'bypass' | undefined => 'prompting'),
    emit: (event: SessionMessagingEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

function Harness(props: Parameters<typeof usePeerMessageDelivery>[0]) {
  usePeerMessageDelivery(props);
  return null;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

const notice = (extra: Partial<PeerIdleNoticeEvent>): PeerIdleNoticeEvent => ({
  target: 'peer-b [a1b2c3]',
  state: 'idle',
  toModel: true,
  ...extra,
});

afterEach(() => cleanup());

describe('usePeerMessageDelivery idle notices', () => {
  function mount(blocked = false, pendingWork = false) {
    const messaging = fakeMessaging();
    const notify = vi.fn(async () => true);
    const warn = vi.fn();
    const props = {
      messaging: messaging as unknown as SessionMessaging,
      blocked,
      pendingWork,
      deliver: vi.fn(async () => true),
      notify,
      warn,
    };
    const view = render(<Harness {...props} />);
    return { messaging, notify, warn, view, props };
  }

  it('turns a notice the policy accepts into a model turn of the notifier’s class', async () => {
    const { messaging, notify, warn } = mount();
    await settle();
    messaging.emit({
      type: 'idle-notice',
      notice: notice({ detail: 'all green', sender: { from: 'uds:/s/1.sock', mode: 'prompting' } }),
    });
    await settle();
    expect(notify).toHaveBeenCalledTimes(1);
    const [context, options] = notify.mock.calls[0] as unknown as [
      string,
      { display: string; peerTurnClass: string; stillDeliverable: () => boolean },
    ];
    expect(context).toMatch(/^\[Cross-session idle notice\] peer-b \[a1b2c3\] is idle/);
    expect(context).toContain('«all green»');
    expect(options).toMatchObject({
      display: 'Cross-session idle notice.',
      peerTurnClass: 'prompting',
    });
    // The turn judges the notifier once more when it starts.
    expect(options.stillDeliverable()).toBe(true);
    messaging.noticeTurnClass.mockReturnValue(undefined);
    expect(options.stillDeliverable()).toBe(false);
    // The human reads the row: the notice turn's own is not shown.
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^◦ Cross-session idle notice: peer-b \[a1b2c3\] is idle.*«all green»$/,
      ),
    );
  });

  it('shows a notice the policy would not accept to the user only', async () => {
    const { messaging, notify, warn } = mount();
    await settle();
    messaging.emit({ type: 'idle-notice', notice: notice({ toModel: false }) });
    await settle();
    expect(notify).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('shown to you only'));
  });

  it('delivers every queued idle notice in one turn, continuing the longest relay', async () => {
    const { messaging, notify, view, props } = mount(true);
    await settle();
    const sender = { from: 'uds:/s/1.sock', mode: 'prompting' as const };
    messaging.noticeTurnClass
      .mockReturnValueOnce('bypass')
      .mockReturnValueOnce('prompting')
      .mockReturnValueOnce('bypass');
    for (const chain of [['a'], ['a', 'a'], ['a']]) {
      messaging.emit({
        type: 'idle-notice',
        notice: notice({ target: `peer-${chain.length}`, chain, sender }),
      });
    }
    view.rerender(<Harness {...props} blocked={false} />);
    await settle();
    // One turn, not one each: a model re-subscribing from each notice would fan out otherwise.
    expect(notify).toHaveBeenCalledTimes(1);
    const [context, options] = notify.mock.calls[0] as unknown as [
      string,
      { relayChain: string[]; peerTurnClass: string; stillDeliverable: () => boolean },
    ];
    expect(context.match(/\[Cross-session idle notice\]/g)).toHaveLength(3);
    expect(options.relayChain).toEqual(['a', 'a']);
    expect(options.peerTurnClass).toBe('prompting');
  });

  it('judges a queued notice again before its turn: one the policy no longer accepts stays a row', async () => {
    const { messaging, notify, warn, view, props } = mount(true);
    await settle();
    messaging.emit({
      type: 'idle-notice',
      notice: notice({ sender: { from: 'uds:/s/1.sock', mode: 'prompting' } }),
    });
    expect(warn).toHaveBeenCalledTimes(1);
    // The user set messaging.inbound to refuse while the notice waited.
    messaging.noticeTurnClass.mockReturnValue(undefined);
    view.rerender(<Harness {...props} blocked={false} />);
    await settle();
    expect(notify).not.toHaveBeenCalled();
    expect(messaging.setHostWork).toHaveBeenLastCalledWith(false);
  });

  it('reports host work that will start a turn, and not a surface or an edit that blocks delivery', async () => {
    // Blocked by the agents surface or a queued-input edit: nothing will start, so no host work.
    const { messaging, view, props } = mount(true, false);
    await settle();
    expect(messaging.setHostWork).toHaveBeenLastCalledWith(false);
    // A shell's or an agent's completion waiting to be delivered (or retried) will start a turn.
    view.rerender(<Harness {...props} pendingWork={true} />);
    await settle();
    expect(messaging.setHostWork).toHaveBeenLastCalledWith(true);
    view.rerender(<Harness {...props} pendingWork={false} />);
    await settle();
    expect(messaging.setHostWork).toHaveBeenLastCalledWith(false);
  });
});
