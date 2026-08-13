import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';

export interface McpHttpFixture {
  url: string;
  headerValues: string[];
  methods: string[];
  deleteCount: number;
  close(): Promise<void>;
}

function parseBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      try {
        resolve(chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined);
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function createToolServer(): McpServer {
  const server = new McpServer({ name: 'book-http-fixture', version: '1.0.0' });
  server.registerTool(
    'echo',
    {
      description: 'Echo HTTP fixture input',
      inputSchema: { value: z.string() },
    },
    async ({ value }) => ({ content: [{ type: 'text', text: value }] }),
  );
  return server;
}

export async function createMcpHttpFixture(headerName = 'x-book-test'): Promise<McpHttpFixture> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const mcpServers = new Set<McpServer>();
  const headerValues: string[] = [];
  const methods: string[] = [];
  let deleteCount = 0;

  const httpServer = createServer(async (request, response) => {
    methods.push(request.method ?? 'UNKNOWN');
    const header = request.headers[headerName];
    if (Array.isArray(header)) headerValues.push(...header);
    else if (header) headerValues.push(header);

    try {
      const sessionId = request.headers['mcp-session-id'];
      let transport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;

      if (!transport && request.method === 'POST' && sessionId === undefined) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            transports.set(id, transport!);
          },
        });
        const mcpServer = createToolServer();
        mcpServers.add(mcpServer);
        await mcpServer.connect(transport);
      }

      if (!transport) {
        response.writeHead(404).end();
        return;
      }

      if (request.method === 'DELETE') deleteCount++;
      const body = request.method === 'POST' ? await parseBody(request) : undefined;
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' });
      }
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        }),
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture has no TCP address');

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    headerValues,
    methods,
    get deleteCount() {
      return deleteCount;
    },
    async close() {
      await Promise.all([...mcpServers].map((server) => server.close().catch(() => {})));
      await Promise.all(
        [...transports.values()].map((transport) => transport.close().catch(() => {})),
      );
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
        httpServer.closeAllConnections();
      });
    },
  };
}
