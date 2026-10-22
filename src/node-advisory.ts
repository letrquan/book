/**
 * Startup warning for a Node.js runtime with published, patched security vulnerabilities.
 *
 * Book fetches pages the model chooses, so a flaw in the runtime's own HTTP, TLS or decompression
 * code is reachable from untrusted input: undici's `fetch`, which `WebFetch` uses, decodes a Brotli
 * body with Node's own `zlib`. The launch says so rather than leave it to `npm` engine checks,
 * which only know the minimum Book runs on.
 */

type Release = readonly [number, number, number];

/** A parsed `process.versions.node`; `prerelease` is set for an `-rc.1` or `-nightly…` build. */
interface Version {
  readonly release: Release;
  readonly prerelease: boolean;
}

/**
 * The newest Node.js security release Book knows about, and the first patched version on each line
 * it covered. Update it when Node.js publishes the next one; a line missing here that is older than
 * the newest listed is end-of-life, and one newer than it is not judged.
 */
const SECURITY_RELEASE = {
  date: 'October 21, 2026',
  url: 'https://nodejs.org/en/blog/vulnerability/october-2026-security-releases',
  headline: 'CVE-2026-111497, remote code execution in the Brotli decoder that WebFetch uses',
  patched: [
    [22, 23, 4],
    [24, 22, 1],
    [26, 12, 1],
  ] as readonly Release[],
};

function parseVersion(version: string): Version | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-)?/.exec(version.trim());
  if (!match) return undefined;
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] !== undefined,
  };
}

/** Semver order: a prerelease of the fixed version, such as a nightly cut before it, is older. */
function isOlder({ release: [major, minor, patch], prerelease }: Version, fixed: Release): boolean {
  if (major !== fixed[0]) return major < fixed[0];
  if (minor !== fixed[1]) return minor < fixed[1];
  if (patch !== fixed[2]) return patch < fixed[2];
  return prerelease;
}

function formatRelease(release: Release): string {
  return `v${release.join('.')}`;
}

/**
 * The warnings for `version` (`process.versions.node`, with or without the `v`), each one line in
 * the `⚠  ` style of the other startup notices. Empty when the runtime is patched, newer than any
 * release line known here, or not a version string at all.
 */
export function collectNodeSecurityNotices(version: string): string[] {
  const parsed = parseVersion(version);
  if (!parsed) return [];
  const [major] = parsed.release;
  // As given, so a prerelease of the fixed version keeps the suffix that makes it older.
  const shown = `v${version.trim().replace(/^v/, '')}`;
  const { date, url, headline, patched } = SECURITY_RELEASE;
  const fixed = patched.find(([line]) => line === major);
  if (fixed) {
    if (!isOlder(parsed, fixed)) return [];
    return [
      `⚠  Node.js ${shown} has security vulnerabilities fixed in the ` +
        `${date} release, including ${headline}. Upgrade to Node.js ${formatRelease(fixed)} or ` +
        `newer: ${url}`,
    ];
  }
  if (major > Math.max(...patched.map(([line]) => line))) return [];
  const supported = patched.map(formatRelease).join(', ');
  return [
    `⚠  Node.js ${shown} is end-of-life and did not get the fixes in the ${date} ` +
      `security release, including ${headline}. Move to a supported line (${supported} or newer): ${url}`,
  ];
}
