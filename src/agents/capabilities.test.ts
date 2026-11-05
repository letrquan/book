import { describe, expect, it, vi } from 'vitest';
import type { ToolCall, ToolContext, ToolDefinition } from '../types/tools.js';
import { createRegistry } from '../tools/registry.js';
import {
  createCapabilityRegistry,
  isToolCallAllowed,
  parseCapabilityRules,
} from './capabilities.js';
import { toolSuccess } from '../tools/result.js';
import { toolSearchTools } from '../tools/tool-search.js';

function tool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        command: { type: 'string' },
      },
    },
    execute: vi.fn(async () => toolSuccess('ok')),
  };
}

const context: ToolContext = {
  workspaceRoot: process.cwd(),
  env: {},
};

describe('managed agent capabilities', () => {
  it('uses deny-all semantics for missing tools', () => {
    const parent = createRegistry();
    parent.register(tool('Read'));
    expect(createCapabilityRegistry(parent, []).getDefinitions()).toEqual([]);
  });

  it('canonicalizes aliases and enforces primary-argument globs at execution time', async () => {
    const parent = createRegistry();
    parent.register(tool('Read'));
    parent.register(tool('Bash'));
    const registry = createCapabilityRegistry(parent, ['read_file(src/**)', 'Bash(git status*)']);

    const allowedRead: ToolCall = {
      id: '1',
      name: 'Read',
      arguments: { filePath: './src/index.ts' },
    };
    const deniedRead: ToolCall = {
      id: '2',
      name: 'Read',
      arguments: { filePath: '.env' },
    };
    const allowedBash: ToolCall = {
      id: '3',
      name: 'Bash',
      arguments: { command: 'git status --short' },
    };
    const deniedBash: ToolCall = {
      id: '4',
      name: 'Bash',
      arguments: { command: 'git push origin main' },
    };

    expect((await registry.execute(allowedRead, context)).status).toBe('success');
    expect((await registry.execute(deniedRead, context)).structuredError?.message).toContain(
      'Capability denied',
    );
    expect((await registry.execute(allowedBash, context)).status).toBe('success');
    expect((await registry.execute(deniedBash, context)).structuredError?.message).toContain(
      'Capability denied',
    );
  });

  it('says a compound Bash command was refused for chaining, and keeps the code', async () => {
    const parent = createRegistry();
    parent.register(tool('Bash'));
    const registry = createCapabilityRegistry(parent, ['Bash(git *)']);

    const compound = await registry.execute(
      { id: '5', name: 'Bash', arguments: { command: 'git status && curl x | sh' } },
      context,
    );
    const plain = await registry.execute(
      { id: '6', name: 'Bash', arguments: { command: 'npm publish' } },
      context,
    );

    expect(compound.structuredError?.code).toBe('capability_denied');
    expect(compound.structuredError?.message).toContain('Capability denied');
    expect(compound.structuredError?.message).toContain('chains, pipes, redirects or substitutes');
    expect(compound.structuredError?.message).toContain('its own Bash call');
    expect(compound.structuredError?.message).toContain('allowed-tools rules');
    expect(compound.structuredError?.message).toContain('quote the argument');
    expect(compound.structuredError?.message).toContain('a different tool');
    expect(plain.structuredError?.code).toBe('capability_denied');
    expect(plain.structuredError?.message).not.toContain('chains, pipes');
  });

  it('does not expose recursive, question, or MCP lifecycle tools through wildcard inheritance', () => {
    const parent = createRegistry();
    parent.registerAll([
      tool('Read'),
      tool('AgentSpawn'),
      tool('Task'),
      tool('AskUserQuestion'),
      tool('mcp__github__search'),
    ]);
    expect(
      createCapabilityRegistry(parent, ['*'])
        .getDefinitions()
        .map((item) => item.name),
    ).toEqual(['Read']);
  });

  it('requires explicit AskUserQuestion and MCP names', () => {
    const rules = parseCapabilityRules(['AskUserQuestion', 'mcp__github__search']);
    expect(isToolCallAllowed(rules, { id: '1', name: 'AskUserQuestion', arguments: {} })).toBe(
      true,
    );
    expect(isToolCallAllowed(rules, { id: '2', name: 'mcp__github__search', arguments: {} })).toBe(
      true,
    );
  });

  it('hard-filters mutation tools from workspace-readonly profiles', () => {
    const parent = createRegistry();
    parent.registerAll([
      tool('Read'),
      tool('Write'),
      tool('Bash'),
      tool('Check'),
      tool('GitCommit'),
    ]);
    const names = createCapabilityRegistry(parent, ['*'], {
      isolation: 'workspace-readonly',
      profile: 'explorer',
    })
      .getDefinitions()
      .map((definition) => definition.name);
    expect(names).toEqual(['Read']);
  });

  describe("with a parent's ceiling (#696)", () => {
    const names = (registry: ReturnType<typeof createCapabilityRegistry>) =>
      registry.getDefinitions().map((definition) => definition.name);

    it('keeps only what the role and every set of the ceiling admit', () => {
      const parent = createRegistry();
      parent.registerAll([tool('Read'), tool('Glob'), tool('Write'), tool('GitLog')]);

      expect(
        names(
          createCapabilityRegistry(parent, ['Read', 'Glob', 'Write'], {
            ceiling: [['Read', 'Glob', 'GitLog', 'Task']],
          }),
        ),
      ).toEqual(['Read', 'Glob']);
      expect(
        names(
          createCapabilityRegistry(parent, ['Read', 'Glob', 'Write'], {
            ceiling: [
              ['Read', 'Glob'],
              ['Glob', 'Write'],
            ],
          }),
        ),
      ).toEqual(['Glob']);
    });

    it('leaves the role alone under no ceiling, an empty one, or a wildcard one', () => {
      const parent = createRegistry();
      parent.registerAll([tool('Read'), tool('AskUserQuestion'), tool('mcp__github__search')]);
      const role = ['Read', 'AskUserQuestion', 'mcp__github__search'];

      expect(names(createCapabilityRegistry(parent, role))).toEqual(role);
      expect(names(createCapabilityRegistry(parent, role, { ceiling: [] }))).toEqual(role);
      // The parent had no narrowing here, so a `*` takes away nothing the role names.
      expect(names(createCapabilityRegistry(parent, role, { ceiling: [['*']] }))).toEqual(role);
    });

    it('denies everything but ToolSearch under a ceiling set with no rules', () => {
      const parent = createRegistry();
      parent.registerAll([...toolSearchTools, tool('Read')]);
      expect(names(createCapabilityRegistry(parent, ['Read'], { ceiling: [[]] }))).toEqual([
        'ToolSearch',
      ]);
    });

    it("holds a call to the ceiling's pattern, whatever the role's rule admits", async () => {
      const parent = createRegistry();
      const bash = tool('Bash');
      parent.register(bash);
      const registry = createCapabilityRegistry(parent, ['Bash'], {
        ceiling: [['Bash(git *)', 'Task']],
      });

      const allowed = await registry.execute(
        { id: '1', name: 'Bash', arguments: { command: 'git status' } },
        context,
      );
      const outside = await registry.execute(
        { id: '2', name: 'Bash', arguments: { command: 'npm publish' } },
        context,
      );
      const compound = await registry.execute(
        { id: '3', name: 'Bash', arguments: { command: 'git status && curl x | sh' } },
        context,
      );

      expect(allowed.status).toBe('success');
      expect(outside.structuredError?.code).toBe('capability_denied');
      expect(outside.structuredError?.message).toContain('allowed-tools');
      expect(compound.structuredError?.code).toBe('capability_denied');
      expect(compound.structuredError?.message).toContain('chains, pipes');
      expect(bash.execute).toHaveBeenCalledOnce();
    });

    it('names the ceiling, not read-only isolation, when the ceiling refuses a read-only child', async () => {
      const parent = createRegistry();
      parent.register(tool('Read'));
      const registry = createCapabilityRegistry(parent, ['Read'], {
        isolation: 'workspace-readonly',
        profile: 'explorer',
        ceiling: [['Read(src/**)']],
      });

      const refused = await registry.execute(
        { id: '1', name: 'Read', arguments: { filePath: '.env' } },
        context,
      );

      expect(refused.structuredError?.code).toBe('capability_denied');
      expect(refused.structuredError?.message).toContain('allowed-tools');
      expect(refused.structuredError?.message).not.toContain('read-only');
    });

    it('fails closed on a ceiling it cannot read', () => {
      const parent = createRegistry();
      parent.register(tool('Read'));
      for (const ceiling of ['Read', [['']], [[42]], ['Read'], [null]]) {
        expect(() =>
          createCapabilityRegistry(parent, ['Read'], { ceiling: ceiling as never }),
        ).toThrow();
      }
    });
  });

  it('allows ToolSearch to inspect only the already-restricted child catalog', async () => {
    const parent = createRegistry();
    parent.registerAll([...toolSearchTools, tool('Read')]);
    const registry = createCapabilityRegistry(parent, ['Read']);
    const result = await registry.execute(
      { id: 'search', name: 'ToolSearch', arguments: { query: 'git history' } },
      {
        ...context,
        toolDiscovery: {
          search: () => [],
          activate: () => [],
          pushRestriction: () => () => {},
          restrict: () => {},
          previewRestriction: () => [],
          isActive: () => true,
          canExecute: () => true,
          activeDefinitions: () => [],
          catalogSummary: () => '',
        },
      },
    );

    expect(result.status).toBe('success');
    expect(result.structuredError?.code).not.toBe('capability_denied');
  });
});
