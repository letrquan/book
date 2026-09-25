import { lookup as lookupCallback } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import type { ToolResult } from '../types/tools.js';

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

/**
 * The kinds of refusal by the web network policy, each with its own remedy. No permission rule or
 * mode lifts either, bypassPermissions included.
 *
 * - `fetch`: a WebFetch to a private or special-use destination (`private_network_forbidden`).
 *   The host's BOOK_WEB_ALLOW_PRIVATE_NETWORK lifts it.
 * - `search`: a WebSearch whose every built-in provider resolved to such a destination
 *   (`search_all_providers_failed`, which web.ts marks `blocked` only then). The providers always
 *   validate with `allowPrivateNetwork: false`, so no setting lifts it; the host's DNS or proxy
 *   is sending them to a private address.
 */
export type NetworkPolicyRefusal = 'fetch' | 'search';

/** Which kind of network-policy refusal a tool result is, or `undefined` when it is none. */
export function networkPolicyRefusal(
  result: Pick<ToolResult, 'status' | 'structuredError'> | undefined,
): NetworkPolicyRefusal | undefined {
  if (result?.status !== 'blocked') return undefined;
  const code = result.structuredError?.code;
  if (code === 'private_network_forbidden') return 'fetch';
  if (code === 'search_all_providers_failed') return 'search';
  return undefined;
}

/** What lifts each kind of network-policy refusal, worded to follow "Nothing can proceed: ". */
export const NETWORK_POLICY_REMEDIES: Readonly<Record<NetworkPolicyRefusal, string>> = {
  fetch:
    'the web network policy refused a private or special-use destination, which no permission rule or mode lifts; set BOOK_WEB_ALLOW_PRIVATE_NETWORK=true in the host environment to allow it',
  search:
    "every built-in search provider resolved to a private or special-use destination, which no setting, permission rule or mode lifts; check the host's DNS or proxy (a fake-IP DNS such as 198.18.0.0/15 causes this)",
};

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

/** The dotted IPv4 address held in two 16-bit groups, high group first. */
function ipv4FromGroups(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * The IPv4 destinations an IPv6 transition address carries, or `undefined` when it carries none.
 * Through a NAT64 gateway or a 6to4/Teredo relay such an address reaches the embedded IPv4 host
 * (`https://[64:ff9b::a00:1]/` reaches 10.0.0.1), so the IPv4 policy has to decide it.
 *
 * - NAT64 well-known prefix `64:ff9b::/96` (RFC 6052): the last 32 bits.
 * - Local-use NAT64 `64:ff9b:1::/48` (RFC 8215) in that same /96 layout, with bits 48-95 zero:
 *   the last 32 bits. `isBlockedIpv6` blocks every other shape in that range.
 * - 6to4 `2002::/16` (RFC 3056): bits 16-47.
 * - Teredo `2001::/32` (RFC 4380): the server in bits 32-63, and the client in the last 32 bits,
 *   obfuscated by XOR with 0xffffffff. Both are returned, and either one being forbidden blocks.
 */
function embeddedIpv4Destinations(groups: number[]): string[] | undefined {
  // Group 2 is 0 in the well-known prefix and 1 in the local-use one.
  const nat64 =
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    (groups[2] === 0x0000 || groups[2] === 0x0001) &&
    groups.slice(3, 6).every((group) => group === 0);
  if (nat64) return [ipv4FromGroups(groups[6], groups[7])];
  if (groups[0] === 0x2002) return [ipv4FromGroups(groups[1], groups[2])];
  if (groups[0] === 0x2001 && groups[1] === 0x0000) {
    return [
      ipv4FromGroups(groups[2], groups[3]),
      ipv4FromGroups(~groups[6] & 0xffff, ~groups[7] & 0xffff),
    ];
  }
  return undefined;
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
  if (ipv4Mapped || ipv4Compatible) return isBlockedIpv4(ipv4FromGroups(groups[6], groups[7]));
  const embedded = embeddedIpv4Destinations(groups);
  if (embedded) return embedded.some(isBlockedIpv4);
  // RFC 8215 lets the operator of the local-use NAT64 prefix choose any RFC 6052 prefix length
  // inside it, from /48 to /96, and the position of the IPv4 bits moves with that choice. The /96
  // layout, whose last 32 bits hold the IPv4 address as in the well-known prefix, was decoded
  // above. Any other shape cannot be located without knowing the local network, and the range is
  // local-use by definition, like a unique-local address, so it is blocked.
  const localUseNat64 = groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0x0001;
  if (localUseNat64) return true;
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

/**
 * Brands the connect-time refusal so a caller can tell it from an unrelated `EACCES`.
 *
 * undici reports a lookup failure by wrapping it as the `cause` of a generic `TypeError: fetch
 * failed`, which on its own says nothing about why the connection was refused. The brand rides on
 * the original error object through that wrapping.
 */
const CONNECTION_BLOCKED = Symbol.for('book.web.connectionBlocked');

/**
 * The policy's reason for refusing a connection, or `undefined` if this is any other failure.
 * Reads through one layer of `cause` because that is where undici puts it.
 */
export function connectionBlockedReason(error: unknown): string | undefined {
  const candidates = [error, (error as { cause?: unknown } | undefined)?.cause];
  for (const candidate of candidates) {
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as Record<symbol, unknown>)[CONNECTION_BLOCKED] === true
    ) {
      return (candidate as Error).message;
    }
  }
  return undefined;
}

/**
 * Validate every address returned to the HTTP connector to close the DNS-rebinding gap.
 *
 * The hook guards a request only when an undici `Agent` built with it issues the request. Node's
 * bundled `fetch` rejects this package's Agent, so `web.ts` fetches through undici's own
 * `fetch`. Both callback shapes
 * are supported because the contract allows either: `options.all` takes the address list, and the
 * single-address form takes one address plus its family.
 */
export const safeNetworkLookup: LookupFunction = (hostname, options, callback) => {
  const fail = (error: NodeJS.ErrnoException): void => {
    if (options.all) callback(error, []);
    else callback(error, '', 0);
  };
  const refuse = (reason: string): void =>
    fail(
      Object.assign(new Error(reason), {
        code: 'EACCES',
        [CONNECTION_BLOCKED]: true,
      }) as NodeJS.ErrnoException,
    );

  lookupCallback(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      fail(error);
      return;
    }
    const blocked = addresses.find((address) => isBlockedIpAddress(address.address));
    if (blocked) {
      refuse(
        `Connection blocked because ${hostname} resolved to private or special-use address ${blocked.address}.`,
      );
      return;
    }
    // Refuse an empty result rather than reporting success: the single-address form would
    // otherwise hand the connector '' as a destination it never validated.
    if (addresses.length === 0) {
      refuse(`Connection blocked because ${hostname} resolved to no usable address.`);
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
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
