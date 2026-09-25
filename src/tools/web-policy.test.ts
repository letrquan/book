import { describe, expect, it, vi } from 'vitest';
import type { LookupAddress } from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  connectionBlockedReason,
  isBlockedIpAddress,
  NETWORK_POLICY_REMEDIES,
  networkPolicyRefusal,
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
    // The dispatcher carries the guard. Node's bundled fetch rejects this package's Agent, so the
    // request is issued by undici's own fetch, as `web.ts` does for guarded requests.
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
    // Pin brand survival through the real undici path, not just a hand-built wrapping:
    // Node mutates the lookup error before undici wraps it, so any layer that copied
    // rather than forwarded the object would drop the symbol and silently return the
    // refusal to reporting itself as a retryable `fetch failed`.
    expect(connectionBlockedReason(caught)).toContain('private or special-use address');
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

    it('brands the refusal so the reason survives undici wrapping', async () => {
      const refused = (await runSafeLookup('127.0.0.1', { all: true })).error;
      // undici reports a lookup failure as the `cause` of a generic TypeError.
      const wrapped = Object.assign(new TypeError('fetch failed'), { cause: refused });

      expect(connectionBlockedReason(refused)).toContain('127.0.0.1');
      expect(connectionBlockedReason(wrapped)).toContain('127.0.0.1');
    });

    it('does not claim an unrelated failure was a policy refusal', () => {
      const unrelated = Object.assign(new Error('connect EACCES 93.184.216.34:443'), {
        code: 'EACCES',
      });

      expect(connectionBlockedReason(new Error('boom'))).toBeUndefined();
      expect(connectionBlockedReason(unrelated)).toBeUndefined();
      expect(
        connectionBlockedReason(Object.assign(new TypeError('fetch failed'), { cause: unrelated })),
      ).toBeUndefined();
      expect(connectionBlockedReason(undefined)).toBeUndefined();
    });

    it('passes a public IPv6 address through', async () => {
      const result = await runSafeLookup('2606:4700:4700::1111', { all: false });

      expect(result.error).toBeFalsy();
      expect(result.address).toBe('2606:4700:4700::1111');
      expect(result.family).toBe(6);
    });
  });

  describe('IPv6 ranges that embed an IPv4 destination', () => {
    // Each row is an IPv6 literal and the IPv4 address it reaches through a NAT64 gateway or a
    // 6to4/Teredo relay, which the IPv4 policy decides. Compressed, fully expanded and dotted-tail
    // spellings of one range must agree.
    it.each([
      // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052): the last 32 bits.
      ['64:ff9b::a00:1', '10.0.0.1'],
      ['64:ff9b::10.0.0.1', '10.0.0.1'],
      ['0064:ff9b:0000:0000:0000:0000:7f00:0001', '127.0.0.1'],
      ['64:ff9b::a9fe:a9fe', '169.254.169.254'],
      // 6to4 2002::/16 (RFC 3056): bits 16-47.
      ['2002:7f00:0001::', '127.0.0.1'],
      ['2002:a9fe:a9fe::', '169.254.169.254'],
      ['2002:c0a8:0101:0000:0000:0000:0000:0001', '192.168.1.1'],
      // Teredo 2001::/32 (RFC 4380): the server at bits 32-63, and the client XOR 0xffffffff in
      // the last 32 bits. Either one being forbidden blocks the address.
      ['2001:0:4136:e378:8000:63bf:f5ff:fffe', 'client 10.0.0.1'],
      ['2001:0000:4136:e378:8000:63bf:3fff:fdd2', 'client 192.0.2.45, the RFC 4380 example'],
      ['2001:0:c0a8:101::f7f7:f7f7', 'server 192.168.1.1'],
    ])('blocks %s, which reaches %s', (address) => {
      expect(isBlockedIpAddress(address)).toBe(true);
    });

    it.each([
      ['64:ff9b:1::a00:1', '10.0.0.1'],
      ['64:ff9b:1::10.0.0.1', '10.0.0.1'],
      ['0064:ff9b:0001:0000:0000:0000:7f00:0001', '127.0.0.1'],
    ])('blocks %s, a local-use NAT64 address in the /96 layout that reaches %s', (address) => {
      expect(isBlockedIpAddress(address)).toBe(true);
    });

    it.each([
      '64:ff9b:1::808:808',
      '64:ff9b:1::8.8.8.8',
      '0064:ff9b:0001:0000:0000:0000:0808:0808',
    ])('allows %s, a local-use NAT64 address in the /96 layout that reaches 8.8.8.8', (address) => {
      expect(isBlockedIpAddress(address)).toBe(false);
    });

    // Any other shape in 64:ff9b:1::/48 is a prefix length whose IPv4 bits cannot be located
    // without knowing the local network (RFC 8215), so it is blocked whatever it holds.
    it.each([
      '64:ff9b:1:808:808::',
      '64:ff9b:1:0:0:1:808:808',
      '64:ff9b:1:ffff:ffff:ffff:ffff:ffff',
    ])('blocks %s, a local-use NAT64 address in any other layout', (address) => {
      expect(isBlockedIpAddress(address)).toBe(true);
    });

    it.each([
      ['64:ff9b::808:808', '8.8.8.8'],
      ['64:ff9b::8.8.8.8', '8.8.8.8'],
      ['0064:ff9b:0000:0000:0000:0000:0808:0808', '8.8.8.8'],
      ['2002:808:808::1', '8.8.8.8'],
      ['2002:0808:0808:0000:0000:0000:0000:0001', '8.8.8.8'],
      ['2001:0:808:808::fefe:fefe', 'server 8.8.8.8 and client 1.1.1.1'],
      ['2001:0000:0808:0808:0000:0000:fefe:fefe', 'server 8.8.8.8 and client 1.1.1.1'],
      ['2001:4860:4860::8888', 'itself, outside Teredo 2001::/32'],
    ])('allows %s, which reaches public %s', (address) => {
      expect(isBlockedIpAddress(address)).toBe(false);
    });

    it('blocks a NAT64 literal at pre-flight without resolving it', async () => {
      const resolver = vi.fn(async () => ['93.184.216.34']);

      await expect(
        validateWebUrl('https://[64:ff9b::a00:1]/', strictPolicy, resolver),
      ).rejects.toMatchObject({ code: 'private_network_forbidden' });
      expect(resolver).not.toHaveBeenCalled();
    });

    it('blocks a hostname that resolves to a 6to4 address wrapping a private IPv4', async () => {
      const resolver = vi.fn(async () => ['2002:a9fe:a9fe::1']);

      await expect(
        validateWebUrl('https://example.com/', strictPolicy, resolver),
      ).rejects.toMatchObject({ code: 'private_network_forbidden' });
    });

    it('refuses a NAT64 address wrapping a private IPv4 at connect time', async () => {
      const result = await runSafeLookup('64:ff9b::a00:1', { all: true });

      expect(result.error?.code).toBe('EACCES');
      expect(result.error?.message).toContain('64:ff9b::a00:1');
    });

    it('passes a NAT64 address wrapping a public IPv4 at connect time', async () => {
      const result = await runSafeLookup('64:ff9b::808:808', { all: false });

      expect(result.error).toBeFalsy();
      expect(result.address).toBe('64:ff9b::808:808');
      expect(result.family).toBe(6);
    });
  });
});

describe('network-policy refusals', () => {
  const refusal = (status: 'blocked' | 'error', code: string) => ({
    status,
    structuredError: { code, message: 'refused', retryable: false },
  });

  it('tells a WebFetch refusal from a WebSearch one, and only in a blocked result', () => {
    expect(networkPolicyRefusal(refusal('blocked', 'private_network_forbidden'))).toBe('fetch');
    // WebSearch reports every provider refused on policy grounds this way, and only then blocked.
    expect(networkPolicyRefusal(refusal('blocked', 'search_all_providers_failed'))).toBe('search');
    expect(networkPolicyRefusal(refusal('error', 'search_all_providers_failed'))).toBeUndefined();
    expect(networkPolicyRefusal(refusal('blocked', 'permission_denied'))).toBeUndefined();
    expect(networkPolicyRefusal(undefined)).toBeUndefined();
  });

  it('offers the host opt-in only for a WebFetch refusal', () => {
    // The built-in search providers validate with allowPrivateNetwork: false whatever the host
    // sets, so the opt-in would lift WebFetch's protection and still leave WebSearch refused.
    expect(NETWORK_POLICY_REMEDIES.fetch).toContain('BOOK_WEB_ALLOW_PRIVATE_NETWORK=true');
    expect(NETWORK_POLICY_REMEDIES.search).not.toContain('BOOK_WEB_ALLOW_PRIVATE_NETWORK');
    expect(NETWORK_POLICY_REMEDIES.search).toContain('DNS or proxy');
    // `localhost` and `*.local` are refused by name, before there is any address to speak of.
    expect(NETWORK_POLICY_REMEDIES.fetch).toContain('private or special-use destination');
    expect(NETWORK_POLICY_REMEDIES.fetch).not.toContain('address');
  });
});
