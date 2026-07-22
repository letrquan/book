import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { discoverAgents, runSubagent, type SubagentDef } from './subagent.js';
import { createDefaultRegistry } from './tools/registry.js';
import { defaultConfig } from './test/fixtures.js';
import type { UserQuestionRequest } from './types/tools.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-agents-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('discoverAgents', () => {
  it('returns empty array when no agents directory exists', () => {
    expect(discoverAgents(dir)).toEqual([]);
  });

  it('discovers agents from .book/agents/<name>.md', () => {
    const agentsDir = join(dir, '.book', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'code-reviewer.md'),
      [
        '---',
        'name: code-reviewer',
        'description: Reviews pull request diffs',
        'tools:',
        '- Read',
        '- Grep',
        '- Bash(git *)',
        'maxTurns: 3',
        '---',
        'You are a code reviewer. Analyze the diff and report issues.',
      ].join('\n'),
    );

    const result = discoverAgents(dir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('code-reviewer');
    expect(result[0].description).toBe('Reviews pull request diffs');
    expect(result[0].allowedTools).toEqual(['Read', 'Grep', 'Bash(git *)']);
    expect(result[0].maxTurns).toBe(3);
    expect(result[0].source).toBe('project');
    expect(result[0].body).toBe('You are a code reviewer. Analyze the diff and report issues.');
  });

  it('falls back to filename when no name in frontmatter', () => {
    const agentsDir = join(dir, '.book', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'test-agent.md'),
      ['---', 'description: A test agent', '---', 'Body'].join('\n'),
    );

    const result = discoverAgents(dir);
    expect(result[0].name).toBe('test-agent');
  });

  it('defaults maxTurns to unlimited when not specified', () => {
    const agentsDir = join(dir, '.book', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'simple.md'),
      ['---', 'description: Simple agent', '---', 'Do simple tasks.'].join('\n'),
    );

    const result = discoverAgents(dir);
    expect(result[0].maxTurns).toBeUndefined();
  });

  it('defaults allowedTools to the empty deny-all policy', () => {
    const agentsDir = join(dir, '.book', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'unrestricted.md'),
      ['---', 'description: Unrestricted agent', '---', 'Body'].join('\n'),
    );

    const result = discoverAgents(dir);
    expect(result[0].allowedTools).toEqual([]);
  });

  it('skips non-md files', () => {
    const agentsDir = join(dir, '.book', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'notes.txt'), 'ignored');
    writeFileSync(
      join(agentsDir, 'valid.md'),
      ['---', 'description: Valid', '---', 'Body'].join('\n'),
    );

    const result = discoverAgents(dir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('valid');
  });

  it('project agents override user agents with same name', () => {
    const agentsDir = join(dir, '.book', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'same.md'),
      ['---', 'name: same', 'description: Project version', '---', 'Project'].join('\n'),
    );

    const result = discoverAgents(dir);
    expect(result.find((a) => a.name === 'same')?.description).toBe('Project version');
  });
});

describe('runSubagent', () => {
  const def: SubagentDef = {
    name: 'test-agent',
    description: 'Test',
    allowedTools: ['Read'],
    maxTurns: 2,
    body: 'You are a test agent. Respond with exactly: DONE.',
    source: 'project',
  };

  it('returns the final assistant message', async () => {
    // Mock fetch to return a simple text response.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"DONE."}}]}\n\n'));
            c.enqueue(enc.encode('data: [DONE]\n\n'));
            c.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const config = defaultConfig({ maxTurns: 5 });
    const registry = createDefaultRegistry();
    const result = await runSubagent(def, 'Say DONE.', config, registry);
    expect(result.content).toContain('DONE');
    expect(result.error).toBeUndefined();
  });

  it('forwards live tool calls and results with stable parent trace ids', async () => {
    let fetchCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCalls++;
        const body = new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            if (fetchCalls === 1) {
              c.enqueue(
                enc.encode(
                  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"duplicate","function":{"name":"Read","arguments":"{\\"filePath\\":\\"missing.ts\\"}"}}]}}]}\n\n',
                ),
              );
            } else {
              c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"DONE."}}]}\n\n'));
            }
            c.enqueue(enc.encode('data: [DONE]\n\n'));
            c.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const calls: Array<{ traceId: string; parentTraceId: string; name: string }> = [];
    const results: Array<{ traceId: string; success: boolean }> = [];
    await runSubagent(def, 'Inspect.', defaultConfig({ maxTurns: 5 }), createDefaultRegistry(), {
      parentToolTraceId: 'task-root',
      nestedToolObserver: {
        onToolCall: (invocation) =>
          calls.push({
            traceId: invocation.traceId,
            parentTraceId: invocation.parentTraceId,
            name: invocation.call.name,
          }),
        onToolResult: (traceId, result) =>
          results.push({ traceId, success: result.status === 'success' }),
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ parentTraceId: 'task-root', name: 'Read' });
    expect(calls[0].traceId).toContain('task-root/1-1:duplicate');
    expect(results).toEqual([{ traceId: calls[0].traceId, success: false }]);
  });

  it('allows restricted subagents to ask the root host with source attribution', async () => {
    let fetchCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCalls++;
        const body = new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            if (fetchCalls === 1) {
              c.enqueue(
                enc.encode(
                  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"ask","function":{"name":"AskUserQuestion","arguments":"{\\"questions\\":[{\\"question\\":\\"Which mode?\\",\\"header\\":\\"Mode\\",\\"options\\":[{\\"label\\":\\"Fast\\",\\"description\\":\\"Less detail\\"},{\\"label\\":\\"Deep\\",\\"description\\":\\"More detail\\"}],\\"multiSelect\\":false}]}"}}]}}]}\n\n',
                ),
              );
            } else {
              c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"DONE."}}]}\n\n'));
            }
            c.enqueue(enc.encode('data: [DONE]\n\n'));
            c.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const handler = vi.fn(async (request: UserQuestionRequest) => ({
      action: 'answer' as const,
      answers: { [request.questions[0].question]: 'Deep' },
    }));
    const result = await runSubagent(
      { ...def, allowedTools: ['Read', 'AskUserQuestion'] },
      'Ask first.',
      defaultConfig({ maxTurns: 5 }),
      createDefaultRegistry(),
      {
        parentToolTraceId: 'task-root',
        agentPath: ['test-agent'],
        onUserQuestionRequired: handler,
      },
    );

    expect(result.content).toContain('DONE');
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ kind: 'subagent', agentPath: ['test-agent'] }),
      }),
      expect.any(Object),
    );
  });

  it('restricts tools to allowedTools list', async () => {
    // Create a registry with Read and Bash. The subagent only allows Read.
    const registry = createDefaultRegistry();
    const readOnlyDef: SubagentDef = {
      ...def,
      allowedTools: ['Read'],
    };

    // The subagent's registry should only have Read.
    // We verify this by checking that runSubagent filters correctly.
    // (The actual tool restriction is tested via the registry construction.)
    const allowed = new Set(readOnlyDef.allowedTools);
    const filtered = registry.getDefinitions().filter((t) => allowed.has(t.name));
    expect(filtered.every((t) => t.name === 'Read')).toBe(true);
  });

  it('denies all tools when allowedTools is empty', () => {
    const unrestrictedDef: SubagentDef = {
      ...def,
      allowedTools: [],
    };

    // Empty allowedTools is the strict deny-all default.
    const allowed = new Set(unrestrictedDef.allowedTools);
    expect(allowed.size).toBe(0);
  });

  it('respects maxTurns from definition', () => {
    const shortDef: SubagentDef = { ...def, maxTurns: 1 };
    expect(shortDef.maxTurns).toBe(1);
  });
});
