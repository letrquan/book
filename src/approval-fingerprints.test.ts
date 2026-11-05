import { describe, expect, it } from 'vitest';
import { projectCommandFingerprint } from './command-approvals.js';
import {
  describeDeclaredHook,
  fingerprintsNamedBy,
  hookFingerprint,
  partitionProjectHooks,
  shortFingerprint,
} from './hook-approvals.js';
import { mcpServerFingerprint } from './mcp-approvals.js';
import { legacyBaseUrlFingerprint, workspaceProviderFingerprint } from './provider-approvals.js';

const WHOLE_DIGEST = /^[0-9a-f]{64}$/;

describe('approval fingerprints', () => {
  it('use the whole digest', () => {
    for (const fingerprint of [
      hookFingerprint('PreToolUse', { command: 'a.sh', env: {} }),
      mcpServerFingerprint({ command: 'server', args: [] } as never),
      projectCommandFingerprint('!`echo hi`'),
      workspaceProviderFingerprint({ type: 'openai', baseURL: 'https://a.test/v1' } as never),
      legacyBaseUrlFingerprint('https://a.test/v1'),
    ]) {
      expect(fingerprint).toMatch(WHOLE_DIGEST);
    }
  });

  it('stop matching a decision recorded against a shorter value, which asks again', () => {
    const entry = { command: 'a.sh', env: {} };
    const hook = { event: 'PreToolUse' as const, entry };
    const short = hookFingerprint('PreToolUse', entry).slice(0, 16);
    expect(partitionProjectHooks([hook], { [short]: 'approved' }).pending).toEqual([hook]);
    expect(partitionProjectHooks([hook], { [short]: 'rejected' }).pending).toEqual([hook]);
  });
});

describe('fingerprints in reports', () => {
  const whole = hookFingerprint('PreToolUse', { command: 'a.sh', env: {} });

  it('prints a short handle, not the whole digest', () => {
    const { details } = describeDeclaredHook({
      event: 'PreToolUse',
      entry: { command: 'a.sh', env: {} },
    });
    expect(details[0]).toBe(`fingerprint: ${shortFingerprint(whole)}`);
    expect(details[0]).not.toContain(whole);
    expect(shortFingerprint(whole)).toHaveLength(16);
  });

  it('names one fingerprint from the whole digest or the printed start', () => {
    const other = 'f'.repeat(64);
    expect(fingerprintsNamedBy(whole, [whole, other])).toEqual([whole]);
    expect(fingerprintsNamedBy(shortFingerprint(whole), [whole, other])).toEqual([whole]);
  });

  it('names none from a start shorter than the printed one, or an empty one', () => {
    expect(fingerprintsNamedBy(whole.slice(0, 15), [whole])).toEqual([]);
    expect(fingerprintsNamedBy('', [whole])).toEqual([]);
  });

  it('names both when a start fits two, which the caller refuses', () => {
    const a = `${'a'.repeat(16)}${'0'.repeat(48)}`;
    const b = `${'a'.repeat(16)}${'1'.repeat(48)}`;
    expect(fingerprintsNamedBy('a'.repeat(16), [a, b])).toEqual([a, b]);
  });
});
