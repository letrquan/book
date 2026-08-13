import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export type McpFixtureMode =
  | 'success'
  | 'delay'
  | 'silence'
  | 'malformed'
  | 'exit'
  | 'crash'
  | 'call-silence'
  | 'stderr-call-silence';

const SERVER_SCRIPT = String.raw`
const mode = process.env.BOOK_MCP_FIXTURE_MODE;
const delay = Number(process.env.BOOK_MCP_FIXTURE_DELAY_MS || 0);
if (mode === 'stderr-call-silence') {
  process.stderr.write('discarded-prefix-'.repeat(20) + 'stderr-tail');
}

function respond(message) {
  const send = () => process.stdout.write(JSON.stringify(message) + '\n');
  if (mode === 'delay') setTimeout(send, delay);
  else send();
}

process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    if (mode === 'silence') continue;
    if (mode === 'malformed') {
      process.stdout.write('{not-json}\n');
      continue;
    }
    if (mode === 'exit') process.exit(0);
    if (mode === 'crash') throw new Error('fixture crash');

    const request = JSON.parse(line);
    if (request.id === undefined || request.id === null) continue;
    if (request.method === 'initialize') {
      respond({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'book-mcp-fixture', version: '1.0.0' }
        }
      });
    } else if (request.method === 'tools/list') {
      respond({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: [{
            name: 'echo',
            description: 'Echo fixture input',
            inputSchema: { type: 'object', properties: { value: { type: 'string' } } }
          }]
        }
      });
    } else if (request.method === 'tools/call' && !mode.endsWith('call-silence')) {
      respond({
        jsonrpc: '2.0',
        id: request.id,
        result: { content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }] }
      });
    }
  }
});
`;

export interface McpFixtureServer {
  mode: McpFixtureMode;
  delayMs?: number;
}

export interface McpStdioFixture {
  workspace: string;
  cleanup(): void;
}

export function createMcpStdioFixture(
  servers: Record<string, McpFixtureMode | McpFixtureServer>,
): McpStdioFixture {
  const workspace = mkdtempSync(join(tmpdir(), 'book-mcp-'));
  const mcpServers = Object.fromEntries(
    Object.entries(servers).map(([name, value]) => {
      const config = typeof value === 'string' ? { mode: value } : value;
      return [
        name,
        {
          command: process.execPath,
          args: ['-e', SERVER_SCRIPT],
          env: {
            BOOK_MCP_FIXTURE_MODE: config.mode,
            BOOK_MCP_FIXTURE_DELAY_MS: String(config.delayMs ?? 0),
          },
        },
      ];
    }),
  );
  writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers }));
  return {
    workspace,
    cleanup: () => rmSync(workspace, { recursive: true, force: true }),
  };
}
