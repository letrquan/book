import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type { McpHostServerSnapshot } from '../../mcp-host.js';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { McpServerApprovalPrompt } from './McpServerApprovalPrompt.js';

function server(): McpHostServerSnapshot {
  return {
    name: 'azure-devops',
    source: 'project',
    path: '/workspace/.mcp.json',
    target: 'npx -y @azure/mcp-server',
    envKeys: [],
    headerKeys: [],
    fingerprint: 'sha256:abc',
    status: 'pending-approval',
    configChangedSinceApproval: false,
  };
}

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function mount() {
  const onApprove = vi.fn(() => ({ ok: true }));
  const onReject = vi.fn(() => ({ ok: true }));
  const onDefer = vi.fn();
  const view = render(
    <ThemeContext.Provider value={DEFAULT_THEME}>
      <McpServerApprovalPrompt
        server={server()}
        remainingCount={0}
        onApprove={onApprove}
        onReject={onReject}
        onDefer={onDefer}
      />
    </ThemeContext.Provider>,
  );
  return { view, onApprove, onReject, onDefer };
}

afterEach(cleanup);

describe('McpServerApprovalPrompt', () => {
  it('shows the connection target it is asking the user to trust', () => {
    const { view } = mount();
    const frame = stripAnsi(view.lastFrame());
    expect(frame).toContain('azure-devops');
    expect(frame).toContain('npx -y @azure/mcp-server');
  });

  it('confirms the option the arrow moved to, batched in one write', async () => {
    const { view, onApprove, onReject } = mount();

    // Ink splits a stdin chunk only at escape bytes, so this single write is
    // genuinely two keypresses inside one React batch — a paste, or an arrow
    // repeating faster than a frame. It is the case a per-keypress test cannot
    // reach.
    // This is a trust gate, so confirming the pre-arrow option means connecting
    // a server the user had moved off.
    view.stdin.write('\u001b[B\r');
    await wait(20);

    expect(onReject).toHaveBeenCalledOnce();
    expect(onApprove).not.toHaveBeenCalled();
  });
});
