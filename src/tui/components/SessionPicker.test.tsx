import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionPicker } from './SessionPicker.js';

const sessions = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'feature',
    cwd: '/project',
    createdAt: 1,
    updatedAt: Date.now(),
    messageCount: 4,
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    cwd: '/project',
    createdAt: 1,
    updatedAt: Date.now() - 60_000,
    messageCount: 2,
  },
];

afterEach(cleanup);

describe('SessionPicker', () => {
  it('renders saved sessions and selects with Enter', () => {
    const onPick = vi.fn();
    const view = render(
      <SessionPicker
        sessions={sessions}
        currentSessionId="current"
        onPick={onPick}
        onCancel={vi.fn()}
      />,
    );
    expect(view.lastFrame()).toContain('feature');
    expect(view.lastFrame()).toContain('Untitled session');
    expect(view.lastFrame()).not.toContain('22222222');
    view.stdin.write('\r');
    expect(onPick).toHaveBeenCalledWith(sessions[0]);
  });

  it('omits the active session', () => {
    const view = render(
      <SessionPicker
        sessions={sessions}
        currentSessionId={sessions[0].id}
        onPick={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(view.lastFrame()).not.toContain('feature');
    expect(view.lastFrame()).toContain('Untitled session');
    expect(view.lastFrame()).not.toContain('22222222');
  });

  it('hides a session left empty by a launch that ended before its first prompt (#428)', () => {
    const onPick = vi.fn();
    const empty = {
      id: '33333333-3333-3333-3333-333333333333',
      name: 'never-started',
      cwd: '/project',
      createdAt: 1,
      updatedAt: Date.now() + 1_000,
      messageCount: 0,
    };
    const view = render(
      <SessionPicker
        sessions={[empty, ...sessions]}
        currentSessionId="current"
        onPick={onPick}
        onCancel={vi.fn()}
      />,
    );
    expect(view.lastFrame()).not.toContain('never-started');
    expect(view.lastFrame()).not.toContain('0 messages');
    view.stdin.write('\r');
    expect(onPick).toHaveBeenCalledWith(sessions[0]);
  });
});
