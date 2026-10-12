import { describe, expect, it } from 'vitest';
import { canonicalToolName, displayToolName, unwrapProviderPrefix } from './aliases.js';

describe('unwrapProviderPrefix', () => {
  it.each([
    ['default:Glob', 'Glob'],
    ['default.Bash', 'Bash'],
    ['parent.Read', 'Read'],
    ['tool:Grep', 'Grep'],
    ['functions.TodoWrite', 'TodoWrite'],
  ])('reads %s as %s', (name, unwrapped) => {
    expect(unwrapProviderPrefix(name)).toBe(unwrapped);
  });

  it('leaves names without a known namespace alone', () => {
    expect(unwrapProviderPrefix('Bash')).toBe('Bash');
    expect(unwrapProviderPrefix('pnpm.list')).toBe('pnpm.list');
    expect(unwrapProviderPrefix('mcp__slack__search')).toBe('mcp__slack__search');
  });
});

describe('displayToolName', () => {
  it('shows a namespaced call as the tool it runs as', () => {
    // The transcript gets the call as streamed, before the registry
    // canonicalizes it: the row read `✓ default.Bash` for a call that ran as Bash.
    expect(displayToolName('default.Bash')).toBe('Bash');
    expect(displayToolName('functions.bash')).toBe('Bash');
  });

  it('resolves a legacy alias like canonicalToolName does', () => {
    expect(displayToolName('read_file')).toBe(canonicalToolName('read_file'));
  });

  it('leaves canonicalToolName to matching, unchanged', () => {
    expect(canonicalToolName('default.Bash')).toBe('default.Bash');
  });
});
