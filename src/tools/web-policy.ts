import { lookup as lookupCallback } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';

export interface WebUrlPolicy {
  allowHttp: boolean;
  allowPrivateNetwork: boolean;
  maxRedirects: number;
}

export type HostResolver = (hostname: string) => Promise<string[]>;

export class WebPolicyError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_url'
      | 'invalid_url_scheme'
      | 'insecure_http_url'
      | 'url_credentials_forbidden'
      | 'private_network_forbidden'
      | 'dns_resolution_failed',
  ) {
    super(message);
    this.name = 'WebPolicyError';
  }
}

function envFlag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? '');
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function webUrlPolicyFromEnv(env: Record<string, string | undefined>): WebUrlPolicy {
  return {
    allowHttp: envFlag(env.BOOK_WEB_ALLOW_HTTP),
    allowPrivateNetwork: envFlag(env.BOOK_WEB_ALLOW_PRIVATE_NETWORK),
    maxRedirects: boundedInteger(env.BOOK_WEB_MAX_REDIRECTS, 5, 0, 10),
  };
}

export const resolveHostname: HostResolver = async (hostname) => {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return [...new Set(results.map((result) => result.address))];
};

function ipv4Parts(address: string): number[] | undefined {
  const parts = address.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return undefined;
  }
  return parts;
}

function isBlockedIpv4(address: string): boolean {
  const parts = ipv4Parts(address);
  if (!parts) return true;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function expandIpv6(address: string): number[] | undefined {
  const withoutZone = address.toLowerCase().split('%', 1)[0];
  const embeddedIpv4 = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(withoutZone);
  let normalized = withoutZone;
  if (embeddedIpv4) {
    const parts = ipv4Parts(embeddedIpv4[1]);
    if (!parts) return undefined;
    const high = ((parts[0] << 8) | parts[1]).toString(16);
    const low = ((parts[2] << 8) | parts[3]).toString(16);
    normalized = `${withoutZone.slice(0, embeddedIpv4.index)}:${high}:${low}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
  if (
    groups.length !== 8 ||
    groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)
  ) {
    return undefined;
  }
  return groups;
}

function isBlockedIpv6(address: string): boolean {
  const groups = expandIpv6(address);
  if (!groups) return true;
  const allZero = groups.every((group) => group === 0);
  const loopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  const uniqueLocal = (groups[0] & 0xfe00) === 0xfc00;
  const linkLocal = (groups[0] & 0xffc0) === 0xfe80;
  const multicast = (groups[0] & 0xff00) === 0xff00;
  const documentation = groups[0] === 0x2001 && groups[1] === 0x0db8;
  const ipv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const ipv4Compatible = groups.slice(0, 6).every((group) => group === 0);
  if (ipv4Mapped) {
    const mapped = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isBlockedIpv4(mapped);
  }
  if (ipv4Compatible) {
    const compatible = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isBlockedIpv4(compatible);
  }
  const siteLocal = (groups[0] & 0xffc0) === 0xfec0;
  const discardOnly = groups[0] === 0x0100 && groups.slice(1, 4).every((group) => group === 0);
  const benchmarking = groups[0] === 0x2001 && groups[1] === 0x0002;
  return (
    allZero ||
    loopback ||
    uniqueLocal ||
    linkLocal ||
    siteLocal ||
    multicast ||
    documentation ||
    discardOnly ||
    benchmarking
  );
}

export function isBlockedIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  return true;
}

/** Validate every address returned to the HTTP connector to close the DNS-rebinding gap. */
export const safeNetworkLookup: LookupFunction = (hostname, options, callback) => {
  lookupCallback(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, options.all ? [] : '', options.all ? undefined : 0);
      return;
    }
    const blocked = addresses.find((address) => isBlockedIpAddress(address.address));
    if (blocked) {
      const policyError = Object.assign(
        new Error(
          `Connection blocked because ${hostname} resolved to private or special-use address ${blocked.address}.`,
        ),
        { code: 'EACCES' },
      ) as NodeJS.ErrnoException;
      callback(policyError, options.all ? [] : '', options.all ? undefined : 0);
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]?.address ?? '', addresses[0]?.family ?? 0);
  });
};

function normalizedHostname(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function isBlockedHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname === 'metadata' ||
    hostname === 'metadata.google.internal' ||
    (!isIP(hostname) && !hostname.includes('.'))
  );
}

export async function validateWebUrl(
  rawUrl: string,
  policy: WebUrlPolicy,
  resolver: HostResolver = resolveHostname,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebPolicyError(`Invalid URL: ${rawUrl}`, 'invalid_url');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebPolicyError(`URL must use http or https scheme: ${rawUrl}`, 'invalid_url_scheme');
  }
  if (url.protocol === 'http:' && !policy.allowHttp) {
    throw new WebPolicyError(
      'Plain HTTP web fetches are disabled. Set BOOK_WEB_ALLOW_HTTP=true in the host environment to opt in.',
      'insecure_http_url',
    );
  }
  if (url.username || url.password) {
    throw new WebPolicyError(
      'Credentials embedded in web URLs are not allowed.',
      'url_credentials_forbidden',
    );
  }

  url.hash = '';
  if (policy.allowPrivateNetwork) return url;

  const hostname = normalizedHostname(url);
  if (isBlockedHostname(hostname)) {
    throw new WebPolicyError(
      `Web fetch blocked for local or private hostname: ${hostname}`,
      'private_network_forbidden',
    );
  }
  if (isIP(hostname)) {
    if (isBlockedIpAddress(hostname)) {
      throw new WebPolicyError(
        `Web fetch blocked for private or special-use address: ${hostname}`,
        'private_network_forbidden',
      );
    }
    return url;
  }

  let addresses: string[];
  try {
    addresses = await resolver(hostname);
  } catch (error) {
    throw new WebPolicyError(
      `DNS resolution failed for ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
      'dns_resolution_failed',
    );
  }
  if (addresses.length === 0) {
    throw new WebPolicyError(
      `DNS resolution returned no addresses for ${hostname}.`,
      'dns_resolution_failed',
    );
  }
  const blocked = addresses.find(isBlockedIpAddress);
  if (blocked) {
    throw new WebPolicyError(
      `Web fetch blocked because ${hostname} resolves to private or special-use address ${blocked}.`,
      'private_network_forbidden',
    );
  }
  return url;
}
