import { describe, expect, it } from 'vitest';
import { BUILTIN_COMMAND_DEFINITIONS } from '../commands/builtins.js';
import { builtinHelpGroups } from './help-catalog.js';

describe('builtinHelpGroups', () => {
  const groups = builtinHelpGroups();
  const names = groups.flatMap((group) => group.entries.map((entry) => entry.name.split(',')[0]));

  it('lists every visible built-in exactly once', () => {
    // /help used to be hand-written and fell behind the registry; generated,
    // a new command cannot be left out.
    const visible = BUILTIN_COMMAND_DEFINITIONS.filter((definition) => !definition.isHidden).map(
      (definition) => `/${definition.name}`,
    );
    expect([...names].sort()).toEqual([...visible].sort());
  });

  it('leaves hidden commands and hidden aliases out', () => {
    const hidden = BUILTIN_COMMAND_DEFINITIONS.filter((definition) => definition.isHidden);
    for (const definition of hidden) expect(names).not.toContain(`/${definition.name}`);
    const all = groups.flatMap((group) => group.entries.map((entry) => entry.name)).join(' ');
    expect(all).not.toContain('/stats');
  });

  it('folds visible aliases into the command they belong to', () => {
    const clear = groups
      .flatMap((group) => group.entries)
      .find((entry) => entry.name.startsWith('/clear'));
    expect(clear?.name).toBe('/clear, /new');
  });

  it('opens with the conversation group and never leaves a group empty', () => {
    expect(groups[0]?.title).toBe('Conversation');
    for (const group of groups) expect(group.entries.length).toBeGreaterThan(0);
  });
});
