import { setImmediate as flush } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { flattenPermissionRules, PermissionsPanel } from './PermissionsPanel.js';

afterEach(() => cleanup());

const permissions = {
  allow: ['Bash(npm run *)', 'Read(README.md)'],
  ask: [] as string[],
  deny: ['Bash(rm *)'],
};

function panel(props: Partial<React.ComponentProps<typeof PermissionsPanel>> = {}) {
  return (
    <ThemeContext.Provider value={DEFAULT_THEME}>
      <PermissionsPanel mode="default" permissions={permissions} {...props} />
    </ThemeContext.Provider>
  );
}

describe('flattenPermissionRules', () => {
  it('orders the lists the way the panel renders them', () => {
    expect(flattenPermissionRules(permissions)).toEqual([
      { list: 'allow', rule: 'Bash(npm run *)' },
      { list: 'allow', rule: 'Read(README.md)' },
      { list: 'deny', rule: 'Bash(rm *)' },
    ]);
  });
});

describe('PermissionsPanel', () => {
  it('removes the selected rule on x', () => {
    const onRemove = vi.fn(() => ({ ok: true }));
    const view = render(panel({ onRemove }));

    view.stdin.write('x');

    expect(onRemove).toHaveBeenCalledExactlyOnceWith({
      list: 'allow',
      rule: 'Bash(npm run *)',
    });
  });

  it('removes the rule the arrows moved to, across list boundaries', async () => {
    const onRemove = vi.fn(() => ({ ok: true }));
    const view = render(panel({ onRemove }));

    view.stdin.write('\u001b[B');
    await flush();
    await flush();
    view.stdin.write('\u001b[B');
    await flush();
    await flush();
    view.stdin.write('x');

    expect(onRemove).toHaveBeenCalledExactlyOnceWith({ list: 'deny', rule: 'Bash(rm *)' });
  });

  it('says so when the rule lives in a file it cannot edit', async () => {
    const view = render(panel({ onRemove: () => ({ ok: false, notLocal: true }) }));

    view.stdin.write('x');
    await flush();
    await flush();

    expect(stripAnsi(view.lastFrame() ?? '')).toContain('cannot edit');
  });

  it('advertises the keys only when it can actually edit', () => {
    const editable = render(panel({ onRemove: () => ({ ok: true }) }));
    expect(stripAnsi(editable.lastFrame() ?? '')).toContain('x remove');
    cleanup();

    // No handler, so the sheet is a read-only list and must not promise a key.
    const readOnly = render(panel());
    expect(stripAnsi(readOnly.lastFrame() ?? '')).not.toContain('x remove');
  });

  it('ignores keys while another surface owns the keyboard', () => {
    const onRemove = vi.fn(() => ({ ok: true }));
    const view = render(panel({ onRemove, active: false }));

    view.stdin.write('x');

    expect(onRemove).not.toHaveBeenCalled();
  });

  it('points somewhere useful when there are no rules', () => {
    const view = render(panel({ permissions: { allow: [], ask: [], deny: [] } }));
    expect(stripAnsi(view.lastFrame() ?? '')).toContain('Always allow');
  });
});
