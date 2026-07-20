import { describe, expect, it, vi } from 'vitest';
import type { ToolCall, ToolContext, ToolDefinition } from '../types.js';
import { createRegistry } from '../tools/registry.js';
import {
  createCapabilityRegistry,
  isToolCallAllowed,
  parseCapabilityRules,
} from './capabilities.js';

function tool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    execute: vi.fn(async () => ({ toolCallId: '', success: true, output: 'ok' })),
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

    expect((await registry.execute(allowedRead, context)).success).toBe(true);
    expect((await registry.execute(deniedRead, context)).error).toContain('Capability denied');
    expect((await registry.execute(allowedBash, context)).success).toBe(true);
    expect((await registry.execute(deniedBash, context)).error).toContain('Capability denied');
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
});
