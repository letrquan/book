import { describe, expect, it } from 'vitest';
import { collectNodeSecurityNotices } from './node-advisory.js';

describe('collectNodeSecurityNotices', () => {
  it.each([
    ['22.23.3', 'v22.23.4'],
    ['22.19.0', 'v22.23.4'],
    ['24.21.0', 'v24.22.1'],
    ['24.22.0', 'v24.22.1'],
    ['26.12.0', 'v26.12.1'],
  ])('warns on %s and names %s, the first patched release on its line', (version, fixed) => {
    const notices = collectNodeSecurityNotices(version);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^⚠ {2}Node\.js v\d/);
    expect(notices[0]).toContain(`v${version} has security vulnerabilities`);
    expect(notices[0]).toContain(`Upgrade to Node.js ${fixed} or newer`);
    expect(notices[0]).toContain('CVE-2026-111497');
    expect(notices[0]).toContain(
      'https://nodejs.org/en/blog/vulnerability/october-2026-security-releases',
    );
  });

  it.each(['22.23.4', '22.24.0', '24.22.1', '24.23.0', '26.12.1', '26.13.0'])(
    'is silent on %s, which has the fixes',
    (version) => {
      expect(collectNodeSecurityNotices(version)).toEqual([]);
    },
  );

  it.each(['20.19.5', '23.11.1', '25.9.0'])(
    'calls %s end-of-life and lists the supported lines',
    (version) => {
      const [notice, ...rest] = collectNodeSecurityNotices(version);
      expect(rest).toEqual([]);
      expect(notice).toContain(`Node.js v${version} is end-of-life`);
      expect(notice).toContain('(v22.23.4, v24.22.1, v26.12.1 or newer)');
    },
  );

  it('does not judge a line newer than any it knows', () => {
    expect(collectNodeSecurityNotices('27.0.0')).toEqual([]);
  });

  it('accepts the `v` that process.version carries, and a prerelease suffix', () => {
    expect(collectNodeSecurityNotices('v24.22.1')).toEqual([]);
    expect(collectNodeSecurityNotices('v24.21.0')[0]).toContain('Node.js v24.21.0 has');
    expect(collectNodeSecurityNotices('24.22.0-nightly2026102136c0a1')).toHaveLength(1);
  });

  it.each(['', 'unknown', '24', '24.22', 'node 24.21.0'])(
    'stays silent on %j, which is not a version',
    (version) => {
      expect(collectNodeSecurityNotices(version)).toEqual([]);
    },
  );
});
