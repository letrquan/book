import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry, type CommandDefinition } from './registry.js';

interface TestContext {
  enabled: boolean;
}

type TestEffect = { command: string; args: string };

function definition(name: string): CommandDefinition<TestContext, TestEffect> {
  return {
    name,
    description: `${name} command`,
    execute: ({ rawArguments }) => ({ command: name, args: rawArguments }),
  };
}

describe('CommandRegistry', () => {
  it('resolves exact names and explicit aliases only', () => {
    const registry = new CommandRegistry<TestContext, TestEffect>();
    registry.register({
      ...definition('model'),
      aliases: [{ name: 'models' }],
    });

    expect(registry.execute('model', 'gpt-5', { enabled: true })).toEqual({
      command: 'model',
      args: 'gpt-5',
    });
    expect(registry.execute('models', '', { enabled: true })).toEqual({
      command: 'model',
      args: '',
    });
    expect(registry.execute('modeling', '', { enabled: true })).toBeUndefined();
  });

  it('enforces the selected collision policy for names and aliases', () => {
    const registry = new CommandRegistry<TestContext, TestEffect>();
    registry.register({ ...definition('clear'), aliases: [{ name: 'reset' }] });

    expect(() => registry.register(definition('reset'))).toThrow('Command name collision: reset');
    expect(registry.register(definition('reset'), 'keep-existing')).toBe(false);
    expect(registry.execute('reset', '', { enabled: true })).toEqual({
      command: 'clear',
      args: '',
    });
  });

  it('checks availability before invoking the handler', () => {
    const execute = vi.fn(() => ({ command: 'plan', args: '' }));
    const registry = new CommandRegistry<TestContext, TestEffect>();
    registry.register({
      name: 'plan',
      description: 'Plan command',
      availability: (context) =>
        context.enabled ? true : { available: false, reason: 'Plan mode is disabled.' },
      execute,
    });

    expect(() => registry.execute('plan', '', { enabled: false })).toThrow(
      'Plan mode is disabled.',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects invalid or internally duplicated command names', () => {
    const registry = new CommandRegistry<TestContext, TestEffect>();
    expect(() => registry.register(definition('bad name'))).toThrow('Invalid command name');
    expect(() =>
      registry.register({ ...definition('clear'), aliases: [{ name: 'clear' }] }),
    ).toThrow('duplicate name or alias');
  });
});
