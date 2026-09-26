import { describe, it, expect } from 'vitest';
import {
  REFUSAL_KIND_ORDER,
  REFUSAL_REMEDIES,
  refusalKind,
  type RefusalKind,
} from './refusal-remedies.js';
import { toolFailure } from '../tools/result.js';
import type { ToolResult } from '../types/tools.js';

/** A blocked result carrying one refusal code, as a hook, gate or tool would return. */
function blocked(code: string): ToolResult {
  return toolFailure(`refused: ${code}`, { code, status: 'blocked' });
}

describe('refusalKind', () => {
  it('names the gate that refused the call, not just that it was refused', () => {
    // A stop message that says "grant the permission" is a dead end for a hook, a
    // deactivated tool or a managed agent's policy: no rule and no mode lifts those.
    expect(refusalKind(blocked('hook_blocked'))).toBe('hook');
    expect(refusalKind(blocked('tool_not_active'))).toBe('inactive');
    expect(refusalKind(blocked('capability_denied'))).toBe('capability');
    expect(refusalKind(blocked('cross_origin_redirect'))).toBe('redirect');
  });

  it('counts a plain permission refusal, and an unrecognised one, as a permission', () => {
    expect(refusalKind(blocked('permission_denied'))).toBe('permission');
    // A gate Book does not know yet still has to get advice, and permission advice is the
    // one that applies.
    expect(refusalKind(blocked('some_future_gate'))).toBe('permission');
    expect(refusalKind(undefined)).toBe('permission');
  });

  it('leaves the web network policy to its own two kinds', () => {
    expect(refusalKind(blocked('private_network_forbidden'))).toBe('fetch');
    expect(refusalKind(blocked('search_all_providers_failed'))).toBe('search');
  });
});

describe('the remedy catalog', () => {
  it('has a remedy for every kind, and lists each kind exactly once', () => {
    for (const kind of REFUSAL_KIND_ORDER) {
      expect(REFUSAL_REMEDIES[kind], kind).toBeTruthy();
    }
    expect(REFUSAL_KIND_ORDER).toEqual([...new Set(REFUSAL_KIND_ORDER)]);
    expect([...REFUSAL_KIND_ORDER].sort()).toEqual(Object.keys(REFUSAL_REMEDIES).sort());
  });

  it('reaches the host opt-in and the DNS, which the web refusals need', () => {
    expect(REFUSAL_REMEDIES.fetch).toContain('BOOK_WEB_ALLOW_PRIVATE_NETWORK');
    expect(REFUSAL_REMEDIES.search).toContain('DNS or proxy');
  });

  it('does not offer the inactive remedy the wrong gate would name', () => {
    // Each remedy is worded to follow "Nothing can proceed: ", so it must be actionable on
    // its own; an inactive call is fixed by activating the tool, not by a permission.
    const kinds: RefusalKind[] = [...REFUSAL_KIND_ORDER];
    expect(REFUSAL_REMEDIES.inactive).toContain('ToolSearch');
    expect(REFUSAL_REMEDIES.inactive).not.toContain('grant the permission');
    expect(kinds).toContain('inactive');
  });
});
