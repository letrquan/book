/**
 * The loopback listener that receives the authorization redirect.
 *
 * Bound to 127.0.0.1 only: a server on 0.0.0.0 would accept an authorization
 * code from anything that can route to this machine. It serves exactly one
 * successful callback and then stops — a listener that outlives the flow is a
 * standing target for a replayed code.
 *
 * The `state` check runs before anything else is honoured — including an
 * `error` parameter. Otherwise any page the user happens to visit during the
 * login window could kill the flow with a bare
 * `<img src="http://127.0.0.1:54545/callback?error=x">`, which needs no CORS
 * permission and no knowledge of the request. A callback without the matching
 * state is answered 400 and ignored, and the listener keeps waiting.
 *
 * Everything reflected into the response page is HTML-escaped. `error` and
 * `error_description` are request input, and the page is served as text/html
 * from an origin that is about to receive an authorization code.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { onAbort } from '../async.js';
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
  /**
   * Actual bound address. Exposed so a test can assert the loopback-only bind
   * directly: a successful fetch to 127.0.0.1 succeeds on any bind address and
   * proves nothing about the one property that matters here.
   */
  address: string;
  /** Resolves on the first callback carrying a matching state. */
  result: Promise<LoopbackResult>;
  close(): void;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

const PAGE = (title: string, detail: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
  `<body style="font:16px system-ui;margin:4rem auto;max-width:34rem;text-align:center">` +
  `<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body>`;

function send(response: ServerResponse, status: number, title: string, detail: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    // Nothing on this page needs to load or run anything.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  response.end(PAGE(title, detail));
}

/** IPv4 loopback only; see `redirectUri` for why the redirect names it literally. */
const LOOPBACK_ADDRESS = '127.0.0.1';

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
  let unsubscribeAbort: () => void = () => {};

  // A hoisted function so `handler` may call it while `server` below is still
  // being constructed; it never runs before that assignment.
  function close(): void {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    unsubscribeAbort();
    server.close();
  }

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', `http://${LOOPBACK_ADDRESS}:${options.port}`);
    if (url.pathname !== options.path) {
      send(response, 404, 'Not found', 'This is not the Book login callback.');
      return;
    }

    // Before anything else is honoured, `error` included: a request that cannot
    // prove it belongs to this flow may not end it. Otherwise a bare
    // `<img src=".../callback?error=x">` on any page the user visits during the
    // login window is enough to kill the login.
    if (!statesMatch(options.expectedState, url.searchParams.get('state'))) {
      send(
        response,
        400,
        'Unexpected callback',
        'This response does not match a login in progress.',
      );
      return;
    }

    const error = url.searchParams.get('error');
    if (error) {
      const description = url.searchParams.get('error_description') ?? '';
      const detail = `${error}${description ? `: ${description}` : ''}`;
      send(response, 400, 'Login failed', detail);
      fail(new LoopbackError(`Authorization denied (${detail})`));
      close();
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

  const bound = await new Promise<{ port: number; address: string }>((resolve, reject) => {
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
    server.listen(options.port, LOOPBACK_ADDRESS, () => {
      const address = server.address();
      resolve(
        typeof address === 'object' && address
          ? { port: address.port, address: address.address }
          : { port: options.port, address: LOOPBACK_ADDRESS },
      );
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

  // `onAbort` fires immediately for an already-aborted signal, so a login
  // cancelled before the listener bound still tears it down.
  unsubscribeAbort = onAbort(options.signal, () => {
    fail(new LoopbackError('Login cancelled'));
    close();
  });

  // Nothing consumes a rejection until the caller awaits `result`; without this
  // an abort before the await surfaces as an unhandled rejection.
  result.catch(() => {});

  return { ...bound, result, close };
}
