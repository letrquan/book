import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../test/fixtures.js';
import type { ProviderStreamEvent } from '../types/providers.js';
import { chatCompletionStream as anthropicStream } from './anthropic.js';
import { chatCompletionStream as openAiStream } from './openai-compatible.js';
import {
  ERROR_BODY_READ_TIMEOUT_MS,
  fetchWithRetry,
  formatApiError,
  readErrorBody,
  statedWaitErrorEvent,
} from './reliability.js';

const NO_BODY = 'no response body received';
const EMPTY_BODY = '(empty response body)';
const request = { url: 'https://api.example.test/v1/chat/completions', model: 'm-1' };

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

/** A body that sends nothing and never ends, so only the read bound can stop it. */
function stalledBody(prefix?: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix) controller.enqueue(new TextEncoder().encode(prefix));
    },
  });
}

describe('readErrorBody tells an empty body from one that never arrived', () => {
  it('reports a body that completed with no bytes as empty', async () => {
    const response = new Response('', { status: 404 });
    expect(await readErrorBody(response)).toEqual({ text: '', received: true });
  });

  it('reports a null body as empty', async () => {
    const response = new Response(null, { status: 404 });
    expect(response.body).toBeNull();
    expect(await readErrorBody(response)).toEqual({ text: '', received: true });
  });

  it('reports a signal that was already aborted as not received', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await readErrorBody(new Response('late', { status: 404 }), controller.signal)).toEqual({
      text: '',
      received: false,
    });
  });

  it('reports a body something else already locked as not received', async () => {
    const response = new Response('locked', { status: 404 });
    response.body!.getReader();
    expect(await readErrorBody(response)).toEqual({ text: '', received: false });
  });

  it('reports a read that timed out with no bytes as not received', async () => {
    vi.useFakeTimers();
    const pending = readErrorBody(new Response(stalledBody(), { status: 503 }));
    await vi.advanceTimersByTimeAsync(ERROR_BODY_READ_TIMEOUT_MS + 10);
    expect(await pending).toEqual({ text: '', received: false });
  });

  it('reports a stream that errored with no bytes as not received', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError('terminated'));
      },
    });
    expect(await readErrorBody(new Response(body, { status: 502 }))).toEqual({
      text: '',
      received: false,
    });
  });

  it('reports an abort with no bytes as not received', async () => {
    const controller = new AbortController();
    const pending = readErrorBody(new Response(stalledBody(), { status: 502 }), controller.signal);
    controller.abort();
    expect(await pending).toEqual({ text: '', received: false });
  });

  it('keeps the partial text when the read timed out after some bytes', async () => {
    vi.useFakeTimers();
    const pending = readErrorBody(new Response(stalledBody('{"error":"part'), { status: 503 }));
    await vi.advanceTimersByTimeAsync(ERROR_BODY_READ_TIMEOUT_MS + 10);
    expect(await pending).toEqual({ text: '{"error":"part', received: true });
  });

  it('keeps the partial text when the stream errored after some bytes', async () => {
    // `error()` right after `enqueue()` drops the queued chunk, so the break comes on the next pull.
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('half a body'));
        else controller.error(new TypeError('terminated'));
      },
    });
    expect(await readErrorBody(new Response(body, { status: 502 }))).toEqual({
      text: 'half a body',
      received: true,
    });
  });

  it('keeps the partial text when the signal aborted after some bytes', async () => {
    const controller = new AbortController();
    const pending = readErrorBody(
      new Response(stalledBody('some bytes'), { status: 502 }),
      controller.signal,
    );
    // Let the first chunk through before the abort.
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    expect(await pending).toEqual({ text: 'some bytes', received: true });
  });
});

describe('formatApiError words an absent body and an empty one differently', () => {
  it('says no body was received, with the origin, when the caller says so', () => {
    const notReceived = { ...request, bodyReceived: false };
    expect(formatApiError(404, '', undefined, notReceived)).toBe(
      `API Error: 404 from api.example.test for model m-1 (${NO_BODY}). Check the base URL and model id.`,
    );
    expect(formatApiError(503, '', undefined, notReceived)).toContain(`(${NO_BODY})`);
    expect(formatApiError(503, '', undefined, notReceived)).not.toContain(EMPTY_BODY);
  });

  it('still says the body was empty when it arrived empty', () => {
    expect(formatApiError(404, '', undefined, { ...request, bodyReceived: true })).toContain(
      EMPTY_BODY,
    );
    expect(formatApiError(404, '', undefined, request)).toContain(EMPTY_BODY);
  });

  it('keeps a partial body as the text, whether or not the rest arrived', () => {
    const text = formatApiError(502, 'Bad gateway: upstream', undefined, {
      ...request,
      bodyReceived: false,
    });
    expect(text).toContain('Bad gateway: upstream');
    expect(text).not.toContain(NO_BODY);
  });
});

describe('formatApiError names the origin when the body says nothing useful (#424)', () => {
  const CAME_FROM = 'The reply came from api.example.test for model m-1.';
  const CHECK = 'Check the base URL and model id.';

  it.each([
    ['404 page not found', '404 page not found', 'Go net/http'],
    ['404 page not found\n', '404 page not found', 'Go net/http with its newline'],
    ['{}', '{}', 'an empty JSON object'],
    ['[]', '[]', 'an empty JSON array'],
    ['  { }  ', '{ }', 'an empty JSON object with whitespace'],
  ])('keeps %j and says where the reply came from (%s)', (body, shown) => {
    expect(formatApiError(404, body, undefined, request)).toBe(
      `API Error: 404 ${shown}. ${CAME_FROM} ${CHECK}`,
    );
  });

  it('reads the hint as a statement, not an instruction', () => {
    expect(formatApiError(404, '404 page not found', undefined, request)).not.toMatch(/\bReply\b/);
  });

  it.each([
    [
      '<html><head><title>404 Not Found</title></head><body><h1>Not Found</h1></body></html>',
      'an HTML page titled "404 Not Found"',
    ],
    [
      '<!DOCTYPE html>\n<html lang="en"><head>\n<title>\n  Bad   Gateway \n</title></head></html>',
      'an HTML page titled "Bad Gateway"',
    ],
    ['<!DOCTYPE html>\n<html lang="en"><body>Oops</body></html>', 'an HTML page'],
  ])('shows an HTML body as %s, never as its markup', (body, shown) => {
    const text = formatApiError(404, body, undefined, request);
    expect(text).toBe(`API Error: 404 ${shown}. ${CAME_FROM} ${CHECK}`);
    expect(text).not.toContain('<');
  });

  it('finds the title of an HTML page past the first 200 characters', () => {
    const body = `<!DOCTYPE html><html><head>${'<meta name="x" content="y">'.repeat(12)}<title>Not Found</title></head></html>`;
    expect(body.indexOf('<title>')).toBeGreaterThan(200);
    expect(formatApiError(404, body, undefined, request)).toContain(
      'an HTML page titled "Not Found"',
    );
  });

  it('keeps control characters of a page title off the terminal', () => {
    const text = formatApiError(
      404,
      `<html><title>Nope${String.fromCharCode(0x1b)}[2J</title></html>`,
      undefined,
      request,
    );
    expect(text).not.toContain(String.fromCharCode(0x1b));
  });

  it('adds nothing when there is no request to name', () => {
    expect(formatApiError(404, '404 page not found')).toBe('API Error: 404 404 page not found');
  });

  it('still summarises an HTML page when there is no request to name', () => {
    expect(formatApiError(404, '<html><head><title>404 Not Found</title></head></html>')).toBe(
      `API Error: 404 an HTML page titled "404 Not Found". ${CHECK}`,
    );
  });

  it('words the other statuses the same way', () => {
    expect(formatApiError(502, '{}', undefined, request)).toContain(`{}. ${CAME_FROM}`);
    expect(formatApiError(401, '{}', undefined, request)).toContain(`{}. ${CAME_FROM}`);
  });

  it.each([
    '{"error":{"message":"model not found"}}',
    '{"error":"invalid api key"}',
    '{"detail":"nope"}',
    'model `x` does not exist',
  ])('adds no hint to a body that explains itself: %s', (body) => {
    const text = formatApiError(404, body, undefined, request);
    expect(text).not.toContain('api.example.test');
    expect(text).not.toContain('for model m-1');
  });
});

describe('the origin hint never shows userinfo, path or query (#424)', () => {
  // The Fetch spec refuses credentials in a request URL, so a provider call never reaches
  // `formatApiError` with one; the helper is checked directly instead.
  it('is refused by fetch, so the provider level cannot carry userinfo', async () => {
    await expect(fetch('http://user:secret@127.0.0.1:9/v1/x')).rejects.toThrow(/credentials/);
  });

  it.each([
    ['', 'an empty body'],
    ['404 page not found', 'an uninformative body'],
  ])('keeps userinfo, path and query out of the text for %j (%s)', (body) => {
    const text = formatApiError(404, body, undefined, {
      url: 'https://user:secret@api.example.com/v1/x?key=abc',
      model: 'm-1',
    });
    expect(text).toContain('api.example.com');
    for (const hidden of ['user', 'secret', '/v1/x', 'key=abc']) {
      expect(text).not.toContain(hidden);
    }
  });
});

describe('a body that never arrived stays "not received" through the retry wrapper', () => {
  const retry = {
    ...defaultConfig().retry,
    maxAttempts: 1,
    baseDelayMs: 1,
    maxDelayMs: 1,
    totalBudgetMs: 0,
    requestTimeoutMs: 0,
  };

  it('does not turn the exhausted response into an empty body downstream', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(stalledBody(), { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchWithRetry('https://api.example.test/v1', {}, retry);
    await vi.advanceTimersByTimeAsync(2 * ERROR_BODY_READ_TIMEOUT_MS + 100);
    const response = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(503);
    // The provider adapter reads the body again, exactly as it does for any response.
    const errorBody = await readErrorBody(response);
    expect(errorBody).toEqual({ text: '', received: false });
    const event = statedWaitErrorEvent(response, errorBody.text, {
      ...request,
      bodyReceived: errorBody.received,
    });
    expect(event.error).toContain(NO_BODY);
    expect(event.error).toContain('api.example.test');
    expect(event.error).not.toContain(EMPTY_BODY);
  });

  it('keeps an empty body that did arrive as empty after the same retries', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 })),
    );

    const pending = fetchWithRetry('https://api.example.test/v1', {}, retry);
    await vi.advanceTimersByTimeAsync(10);
    const errorBody = await readErrorBody(await pending);

    expect(errorBody).toEqual({ text: '', received: true });
  });

  it('carries the fact when the wait between attempts is interrupted', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stalledBody(), { status: 503 })),
    );
    const controller = new AbortController();

    const pending = fetchWithRetry(
      'https://api.example.test/v1',
      {},
      { ...retry, baseDelayMs: 1_000, maxDelayMs: 1_000 },
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(ERROR_BODY_READ_TIMEOUT_MS + 10);
    controller.abort();
    const response = await pending;

    // The read signal is aborted now, so only the carried fact can say why it is empty.
    expect(await readErrorBody(response, controller.signal)).toEqual({
      text: '',
      received: false,
    });
  });

  it('hands the adapter the body it already read when the signal aborted during the backoff', async () => {
    vi.useFakeTimers();
    const body = '{"error":{"message":"overloaded"}}';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 503 })),
    );
    const controller = new AbortController();

    const pending = fetchWithRetry(
      'https://api.example.test/v1',
      {},
      { ...retry, baseDelayMs: 1_000, maxDelayMs: 1_000 },
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    const response = await pending;

    // The adapter reads with the same, now aborted, signal. The body is in memory, so the abort
    // must not make it read as an empty one.
    const errorBody = await readErrorBody(response, controller.signal);
    expect(errorBody).toEqual({ text: body, received: true });
    const event = statedWaitErrorEvent(response, errorBody.text, {
      ...request,
      bodyReceived: errorBody.received,
    });
    expect(event.error).toContain('overloaded');
    expect(event.error).not.toContain(EMPTY_BODY);
    expect(event.error).not.toContain(NO_BODY);
  });
});

async function collect(
  stream: AsyncGenerator<ProviderStreamEvent>,
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function errorText(events: ProviderStreamEvent[]): string {
  const event = events.find((e) => e.type === 'error');
  if (event?.type !== 'error' || event.error === undefined) {
    throw new Error(`no error event in ${JSON.stringify(events)}`);
  }
  return event.error;
}

const providers = [
  { name: 'openai-compatible', stream: openAiStream },
  { name: 'anthropic', stream: anthropicStream },
] as const;

describe.each(providers)('$name passes { url, model } to the error text', ({ stream }) => {
  const messages = [{ role: 'user' as const, content: 'hi' }];

  async function emptyBodyServer(status: number): Promise<{ origin: string; host: string }> {
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(status);
      res.end();
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const { port } = server.address() as AddressInfo;
    return { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` };
  }

  it('names the server host and the model for an empty 404 from a real server', async () => {
    const { origin, host } = await emptyBodyServer(404);
    const config = defaultConfig({ baseUrl: `${origin}/v1`, model: 'model-under-test' });

    const text = errorText(await collect(stream(config, messages, [])));

    expect(text).toContain(`from ${host}`);
    expect(text).toContain('for model model-under-test');
    expect(text).toContain(EMPTY_BODY);
  });

  it('says no body was received when the error body stalls', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stalledBody(), { status: 404 })),
    );
    const config = defaultConfig({ baseUrl: 'https://api.example.test/v1', model: 'm-stalled' });

    const pending = collect(stream(config, messages, []));
    await vi.advanceTimersByTimeAsync(ERROR_BODY_READ_TIMEOUT_MS + 10);
    const text = errorText(await pending);

    expect(text).toContain(NO_BODY);
    expect(text).toContain('from api.example.test for model m-stalled');
    expect(text).not.toContain(EMPTY_BODY);
  });

  it('says no body was received after retries ran out on stalled error bodies', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stalledBody(), { status: 503 })),
    );
    const base = defaultConfig({ baseUrl: 'https://api.example.test/v1', model: 'm-retried' });
    const config = {
      ...base,
      retry: { ...base.retry, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    };

    const pending = collect(stream(config, messages, []));
    await vi.advanceTimersByTimeAsync(3 * ERROR_BODY_READ_TIMEOUT_MS);
    const text = errorText(await pending);

    expect(text).toContain(NO_BODY);
    expect(text).toContain('api.example.test');
    expect(text).toContain('m-retried');
    expect(text).not.toContain(EMPTY_BODY);
  });
});
