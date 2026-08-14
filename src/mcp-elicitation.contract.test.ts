import { afterEach, describe, expect, it } from 'vitest';
import { connectMcpServers, disconnectMcpServers } from './mcp.js';
import { createMcpStdioFixture, type McpStdioFixture } from './test/mcp-stdio-fixture.js';
import type { ElicitationHandler, ElicitationRequest, ToolContext } from './types/tools.js';

const fixtures: McpStdioFixture[] = [];

function fixture(): McpStdioFixture {
  const item = createMcpStdioFixture({ fixture: 'elicit' });
  fixtures.push(item);
  return item;
}

const context: ToolContext = { workspaceRoot: process.cwd(), env: {} };

async function callWith(onElicit?: ElicitationHandler) {
  const item = fixture();
  const result = await connectMcpServers(item.workspace, {
    // Isolate from any real user-global mcp.json on the developer's machine.
    home: item.workspace,
    initializationTimeoutMs: 1000,
    requestTimeoutMs: 2000,
    onElicit,
  });
  const toolResult = await result.tools[0].execute({ value: 'go' }, context);
  await disconnectMcpServers(result.connections);
  return toolResult;
}

afterEach(() => {
  for (const item of fixtures.splice(0).reverse()) item.cleanup();
});

describe('MCP elicitation', () => {
  it('declares no elicitation capability when the host cannot prompt', async () => {
    const result = await callWith();
    expect(result.status).toBe('error');
    expect(result.structuredError?.message).toMatch(/does not support form elicitation/i);
  });

  it('carries a host answer back inside the open tool call', async () => {
    const seen: ElicitationRequest[] = [];
    const result = await callWith(async (request) => {
      seen.push(request);
      return { action: 'accept', content: { project: 'beta' } };
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      server: 'fixture',
      message: 'Select the project.',
      fields: [
        {
          name: 'project',
          kind: 'enum',
          required: true,
          options: [
            { value: 'alpha', label: 'Alpha' },
            { value: 'beta', label: 'Beta' },
          ],
        },
        { name: 'note', kind: 'string', required: false },
      ],
    });
    expect(result.status).toBe('success');
    expect(JSON.parse(result.content)).toEqual({ action: 'accept', content: { project: 'beta' } });
  });

  it('passes a decline through to the server', async () => {
    const result = await callWith(async () => ({ action: 'decline' }));
    expect(JSON.parse(result.content)).toEqual({ action: 'decline' });
  });

  it('withholds an answer that does not satisfy the requested schema', async () => {
    const result = await callWith(async () => ({
      action: 'accept',
      content: { project: 'gamma' },
    }));
    expect(JSON.parse(result.content)).toEqual({ action: 'cancel' });
  });
});
