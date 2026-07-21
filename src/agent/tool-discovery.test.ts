import { describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../test/fixtures.js';
import { createRegistry } from '../tools/registry.js';
import { runAgentLoop } from './loop.js';
import { toolSuccess } from '../tools/result.js';

function streamToolCall(id: string, name: string, args: Record<string, unknown>): ReadableStream {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const argumentsJson = JSON.stringify(JSON.stringify(args));
      controller.enqueue(
        encoder.encode(
          `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"${id}","function":{"name":"${name}","arguments":${argumentsJson}}}]}}]}\n\n`,
        ),
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

function streamText(content: string): ReadableStream {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(`data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}\n\n`),
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

describe('agent tool discovery', () => {
  it('adds ToolSearch matches to the next provider request only', async () => {
    const requestTools: string[][] = [];
    let request = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          tools?: Array<{ function: { name: string } }>;
        };
        requestTools.push(body.tools?.map((tool) => tool.function.name) ?? []);
        request++;
        return new Response(
          request === 1
            ? streamToolCall('search-1', 'ToolSearch', { query: 'special capability 3' })
            : streamText('done'),
          { status: 200 },
        );
      }),
    );

    const registry = createRegistry();
    registry.register({
      name: 'Read',
      description: 'Read files',
      parameters: { type: 'object', properties: {} },
      execute: async () => toolSuccess('read'),
    });
    for (let index = 0; index < 12; index++) {
      registry.register({
        name: `SpecialTool${index}`,
        description: `Special capability ${index}`,
        parameters: { type: 'object', properties: {} },
        execute: async () => toolSuccess('special'),
      });
    }

    await runAgentLoop(
      defaultConfig({ maxTurns: 2 }),
      registry,
      'Find the special tool.',
      [],
      {
        onText: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onError: () => {},
        onTurnStart: () => {},
        onDone: () => {},
        onPermissionRequired: async () => 'allow',
      },
      'auto',
    );

    expect(requestTools[0]).toContain('ToolSearch');
    expect(requestTools[0]).not.toContain('SpecialTool3');
    expect(requestTools[1]).toContain('SpecialTool3');
  });

  it('allows ToolSearch to activate deferred read-only tools in plan mode', async () => {
    const requestTools: string[][] = [];
    const results: Array<{ status: string }> = [];
    let request = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          tools?: Array<{ function: { name: string } }>;
        };
        requestTools.push(body.tools?.map((tool) => tool.function.name) ?? []);
        request++;
        return new Response(
          request === 1
            ? streamToolCall('search-plan', 'ToolSearch', { query: 'git diff' })
            : streamText('done'),
          { status: 200 },
        );
      }),
    );

    const registry = createRegistry();
    registry.register({
      name: 'Read',
      description: 'Read files',
      parameters: { type: 'object', properties: {} },
      execute: async () => toolSuccess('read'),
    });
    registry.register({
      name: 'GitDiff',
      description: 'Show git changes and patches',
      parameters: { type: 'object', properties: {} },
      execute: async () => toolSuccess('diff'),
    });
    const runtimeConfig = defaultConfig({ maxTurns: 2 });
    runtimeConfig.settings.toolDiscovery.mode = 'deferred';

    await runAgentLoop(
      runtimeConfig,
      registry,
      'Inspect the planned changes.',
      [],
      {
        onText: () => {},
        onToolCall: () => {},
        onToolResult: (result) => results.push(result),
        onError: () => {},
        onTurnStart: () => {},
        onDone: () => {},
        onPermissionRequired: async () => 'allow',
      },
      'plan',
    );

    expect(results[0]?.status).toBe('success');
    expect(requestTools[0]).toContain('ToolSearch');
    expect(requestTools[0]).not.toContain('GitDiff');
    expect(requestTools[1]).toContain('GitDiff');
  });
});
