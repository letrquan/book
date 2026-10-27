import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PeerIdleNoticeEvent } from '../../messaging/idle-notify.js';
import type { SessionMessaging, SessionMessagingEvent } from '../../messaging/session-messaging.js';
import { usePeerMessageDelivery } from './usePeerMessageDelivery.js';

/**
 * The TUI's half of `notify_when_idle` (#620 PR 6): an idle notice is a turn for the model only
 * when the runtime says the receive policy accepts its sender, and a row for the user otherwise;
 * and the session reports itself idle only while nothing runs, waits or is about to be delivered.
 */

function fakeMessaging() {
  const listeners = new Set<(event: SessionMessagingEvent) => void>();
  return {
    subscribe: (listener: (event: SessionMessagingEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prepareDelivery: vi.fn(() => undefined),
    setIdle: vi.fn(),
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
  function mount(blocked = false) {
    const messaging = fakeMessaging();
    const notify = vi.fn(async () => true);
    const warn = vi.fn();
    const props = {
      messaging: messaging as unknown as SessionMessaging,
      blocked,
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
      notice: notice({ detail: 'all green', turnClass: 'prompting' }),
    });
    await settle();
    expect(notify).toHaveBeenCalledTimes(1);
    const [context, options] = notify.mock.calls[0] as unknown as [
      string,
      { display: string; peerTurnClass: string },
    ];
    expect(context).toMatch(/^\[Cross-session idle notice\] peer-b \[a1b2c3\] is idle/);
    expect(context).toContain('«all green»');
    expect(options).toEqual({ display: 'Cross-session idle notice.', peerTurnClass: 'prompting' });
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

  it('reports the session idle only while nothing blocks it and no notice waits', async () => {
    const { messaging, view, props } = mount(true);
    await settle();
    expect(messaging.setIdle).toHaveBeenLastCalledWith(false);
    view.rerender(<Harness {...props} blocked={false} />);
    await settle();
    expect(messaging.setIdle).toHaveBeenLastCalledWith(true);
    view.rerender(<Harness {...props} blocked={true} />);
    await settle();
    expect(messaging.setIdle).toHaveBeenLastCalledWith(false);
  });
});
