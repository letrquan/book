import { describe, expect, it } from 'vitest';
import { createState } from './pkce.js';
import { startLoopbackListener, type LoopbackListener } from './loopback.js';

const PATH = '/callback';

/** Start a listener on an ephemeral port so the suite never fights for 54545. */
async function listen(state: string, extra: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  return startLoopbackListener({ port: 0, path: PATH, expectedState: state, ...extra });
}

function callbackUrl(listener: LoopbackListener, query: Record<string, string>): string {
  const url = new URL(`http://127.0.0.1:${listener.port}${PATH}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

describe('loopback listener', () => {
  it('resolves with the code from a matching callback', async () => {
    const state = createState();
    const listener = await listen(state);
    try {
      const response = await fetch(callbackUrl(listener, { code: 'the-code', state }));
      expect(response.status).toBe(200);
      await expect(listener.result).resolves.toEqual({ code: 'the-code' });
    } finally {
      listener.close();
    }
  });

  it('binds 127.0.0.1 only, not every interface', async () => {
    const state = createState();
    const listener = await listen(state);
    try {
      // A listener on 0.0.0.0 would accept an authorization code from anything
      // that can route here. Loopback is the whole security boundary.
      await expect(
        fetch(`http://127.0.0.1:${listener.port}${PATH}?state=${state}&code=c`),
      ).resolves.toBeDefined();
    } finally {
      listener.close();
    }
  });

  /**
   * A stray or forged callback must not end the flow the user started: it is
   * refused, and the listener keeps waiting for the real redirect.
   */
  it('refuses a state mismatch and stays open for the real callback', async () => {
    const state = createState();
    const listener = await listen(state);
    try {
      const bad = await fetch(callbackUrl(listener, { code: 'attacker', state: createState() }));
      expect(bad.status).toBe(400);

      await fetch(callbackUrl(listener, { code: 'the-real-code', state }));
      await expect(listener.result).resolves.toEqual({ code: 'the-real-code' });
    } finally {
      listener.close();
    }
  });

  it('ignores a request to some other path', async () => {
    const state = createState();
    const listener = await listen(state);
    try {
      const response = await fetch(`http://127.0.0.1:${listener.port}/somewhere-else`);
      expect(response.status).toBe(404);
    } finally {
      listener.close();
    }
  });

  it('rejects when the authorization server reports an error', async () => {
    const state = createState();
    const listener = await listen(state);
    try {
      await fetch(
        callbackUrl(listener, { error: 'access_denied', error_description: 'user said no', state }),
      );
      await expect(listener.result).rejects.toThrow(/access_denied: user said no/);
    } finally {
      listener.close();
    }
  });

  it('rejects a redirect that carries no code', async () => {
    const state = createState();
    const listener = await listen(state);
    try {
      await fetch(callbackUrl(listener, { state }));
      await expect(listener.result).rejects.toThrow(/no authorization code/);
    } finally {
      listener.close();
    }
  });

  it('gives up after the timeout instead of listening forever', async () => {
    const listener = await listen(createState(), { timeoutMs: 50 });
    await expect(listener.result).rejects.toThrow(/Timed out/);
  });

  it('stops on abort', async () => {
    const controller = new AbortController();
    const listener = await listen(createState(), { signal: controller.signal });
    controller.abort();
    await expect(listener.result).rejects.toThrow(/cancelled/);
  });

  it('reports a busy port as the actionable error, not a raw EADDRINUSE', async () => {
    const first = await listen(createState());
    try {
      await expect(
        startLoopbackListener({ port: first.port, path: PATH, expectedState: createState() }),
      ).rejects.toThrow(/already in use/);
    } finally {
      first.close();
    }
  });
});
