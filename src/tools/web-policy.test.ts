import { describe, expect, it, vi } from 'vitest';
import { Agent } from 'undici';
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

  it('enforces the connection-time lookup through Node fetch dispatchers', async () => {
    const dispatcher = new Agent({ connect: { lookup: safeNetworkLookup } });
    let caught: unknown;
    try {
      await fetch('http://localhost:49152', {
        dispatcher,
      } as RequestInit & { dispatcher: Agent });
    } catch (error) {
      caught = error;
    } finally {
      await dispatcher.close();
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as { cause?: { code?: string } }).cause?.code).toBe('EACCES');
  });
});
