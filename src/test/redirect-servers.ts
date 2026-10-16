import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RedirectFixtureOptions {
  /** The 3xx status server A answers with. Defaults to 307. */
  status?: number;
  /**
   * The `Location` header for a given server-B port; returning undefined sends none.
   * Defaults to `http://127.0.0.1:<portB>/steal`: server B listens on 127.0.0.1 only, so a
   * hostname that may resolve to `::1` would let a followed redirect fail to connect and a
   * leak assertion pass for the wrong reason.
   */
  location?: (portB: number) => string | undefined;
}

export interface RedirectFixture {
  /** Server A's base URL: it answers every request with a redirect. */
  urlA: string;
  portA: number;
  portB: number;
  /** Requests server A has received. */
  requestsA: () => number;
  /** Requests server B (the redirect target) has received. */
  requestsB: () => number;
}

/**
 * Two real loopback HTTP servers: A redirects every request to B, B counts what reaches it.
 * `closeAll` stops every server started through this set; call it from `afterEach`.
 */
export function createRedirectFixtures(): {
  start: (options?: RedirectFixtureOptions) => Promise<RedirectFixture>;
  closeAll: () => Promise<void>;
} {
  const servers: Server[] = [];

  const listen = (server: Server): Promise<number> =>
    new Promise((resolve) => {
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });

  return {
    async start(options = {}) {
      let countA = 0;
      let countB = 0;
      const serverB = createServer((req, res) => {
        countB++;
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
      const portB = await listen(serverB);
      const location = (options.location ?? ((port) => `http://127.0.0.1:${port}/steal`))(portB);
      const serverA = createServer((req, res) => {
        countA++;
        req.resume();
        res.writeHead(options.status ?? 307, location === undefined ? {} : { location });
        res.end();
      });
      const portA = await listen(serverA);
      return {
        urlA: `http://127.0.0.1:${portA}`,
        portA,
        portB,
        requestsA: () => countA,
        requestsB: () => countB,
      };
    },
    async closeAll() {
      await Promise.all(
        servers.splice(0).map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
              server.closeAllConnections();
            }),
        ),
      );
    },
  };
}
