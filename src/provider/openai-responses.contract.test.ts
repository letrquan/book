/**
 * Contract: the Responses API client against a local HTTP server that streams recorded
 * Responses SSE, through `createProvider`, the way the agent loop reaches it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProviderStreamEvent } from '../types/providers.js';
import type { ToolDefinition } from '../types/tools.js';
import { defaultConfig } from '../test/fixtures.js';
import { createProvider } from './port.js';

/** A tool definition the request only describes; nothing here runs it. */
function describedTool(fields: Omit<ToolDefinition, 'execute'>): ToolDefinition {
  return { ...fields, execute: () => Promise.reject(new Error('not run in this test')) };
}

/** One recorded stream: OpenAI's framing, `event:` line then `data:` line, split mid-event. */
const TOOL_TURN = [
  {
    type: 'response.created',
    sequence_number: 0,
    response: { id: 'resp_c1', object: 'response', model: 'gpt-c-2026', status: 'in_progress' },
  },
  {
    type: 'response.output_item.added',
    sequence_number: 1,
    output_index: 0,
    item: { type: 'reasoning', id: 'rs_c1', summary: [] },
  },
  {
    type: 'response.reasoning_summary_text.delta',
    sequence_number: 2,
    item_id: 'rs_c1',
    output_index: 0,
    summary_index: 0,
    delta: 'Need to look at the file.',
  },
  {
    type: 'response.output_item.added',
    sequence_number: 3,
    output_index: 1,
    item: { type: 'message', id: 'msg_c1', role: 'assistant', status: 'in_progress', content: [] },
  },
  {
    type: 'response.output_text.delta',
    sequence_number: 4,
    item_id: 'msg_c1',
    output_index: 1,
    content_index: 0,
    delta: 'Reading it ',
  },
  {
    type: 'response.output_text.delta',
    sequence_number: 5,
    item_id: 'msg_c1',
    output_index: 1,
    content_index: 0,
    delta: 'now.',
  },
  {
    type: 'response.output_item.added',
    sequence_number: 6,
    output_index: 2,
    item: {
      type: 'function_call',
      id: 'fc_c1',
      call_id: 'call_c1',
      name: 'Read',
      arguments: '',
      status: 'in_progress',
    },
  },
  {
    type: 'response.function_call_arguments.delta',
    sequence_number: 7,
    item_id: 'fc_c1',
    output_index: 2,
    delta: '{"file_path":',
  },
  {
    type: 'response.function_call_arguments.delta',
    sequence_number: 8,
    item_id: 'fc_c1',
    output_index: 2,
    delta: '"src/a.ts"}',
  },
  {
    type: 'response.function_call_arguments.done',
    sequence_number: 9,
    item_id: 'fc_c1',
    output_index: 2,
    arguments: '{"file_path":"src/a.ts"}',
  },
  {
    type: 'response.completed',
    sequence_number: 10,
    response: {
      id: 'resp_c1',
      object: 'response',
      model: 'gpt-c-2026',
      status: 'completed',
      usage: {
        input_tokens: 2000,
        input_tokens_details: { cached_tokens: 1500 },
        output_tokens: 80,
        output_tokens_details: { reasoning_tokens: 40 },
        total_tokens: 2080,
      },
    },
  },
];

const FAILED_TURN = [
  { type: 'response.created', response: { id: 'resp_c2', model: 'gpt-c-2026' } },
  {
    type: 'response.failed',
    response: {
      id: 'resp_c2',
      status: 'failed',
      error: { code: 'rate_limit_exceeded', message: 'Rate limit reached for requests.' },
    },
  },
];

const INCOMPLETE_TURN = [
  {
    type: 'response.output_text.delta',
    item_id: 'msg_c3',
    output_index: 0,
    content_index: 0,
    delta: 'cut',
  },
  {
    type: 'response.incomplete',
    response: {
      id: 'resp_c3',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      usage: { input_tokens: 10, output_tokens: 4096, total_tokens: 4106 },
    },
  },
];

interface Fixture {
  baseUrl: string;
  requests: Array<{ url: string; authorization?: string; body: Record<string, unknown> }>;
}

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixture(stream: Array<Record<string, unknown>>): Promise<Fixture> {
  const requests: Fixture['requests'] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      requests.push({
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body: JSON.parse(raw || '{}') as Record<string, unknown>,
      });
      if (req.method !== 'POST' || !req.url?.endsWith('/v1/responses')) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const wire = stream
        .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
        .join('');
      // Split the recording at arbitrary points: an event never arrives whole by contract.
      for (let at = 0; at < wire.length; at += 37) res.write(wire.slice(at, at + 37));
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
  };
}

async function run(baseUrl: string): Promise<ProviderStreamEvent[]> {
  const config = defaultConfig({
    baseUrl,
    apiKey: 'sk-contract',
    model: 'gpt-c',
    providerApi: 'responses',
    effort: 'medium',
    effortExplicit: true,
  });
  const provider = createProvider(config);
  expect(provider.id).toBe('openai-responses');
  const events: ProviderStreamEvent[] = [];
  for await (const event of provider.stream(
    config,
    [
      { role: 'system', content: 'You are Book.' },
      { role: 'user', content: 'Open src/a.ts' },
    ],
    [describedTool({ name: 'Read', description: 'Read a file', parameters: { type: 'object' } })],
  )) {
    events.push(event);
  }
  return events;
}

describe('Responses API contract (mock SSE server)', () => {
  it('sends a plan-compatible request and maps a reasoning, text and tool-call turn', async () => {
    const server = await fixture(TOOL_TURN);
    const events = await run(server.baseUrl);

    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    expect(request.url).toBe('/v1/responses');
    expect(request.authorization).toBe('Bearer sk-contract');
    expect(request.body).toEqual({
      model: 'gpt-c',
      instructions: 'You are Book.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Open src/a.ts' }] }],
      stream: true,
      store: false,
      reasoning: { effort: 'medium', summary: 'auto' },
      tools: [
        {
          type: 'function',
          name: 'Read',
          description: 'Read a file',
          parameters: { type: 'object' },
          strict: false,
        },
      ],
    });

    expect(events).toEqual([
      { type: 'reasoning', reasoning: 'Need to look at the file.' },
      { type: 'text', content: 'Reading it ' },
      { type: 'text', content: 'now.' },
      {
        type: 'tool_call',
        toolCall: { id: 'call_c1', name: 'Read', arguments: { file_path: 'src/a.ts' } },
      },
      {
        type: 'done',
        usage: {
          promptTokens: 500,
          completionTokens: 80,
          totalTokens: 2080,
          cacheReadInputTokens: 1500,
          cacheCreationInputTokens: 0,
        },
        responseModel: 'gpt-c-2026',
        responseId: 'resp_c1',
        finishReasons: ['tool_calls'],
      },
    ]);
  });

  it('surfaces response.failed as a classified, re-sendable error', async () => {
    const server = await fixture(FAILED_TURN);
    const events = await run(server.baseUrl);
    expect(events).toEqual([
      {
        type: 'error',
        error: 'Responses API error (rate_limit_exceeded): Rate limit reached for requests.',
        errorCode: 'rate_limited',
      },
    ]);
  });

  it('reports response.incomplete at the output cap as a length finish', async () => {
    const server = await fixture(INCOMPLETE_TURN);
    const events = await run(server.baseUrl);
    expect(events).toEqual([
      { type: 'text', content: 'cut' },
      {
        type: 'done',
        usage: { promptTokens: 10, completionTokens: 4096, totalTokens: 4106 },
        responseId: 'resp_c3',
        finishReasons: ['length'],
      },
    ]);
  });
});
