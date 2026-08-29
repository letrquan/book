/**
 * The loopback listener that receives the authorization redirect.
 *
 * Bound to 127.0.0.1 only: a server on 0.0.0.0 would accept an authorization
 * code from anything that can route to this machine. It serves exactly one
 * successful callback and then stops — a listener that outlives the flow is a
 * standing target for a replayed code.
 *
 * A callback whose `state` does not match is answered 400 and ignored rather
 * than resolving the promise, so a stray or forged request cannot end the flow
 * the user actually started.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { statesMatch } from './pkce.js';

export interface LoopbackResult {
  code: string;
}

export interface LoopbackOptions {
  /** 0 lets the OS choose, which only works with a wildcard-port redirect URI. */
  port: number;
  path: string;
  expectedState: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LoopbackListener {
  /** Actual bound port, which differs from the requested one when it was 0. */
  port: number;
  /** Resolves on the first callback carrying a matching state. */
  result: Promise<LoopbackResult>;
  close(): void;
}

const PAGE = (title: string, detail: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui;margin:4rem auto;max-width:34rem;text-align:center">` +
  `<h1 style="font-size:1.25rem">${title}</h1><p>${detail}</p></body>`;

function send(response: ServerResponse, status: number, title: string, detail: string): void {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(PAGE(title, detail));
}

export class LoopbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoopbackError';
  }
}

export async function startLoopbackListener(options: LoopbackOptions): Promise<LoopbackListener> {
  let settle: (result: LoopbackResult) => void;
  let fail: (error: Error) => void;
  const result = new Promise<LoopbackResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  // Declared as hoisted functions so `handler` may call them while `server`
  // below is still being constructed; neither runs before it is assigned.
  function close(): void {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    server.close();
  }

  function onAbort(): void {
    fail(new LoopbackError('Login cancelled'));
    close();
  }

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${options.port}`);
    if (url.pathname !== options.path) {
      send(response, 404, 'Not found', 'This is not the Book login callback.');
      return;
    }

    const error = url.searchParams.get('error');
    if (error) {
      const description = url.searchParams.get('error_description') ?? '';
      send(response, 400, 'Login failed', `${error}${description ? `: ${description}` : ''}`);
      fail(
        new LoopbackError(
          `Authorization denied (${error}${description ? `: ${description}` : ''})`,
        ),
      );
      close();
      return;
    }

    if (!statesMatch(options.expectedState, url.searchParams.get('state'))) {
      // Not this flow's callback. Refuse it, keep waiting for the real one.
      send(
        response,
        400,
        'Unexpected callback',
        'This response does not match a login in progress.',
      );
      return;
    }

    const code = url.searchParams.get('code');
    if (!code) {
      send(response, 400, 'Login failed', 'The redirect carried no authorization code.');
      fail(new LoopbackError('Redirect carried no authorization code'));
      close();
      return;
    }

    send(response, 200, 'Signed in', 'You can close this tab and return to your terminal.');
    settle({ code });
    close();
  };

  const server: Server = createServer(handler);

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new LoopbackError(
              `Port ${options.port} is already in use. Close whatever is listening on it — the ` +
                'redirect URI registered with the authorization server requires this exact port.',
            )
          : error,
      );
    });
    server.listen(options.port, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : options.port);
    });
  });

  if (options.timeoutMs && options.timeoutMs > 0) {
    timer = setTimeout(() => {
      fail(
        new LoopbackError(
          `Timed out after ${Math.round(options.timeoutMs! / 1000)}s waiting for the browser redirect`,
        ),
      );
      close();
    }, options.timeoutMs);
    timer.unref?.();
  }

  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  // Nothing consumes a rejection until the caller awaits `result`; without this
  // an abort before the await surfaces as an unhandled rejection.
  result.catch(() => {});

  return { port, result, close };
}
