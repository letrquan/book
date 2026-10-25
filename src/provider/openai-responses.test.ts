import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderStreamEvent } from '../types/providers.js';
import type { ToolDefinition } from '../types/tools.js';
import { defaultConfig } from '../test/fixtures.js';
import {
  convertResponsesTools,
  parseResponsesUsage,
  responsesErrorCode,
  responsesStream,
  toResponsesInput,
} from './openai-responses.js';
import { createProvider } from './port.js';

/** A tool definition the request only describes; nothing here runs it. */
function describedTool(fields: Omit<ToolDefinition, 'execute'>): ToolDefinition {
  return { ...fields, execute: () => Promise.reject(new Error('not run in this test')) };
}

const config = defaultConfig({
  baseUrl: 'http://localhost/v1',
  model: 'gpt-test',
  providerApi: 'responses',
});

let capturedUrl = '';
let capturedBody: Record<string, unknown>;

/** A 200 SSE response that sends each event as one `event:`/`data:` pair, as OpenAI does. */
function sse(events: Array<Record<string, unknown>>, options: { close?: boolean } = {}): Response {
  const body = new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      for (const event of events) {
        c.enqueue(enc.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`));
      }
      if (options.close !== false) c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const completed = (extra: Record<string, unknown> = {}) => ({
  type: 'response.completed',
  response: {
    id: 'resp_1',
    model: 'gpt-test-2026',
    status: 'completed',
    usage: {
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 100 },
      output_tokens: 30,
      output_tokens_details: { reasoning_tokens: 10 },
      total_tokens: 150,
    },
    ...extra,
  },
});

function stubFetch(respond: () => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return respond();
    }),
  );
}

async function collect(stream: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

beforeEach(() => {
  capturedUrl = '';
  capturedBody = {};
  stubFetch(() => sse([completed()]));
});

describe('provider selection', () => {
  it('routes an OpenAI-type config with providerApi "responses" to the Responses client', () => {
    expect(createProvider(config).id).toBe('openai-responses');
  });

  it('keeps the Chat Completions client when providerApi is unset or "chat"', () => {
    expect(createProvider(defaultConfig()).id).toBe('openai-compatible');
    expect(createProvider(defaultConfig({ providerApi: 'chat' })).id).toBe('openai-compatible');
  });

  it('never routes an Anthropic config to the Responses client', () => {
    expect(createProvider({ ...config, provider: 'anthropic' }).id).toBe('anthropic');
  });
});

describe('responsesStream request body', () => {
  it('posts to <baseUrl>/responses with stream: true and store: false', async () => {
    await collect(responsesStream(config, [{ role: 'user', content: 'hi' }], []));
    expect(capturedUrl).toBe('http://localhost/v1/responses');
    expect(capturedBody).toMatchObject({ model: 'gpt-test', stream: true, store: false });
    expect(capturedBody).not.toHaveProperty('messages');
    expect(capturedBody).not.toHaveProperty('previous_response_id');
  });

  it('sends the system prompt as instructions, zones joined like the chat client', async () => {
    await collect(
      responsesStream(
        config,
        [
          { role: 'system', content: { cachedPrefix: 'kernel', dynamicSuffix: 'skills' } },
          { role: 'user', content: 'hi' },
        ],
        [],
      ),
    );
    expect(capturedBody.instructions).toBe('kernel\n\nskills');
    expect(capturedBody.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
  });

  it('omits max_output_tokens for the generic default and sends an explicit one', async () => {
    await collect(responsesStream(config, [{ role: 'user', content: 'hi' }], []));
    expect(capturedBody).not.toHaveProperty('max_output_tokens');

    await collect(
      responsesStream(
        { ...config, maxTokens: 4096, maxTokensExplicit: true },
        [{ role: 'user', content: 'hi' }],
        [],
      ),
    );
    expect(capturedBody.max_output_tokens).toBe(4096);

    await collect(
      responsesStream(config, [{ role: 'user', content: 'hi' }], [], { maxOutputTokens: 512 }),
    );
    expect(capturedBody.max_output_tokens).toBe(512);
  });

  it('maps a chosen effort to reasoning.effort with a summary, and sends none otherwise', async () => {
    await collect(responsesStream(config, [{ role: 'user', content: 'hi' }], []));
    expect(capturedBody).not.toHaveProperty('reasoning');

    await collect(
      responsesStream(
        { ...config, effort: 'high', effortExplicit: true },
        [{ role: 'user', content: 'hi' }],
        [],
      ),
    );
    expect(capturedBody.reasoning).toEqual({ effort: 'high', summary: 'auto' });
  });

  it("sends Book's max effort as the API's highest level, xhigh", async () => {
    await collect(
      responsesStream(
        { ...config, effort: 'max', effortExplicit: true },
        [{ role: 'user', content: 'hi' }],
        [],
      ),
    );
    expect(capturedBody.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' });
  });

  it('resends once without the summary when the endpoint refuses reasoning summaries', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return bodies.length === 1
          ? new Response(
              JSON.stringify({
                error: {
                  message: 'Your organization must be verified to generate reasoning summaries.',
                  param: 'reasoning.summary',
                  code: 'unsupported_value',
                },
              }),
              { status: 400 },
            )
          : sse([completed()]);
      }),
    );
    const events = await collect(
      responsesStream(
        { ...config, effort: 'high', effortExplicit: true },
        [{ role: 'user', content: 'hi' }],
        [],
      ),
    );
    expect(bodies.map((b) => b.reasoning)).toEqual([
      { effort: 'high', summary: 'auto' },
      { effort: 'high' },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('reports any other refusal of a reasoning request once, without resending', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: 'Unknown parameter: tools.0' } }), {
          status: 400,
        });
      }),
    );
    const events = await collect(
      responsesStream(
        { ...config, effort: 'high', effortExplicit: true },
        [{ role: 'user', content: 'hi' }],
        [],
      ),
    );
    expect(calls).toBe(1);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        errorCode: 'bad_request',
        error: expect.stringContaining('Unknown parameter'),
      }),
    ]);
  });

  it('sends no reasoning to a model whose catalog entry says effort false, even when chosen', async () => {
    await collect(
      responsesStream(
        { ...config, effort: 'high', effortExplicit: true, modelInfo: { effort: false } },
        [{ role: 'user', content: 'hi' }],
        [],
      ),
    );
    expect(capturedBody).not.toHaveProperty('reasoning');
  });

  it('sends flat, non-strict function tools', async () => {
    await collect(
      responsesStream(
        config,
        [{ role: 'user', content: 'hi' }],
        [
          describedTool({
            name: 'Read',
            description: 'Read a file',
            parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
          }),
        ],
      ),
    );
    expect(capturedBody.tools).toEqual([
      {
        type: 'function',
        name: 'Read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
        strict: false,
      },
    ]);
  });
});

describe('toResponsesInput', () => {
  it('turns tool calls and results into function_call items paired by call_id, with no item ids', () => {
    const { input } = toResponsesInput([
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: 'Reading.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'Read', arguments: '{"file_path":"a.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
      { role: 'assistant', content: 'Done.' },
    ]);
    expect(input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'read it' }] },
      { role: 'assistant', content: 'Reading.' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'Read',
        arguments: '{"file_path":"a.ts"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'file body' },
      { role: 'assistant', content: 'Done.' },
    ]);
    for (const item of input) expect(item).not.toHaveProperty('id');
  });

  it('sends an assistant turn that only called tools as its calls alone', () => {
    const { input } = toResponsesInput([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c', type: 'function', function: { name: 'Glob', arguments: '{}' } }],
      },
    ]);
    expect(input).toEqual([{ type: 'function_call', call_id: 'c', name: 'Glob', arguments: '{}' }]);
  });

  it('serializes images as input_image data URLs, in user turns and tool results', () => {
    const { input } = toResponsesInput([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is shown?' },
          { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_2',
        content: [
          { type: 'text', text: 'screenshot' },
          { type: 'image', mediaType: 'image/jpeg', data: 'd29ybGQ=' },
        ],
      },
    ]);
    expect(input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'What is shown?' },
          { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,aGVsbG8=' },
        ],
      },
      {
        type: 'function_call_output',
        call_id: 'call_2',
        output: [
          { type: 'input_text', text: 'screenshot' },
          { type: 'input_image', detail: 'auto', image_url: 'data:image/jpeg;base64,d29ybGQ=' },
        ],
      },
    ]);
  });

  it('replays prior reasoning as delimited assistant context, as the chat client does', () => {
    const { input } = toResponsesInput([
      { role: 'assistant', content: 'answer', reasoningContent: 'inspect first' },
    ]);
    expect(input).toEqual([
      {
        role: 'assistant',
        content: '<reasoning_context>\ninspect first\n</reasoning_context>\nanswer',
      },
    ]);
  });

  it('keeps a system message after the conversation started as a developer message', () => {
    const { instructions, input } = toResponsesInput([
      { role: 'system', content: 'kernel' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'late notice' },
    ]);
    expect(instructions).toBe('kernel');
    expect(input.at(-1)).toEqual({ role: 'developer', content: 'late notice' });
  });
});

describe('responsesStream events', () => {
  it('streams text and reasoning, then done with usage, ids and a stop finish reason', async () => {
    stubFetch(() =>
      sse([
        { type: 'response.created', response: { id: 'resp_1', model: 'gpt-test-2026' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } },
        {
          type: 'response.reasoning_summary_text.delta',
          item_id: 'rs_1',
          summary_index: 0,
          delta: 'inspect',
        },
        {
          type: 'response.reasoning_summary_text.delta',
          item_id: 'rs_1',
          summary_index: 1,
          delta: 'then answer',
        },
        { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Hello' },
        { type: 'response.output_text.delta', item_id: 'msg_1', delta: ', world' },
        completed(),
      ]),
    );
    const events = await collect(responsesStream(config, [{ role: 'user', content: 'hi' }], []));
    expect(events).toEqual([
      { type: 'reasoning', reasoning: 'inspect' },
      { type: 'reasoning', reasoning: '\n\nthen answer' },
      { type: 'text', content: 'Hello' },
      { type: 'text', content: ', world' },
      {
        type: 'done',
        usage: {
          promptTokens: 20,
          completionTokens: 30,
          totalTokens: 150,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 0,
        },
        responseModel: 'gpt-test-2026',
        responseId: 'resp_1',
        finishReasons: ['stop'],
      },
    ]);
  });

  it('assembles a streamed function call keyed by item id and emits it with its call_id', async () => {
    stubFetch(() =>
      sse([
        {
          type: 'response.output_item.added',
          output_index: 1,
          item: {
            type: 'function_call',
            id: 'fc_b',
            call_id: 'call_b',
            name: 'Glob',
            arguments: '',
          },
        },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_a',
            call_id: 'call_a',
            name: 'Read',
            arguments: '',
          },
        },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '{"file_' },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_b', delta: '{}' },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: 'path":"a"}' },
        completed(),
      ]),
    );
    const events = await collect(responsesStream(config, [{ role: 'user', content: 'hi' }], []));
    expect(events.filter((e) => e.type === 'tool_call').map((e) => e.toolCall)).toEqual([
      { id: 'call_a', name: 'Read', arguments: { file_path: 'a' } },
      { id: 'call_b', name: 'Glob', arguments: {} },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReasons: ['tool_calls'] });
  });

  it('takes the arguments of output_item.done over the streamed fragments', async () => {
    stubFetch(() =>
      sse([
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'Read' },
        },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '{"file_pa' },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_a',
            call_id: 'call_a',
            name: 'Read',
            arguments: '{"file_path":"b"}',
          },
        },
        completed(),
      ]),
    );
    const events = await collect(responsesStream(config, [{ role: 'user', content: 'hi' }], []));
    expect(events.find((e) => e.type === 'tool_call')?.toolCall).toEqual({
      id: 'call_a',
      name: 'Read',
      arguments: { file_path: 'b' },
    });
  });

  it('marks a function call that arrived with no arguments at all (#403)', async () => {
    stubFetch(() =>
      sse([
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'Read' },
        },
        completed(),
      ]),
    );
    const events = await collect(responsesStream(config, [{ role: 'user', content: 'hi' }], []));
    expect(events.find((e) => e.type === 'tool_call')?.toolCall).toEqual({
      id: 'call_a',
      name: 'Read',
      arguments: {},
      emptyOnWire: true,
    });
  });

  it('reports a response cut at max_output_tokens as a length finish, tool calls included', async () => {
    stubFetch(() =>
      sse([
        { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'partial' },
        {
          type: 'response.incomplete',
          response: {
            id: 'resp_2',
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        },
      ]),
    );
    const events = await collect(responsesStream(config, [{ role: 'user', content: 'hi' }], []));
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      responseId: 'resp_2',
      finishReasons: ['length'],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
  });

  it('reads an incomplete response with a missing or unknown reason as truncated, not finished', async () => {
    for (const incomplete_details of [undefined, { reason: 'max_messages' }]) {
      stubFetch(() =>
        sse([
          { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details } },
        ]),
      );
      const events = await collect(responsesStream(config, [{ role: 'user', content: 'hi' }], []));
      expect(events.at(-1)).toMatchObject({ type: 'done', finishReasons: ['length'] });
    }
  });

  it('keeps the text of separate message items apart as paragraphs', async () => {
    stubFetch(() =>
      sse([
        { type: 'response.output_text.delta', item_id: 'msg_1', delta: "I'll check." },
        { type: 'response.output_text.delta', item_id: 'msg_2', delta: 'Here it is' },
        { type: 'response.output_text.delta', item_id: 'msg_2', delta: '.' },
        completed(),
      ]),
    );
    const events = await collect(responsesStream(config, [{ role: 'user', content: 'hi' }], []));
    expect(events.filter((e) => e.type === 'text').map((e) => e.content)).toEqual([
      "I'll check.",
      '\n\nHere it is',
      '.',
    ]);
  });

  it('drops a function call that has neither a call id nor a name', async () => {
    stubFetch(() =>
      sse([
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call' } },
        completed(),
      ]),
    );
    const events = await collect(responsesStream(config, [{ role: 'user', content: 'hi' }], []));
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
  });

  it('reports a content-filtered incomplete response with the content_filter finish reason', async () => {
    stubFetch(() =>
      sse([
        {
          type: 'response.incomplete',
          response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } },
        },
      ]),
    );
    const events = await collect(responsesStream(config, [{ role: 'user', content: 'hi' }], []));
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReasons: ['content_filter'] });
  });

  it('turns response.failed into a classified error event', async () => {
    stubFetch(() =>
      sse([
        { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'par' },
        {
          type: 'response.failed',
          response: {
            status: 'failed',
            error: {
              code: 'subscription_sharing_usage_limit_exceeded',
              message: 'You have reached your plan usage limit.',
            },
          },
        },
      ]),
    );
    const events = await collect(responsesStream(config, [{ role: 'user', content: 'hi' }], []));
    expect(events.at(-1)).toEqual({
      type: 'error',
      error:
        'Responses API error (subscription_sharing_usage_limit_exceeded): You have reached your plan usage limit.',
      errorCode: 'usage_limit',
    });
  });

  it('turns a top-level error event into a classified error event', async () => {
    stubFetch(() =>
      sse([
        {
          type: 'error',
          code: 'context_length_exceeded',
          message: 'Your input exceeds the context window of this model.',
          param: 'input',
        },
      ]),
    );
    const events = await collect(responsesStream(config, [{ role: 'user', content: 'hi' }], []));
    expect(events.at(-1)).toMatchObject({ type: 'error', errorCode: 'context_overflow' });
  });

  it('reports a stream that closes before a terminal event as interrupted', async () => {
    stubFetch(() => sse([{ type: 'response.output_text.delta', item_id: 'm', delta: 'half' }]));
    const events = await collect(responsesStream(config, [{ role: 'user', content: 'hi' }], []));
    expect(events.at(-1)).toMatchObject({ type: 'error', errorCode: 'transport_interrupted' });
  });

  it('parses events split across network chunks', async () => {
    const payload = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'joined' })}\n\ndata: ${JSON.stringify(completed())}\n\n`;
    stubFetch(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              const enc = new TextEncoder();
              c.enqueue(enc.encode(payload.slice(0, 17)));
              c.enqueue(enc.encode(payload.slice(17)));
              c.close();
            },
          }),
          { status: 200 },
        ),
    );
    const events = await collect(responsesStream(config, [{ role: 'user', content: 'hi' }], []));
    expect(events[0]).toEqual({ type: 'text', content: 'joined' });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('formats and classifies a non-OK HTTP response like the chat client', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: { message: 'Incorrect API key provided', code: 'invalid_api_key' },
          }),
          { status: 401 },
        ),
    );
    const events = await collect(responsesStream(config, [{ role: 'user', content: 'hi' }], []));
    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        errorCode: 'auth',
        error: expect.stringMatching(/401/),
      }),
    ]);
  });

  it('retries a 503 before the stream opens, through the shared retry policy', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return calls === 1 ? new Response('busy', { status: 503 }) : sse([completed()]);
      }),
    );
    const events = await collect(responsesStream(config, [{ role: 'user', content: 'hi' }], []));
    expect(calls).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('stops quietly when aborted mid-stream', async () => {
    const controller = new AbortController();
    stubFetch(() =>
      sse([{ type: 'response.output_text.delta', item_id: 'm', delta: 'first' }], {
        close: false,
      }),
    );
    const events: ProviderStreamEvent[] = [];
    for await (const event of responsesStream(config, [{ role: 'user', content: 'hi' }], [], {
      signal: controller.signal,
    })) {
      events.push(event);
      controller.abort();
    }
    expect(events).toEqual([{ type: 'text', content: 'first' }]);
  });

  it('yields a stream_stall error when the stream goes silent', async () => {
    const cfg = { ...config, retry: { ...config.retry, streamStallTimeoutMs: 50 } };
    let stalled = false;
    stubFetch(() => sse([], { close: false }));
    const events = await collect(
      responsesStream(cfg, [{ role: 'user', content: 'hi' }], [], {
        onStreamStall: () => {
          stalled = true;
        },
      }),
    );
    expect(stalled).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'error', errorCode: 'stream_stall' });
  });

  it('waits out the thinking ceiling once a reasoning item opens (#379)', async () => {
    const cfg = {
      ...config,
      retry: { ...config.retry, streamStallTimeoutMs: 30, thinkingStallTimeoutMs: 400 },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const enc = new TextEncoder();
        const body = new ReadableStream({
          async start(c) {
            c.enqueue(
              enc.encode(
                `data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } })}\n\n`,
              ),
            );
            await new Promise((resolve) => setTimeout(resolve, 120));
            c.enqueue(enc.encode(`data: ${JSON.stringify(completed())}\n\n`));
            c.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );
    const events = await collect(responsesStream(cfg, [{ role: 'user', content: 'hi' }], []));
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });
});

describe('responses helpers', () => {
  it('maps Responses usage onto Book usage with cached input split out', () => {
    expect(
      parseResponsesUsage({
        input_tokens: 50,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 7,
        total_tokens: 57,
      }),
    ).toEqual({ promptTokens: 50, completionTokens: 7, totalTokens: 57 });
    expect(parseResponsesUsage(undefined)).toBeNull();
  });

  it('classifies the documented error codes onto the codes the loop reads', () => {
    expect(responsesErrorCode('rate_limit_exceeded')).toBe('rate_limited');
    expect(responsesErrorCode('insufficient_quota')).toBe('quota');
    expect(responsesErrorCode('server_error')).toBe('server_error');
    expect(responsesErrorCode('subscription_sharing_usage_unavailable')).toBe('server_error');
    expect(responsesErrorCode('subscription_sharing_invalid_user')).toBe('auth');
    expect(responsesErrorCode('subscription_sharing_unsupported_capability')).toBe('bad_request');
    expect(responsesErrorCode('model_not_found')).toBe('model_unavailable');
    expect(responsesErrorCode('vector_store_timeout')).toBe('timeout');
    expect(responsesErrorCode(undefined)).toBe('provider_error');
  });

  it('never lets a verdict on the request itself be re-sent', () => {
    for (const code of [
      'invalid_prompt',
      'invalid_image_format',
      'invalid_base64_image',
      'image_too_large',
      'image_content_policy_violation',
      'unsupported_image_media_type',
      'failed_to_download_image',
      'bio_policy',
      'subscription_sharing_user_not_eligible',
      'chatpass_v2_scope_not_authorized',
    ]) {
      expect(responsesErrorCode(code)).toBe('bad_request');
    }
  });

  it('convertResponsesTools prefers inputSchema like the chat client', () => {
    expect(
      convertResponsesTools([
        describedTool({
          name: 'X',
          description: 'x',
          parameters: { type: 'object' },
          inputSchema: { type: 'object', properties: {} },
        }),
      ])[0].parameters,
    ).toEqual({ type: 'object', properties: {} });
  });
});
