import { describe, expect, it, vi } from 'vitest';
import type { LookupAddress } from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  isBlockedIpAddress,
  safeNetworkLookup,
  validateWebUrl,
  webUrlPolicyFromEnv,
  type WebUrlPolicy,
} from './web-policy.js';

const strictPolicy: WebUrlPolicy = {
  allowHttp: false,
  allowPrivateNetwork: false,
  maxRedirects: 5,
};

interface SafeLookupResult {
  error: NodeJS.ErrnoException | null;
  address: string | LookupAddress[];
  family?: number;
}

function runSafeLookup(hostname: string, options: { all: boolean }): Promise<SafeLookupResult> {
  return new Promise((resolve) => {
    safeNetworkLookup(hostname, options, (error, address, family) =>
      resolve({ error: error as NodeJS.ErrnoException | null, address, family }),
    );
  });
}

describe('web URL policy', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '192.0.2.1',
    '192.88.99.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::127.0.0.1',
    'fec0::1',
    '100::1',
    '2001:2::1',
  ])('blocks private or special-use address %s', (address) => {
    expect(isBlockedIpAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '192.1.1.1', '198.52.1.1', '203.1.1.1', '2606:4700:4700::1111'])(
    'allows public address %s',
    (address) => {
      expect(isBlockedIpAddress(address)).toBe(false);
    },
  );

  it('rejects embedded credentials and local hostnames', async () => {
    const resolver = vi.fn(async () => ['93.184.216.34']);

    await expect(
      validateWebUrl('https://user:pass@example.com/', strictPolicy, resolver),
    ).rejects.toMatchObject({ code: 'url_credentials_forbidden' });
    await expect(
      validateWebUrl('https://localhost/', strictPolicy, resolver),
    ).rejects.toMatchObject({ code: 'private_network_forbidden' });
    await expect(
      validateWebUrl('https://metadata.google.internal/', strictPolicy, resolver),
    ).rejects.toMatchObject({ code: 'private_network_forbidden' });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects a hostname if any resolved address is private', async () => {
    const resolver = vi.fn(async () => ['93.184.216.34', '10.0.0.2']);

    await expect(
      validateWebUrl('https://example.com/', strictPolicy, resolver),
    ).rejects.toMatchObject({ code: 'private_network_forbidden' });
  });

  it('returns a canonical fragment-free public URL', async () => {
    const resolver = vi.fn(async () => ['93.184.216.34']);

    const url = await validateWebUrl('https://EXAMPLE.com/docs#section', strictPolicy, resolver);

    expect(url.toString()).toBe('https://example.com/docs');
    expect(resolver).toHaveBeenCalledWith('example.com');
  });

  it('supports explicit host environment overrides', () => {
    expect(
      webUrlPolicyFromEnv({
        BOOK_WEB_ALLOW_HTTP: 'true',
        BOOK_WEB_ALLOW_PRIVATE_NETWORK: '1',
        BOOK_WEB_MAX_REDIRECTS: '8',
      }),
    ).toEqual({ allowHttp: true, allowPrivateNetwork: true, maxRedirects: 8 });
    expect(webUrlPolicyFromEnv({ BOOK_WEB_MAX_REDIRECTS: '99' }).maxRedirects).toBe(10);
  });

  it('enforces the connection-time lookup through an undici dispatcher', async () => {
    // The dispatcher carries the guard, and only the undici that created it consults that
    // dispatcher -- so the request has to be issued by undici's own fetch, exactly as
    // `undiciWebFetch` does in web.ts. Node's global fetch is a different, bundled undici.
    const dispatcher = new Agent({ connect: { lookup: safeNetworkLookup } });
    let caught: unknown;
    try {
      await undiciFetch('http://localhost:49152', { dispatcher });
    } catch (error) {
      caught = error;
    } finally {
      await dispatcher.close();
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as { cause?: { code?: string } }).cause?.code).toBe('EACCES');
  });

  describe('safeNetworkLookup callback contract', () => {
    // A literal address short-circuits dns.lookup, so these cases need no network.
    it('refuses a private address on the options.all path', async () => {
      const result = await runSafeLookup('127.0.0.1', { all: true });

      expect(result.error?.code).toBe('EACCES');
      expect(result.error?.message).toContain('127.0.0.1');
      expect(result.address).toEqual([]);
    });

    it('refuses a private address on the single-address path', async () => {
      const result = await runSafeLookup('127.0.0.1', { all: false });

      expect(result.error?.code).toBe('EACCES');
      expect(result.address).toBe('');
      expect(result.family).toBe(0);
    });

    it('refuses a private hostname on both paths', async () => {
      const all = await runSafeLookup('localhost', { all: true });
      const single = await runSafeLookup('localhost', { all: false });

      expect(all.error?.code).toBe('EACCES');
      expect(single.error?.code).toBe('EACCES');
    });

    it('passes a public address through on the options.all path', async () => {
      const result = await runSafeLookup('8.8.8.8', { all: true });

      expect(result.error).toBeFalsy();
      expect(result.address).toEqual([{ address: '8.8.8.8', family: 4 }]);
    });

    it('passes a public address through on the single-address path', async () => {
      const result = await runSafeLookup('8.8.8.8', { all: false });

      expect(result.error).toBeFalsy();
      expect(result.address).toBe('8.8.8.8');
      expect(result.family).toBe(4);
    });

    it('passes a public IPv6 address through', async () => {
      const result = await runSafeLookup('2606:4700:4700::1111', { all: false });

      expect(result.error).toBeFalsy();
      expect(result.address).toBe('2606:4700:4700::1111');
      expect(result.family).toBe(6);
    });
  });
});
