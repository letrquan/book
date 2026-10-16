import { describe, expect, it } from 'vitest';
import type { BackgroundShellStore } from '../types/runtime.js';
import { nextShellIdAfter, seedShellIds } from './shell-ids.js';

describe('nextShellIdAfter', () => {
  it('is 1 when nothing names a shell', () => {
    expect(nextShellIdAfter()).toBe(1);
    expect(nextShellIdAfter([{ role: 'user', content: 'no shells here' }], undefined, null)).toBe(
      1,
    );
  });

  it('is one past the highest id across transcript text, a tool result and a tool call input', () => {
    const transcript = [{ role: 'user', content: 'Background shell `build` (shell_1) exited.' }];
    const history = [
      { role: 'tool', toolResult: { content: 'Started background shell shell_2 (pid 12).' } },
      { role: 'assistant', toolCalls: [{ name: 'KillShell', input: { shell_id: 'shell_3' } }] },
    ];

    expect(nextShellIdAfter(transcript, history)).toBe(4);
  });

  it('reads an id that follows an escaped newline', () => {
    expect(nextShellIdAfter([{ content: 'done\nshell_7\n' }])).toBe(8);
  });

  it('ignores a persistent id, even one whose first group is all digits', () => {
    expect(nextShellIdAfter([{ content: 'shell_12345678-aaaa-bbbb-cccc-1234567890ab' }])).toBe(1);
    expect(
      nextShellIdAfter([
        { content: 'shell_12345678-aaaa-bbbb-cccc-1234567890ab and shell_2 (shell_9a)' },
      ]),
    ).toBe(3);
  });

  it('compares ids as numbers, so shell_10 is past shell_9', () => {
    expect(nextShellIdAfter([{ content: 'shell_9 then shell_10' }])).toBe(11);
    expect(nextShellIdAfter([{ content: 'shell_10 then shell_9' }])).toBe(11);
  });

  it('does not match a longer word that ends in the id', () => {
    expect(nextShellIdAfter([{ content: 'myshell_5 and a_shell_6' }])).toBe(1);
  });
});

describe('seedShellIds', () => {
  it('raises nextId on the store it is given and never lowers it', () => {
    const store: BackgroundShellStore = { nextId: 1, shells: new Map() };
    seedShellIds(store, [{ content: 'shell_3' }]);
    expect(store.nextId).toBe(4);

    seedShellIds(store, [{ content: 'shell_1' }]);
    expect(store.nextId).toBe(4);
  });
});
