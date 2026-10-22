/**
 * Startup warning for a Node.js runtime with published, patched security vulnerabilities.
 *
 * Book fetches pages the model chooses, so a flaw in the runtime's own HTTP, TLS or decompression
 * code is reachable from untrusted input: undici's `fetch`, which `WebFetch` uses, decodes a Brotli
 * body with Node's own `zlib`. The launch says so rather than leave it to `npm` engine checks,
 * which only know the minimum Book runs on.
 */

type Version = readonly [number, number, number];

/**
 * The newest Node.js security release Book knows about, and the first patched version on each line
 * it covered. Update it when Node.js publishes the next one; a line missing here that is older than
 * the newest listed is end-of-life, and one newer than it is not judged.
 */
const SECURITY_RELEASE = {
  date: 'October 21, 2026',
  url: 'https://nodejs.org/en/blog/vulnerability/october-2026-security-releases',
  headline: 'CVE-2026-111497, remote code execution in the Brotli decoder that WebFetch uses',
  patched: new Map<number, Version>([
    [22, [22, 23, 4]],
    [24, [24, 22, 1]],
    [26, [26, 12, 1]],
  ]),
};

function parseVersion(version: string): Version | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isOlder([major, minor, patch]: Version, [major2, minor2, patch2]: Version): boolean {
  if (major !== major2) return major < major2;
  if (minor !== minor2) return minor < minor2;
  return patch < patch2;
}

function formatVersion(version: Version): string {
  return `v${version.join('.')}`;
}

/**
 * The warnings for `version` (`process.versions.node`, with or without the `v`), each one line in
 * the `⚠  ` style of the other startup notices. Empty when the runtime is patched, newer than any
 * release line known here, or not a version string at all.
 */
export function collectNodeSecurityNotices(version: string): string[] {
  const parsed = parseVersion(version);
  if (!parsed) return [];
  const [major] = parsed;
  const { date, url, headline, patched } = SECURITY_RELEASE;
  const fixed = patched.get(major);
  if (fixed) {
    if (!isOlder(parsed, fixed)) return [];
    return [
      `⚠  Node.js ${formatVersion(parsed)} has security vulnerabilities fixed in the ${date} ` +
        `release, including ${headline}. Upgrade to Node.js ${formatVersion(fixed)} or newer: ${url}`,
    ];
  }
  if (major > Math.max(...patched.keys())) return [];
  const supported = [...patched.values()].map(formatVersion).join(', ');
  return [
    `⚠  Node.js ${formatVersion(parsed)} is end-of-life and did not get the fixes in the ${date} ` +
      `security release, including ${headline}. Move to a supported line (${supported} or newer): ${url}`,
  ];
}
