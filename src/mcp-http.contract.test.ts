import { afterEach, describe, expect, it } from 'vitest';
import { connectMcpServers, disconnectMcpServers } from './mcp.js';
import { createMcpHttpFixture, type McpHttpFixture } from './test/mcp-http-fixture.js';

const fixtures: McpHttpFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close();
});

describe('MCP Streamable HTTP transport', () => {
  it('initializes, discovers and calls tools, sends headers, and terminates the session', async () => {
    const fixture = await createMcpHttpFixture();
    fixtures.push(fixture);

    const result = await connectMcpServers(process.cwd(), {
      initializationTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      servers: {
        remote: {
          type: 'http',
          url: fixture.url,
          headers: { 'X-Book-Test': 'fixture-secret' },
        },
      },
    });

    expect(result.connections).toHaveLength(1);
    const connection = result.connections[0];
    expect(connection.process).toBeUndefined();
    expect(connection.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(connection.serverInfo).toEqual({ name: 'book-http-fixture', version: '1.0.0' });
    expect(result.tools.map((tool) => tool.name)).toEqual(['mcp__remote__echo']);

    const toolResult = await result.tools[0].execute(
      { value: 'hello over HTTP' },
      { workspaceRoot: process.cwd(), env: {} },
    );
    expect(toolResult.status).toBe('success');
    expect(toolResult.content).toBe('hello over HTTP');

    await disconnectMcpServers(result.connections);
    expect(connection.closed).toBe(true);
    expect(fixture.headerValues).toEqual(
      expect.arrayContaining(['fixture-secret', 'fixture-secret', 'fixture-secret']),
    );
    expect(fixture.methods).toContain('DELETE');
    expect(fixture.deleteCount).toBe(1);
  });

  it('redacts configured header values from transport diagnostics', async () => {
    const diagnostics: string[] = [];
    const secret = 'never-print-this-token';
    const result = await connectMcpServers(process.cwd(), {
      initializationTimeoutMs: 100,
      requestTimeoutMs: 100,
      servers: {
        broken: {
          type: 'http',
          url: `http://127.0.0.1:1/${secret}`,
          headers: { Authorization: secret },
        },
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
    });

    expect(result.connections).toEqual([]);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.join('\n')).not.toContain(secret);
  });
});
