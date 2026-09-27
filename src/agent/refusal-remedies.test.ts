import { describe, it, expect } from 'vitest';
import {
  REFUSAL_KIND_ORDER,
  REFUSAL_REMEDIES,
  isRefusal,
  refusalKind,
  type LocalRefusalKind,
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
    expect(refusalKind(blocked('child_agent_unavailable'))).toBe('capability');
    expect(refusalKind(blocked('skill_execution_denied'))).toBe('skill');
    expect(refusalKind(blocked('skill_tool_intersection_empty'))).toBe('skill');
    expect(refusalKind(blocked('user_questions_disabled'))).toBe('question');
    expect(refusalKind(blocked('user_declined'))).toBe('question');
    expect(refusalKind(blocked('invalid_json_arguments'))).toBe('malformed');
    // Both are refused before the call ran, so both are the same kind: the model has to
    // correct the call, and no permission rule or mode lifts either one.
    expect(refusalKind(blocked('invalid_arguments'))).toBe('malformed');
    expect(refusalKind(blocked('unknown_tool'))).toBe('malformed');
    // An active tool whose arguments this run does not allow belongs to the tool surface:
    // ToolSearch cannot lift an allowed-tools rule, but the tool needs no activation.
    expect(refusalKind(blocked('arguments_not_allowed'))).toBe('inactive');
  });

  it('counts a plain permission refusal as a permission', () => {
    expect(refusalKind(blocked('permission_denied'))).toBe('permission');
  });

  it('counts an unrecognised gate as other, not as a permission nobody can grant', () => {
    // A gate Book does not know yet still has to get advice, and "grant the
    // permission" is advice for a gate that was never the one that refused.
    expect(refusalKind(blocked('some_future_gate'))).toBe('other');
    expect(refusalKind(blocked('plan_mode_blocked'))).toBe('other');
    expect(refusalKind(undefined)).toBe('other');
  });

  it('leaves the web network policy to its own kinds', () => {
    expect(refusalKind(blocked('private_network_forbidden'))).toBe('fetch');
    expect(refusalKind(blocked('search_all_providers_failed'))).toBe('search');
    expect(refusalKind(blocked('cross_origin_redirect'))).toBe('redirect');
  });
});

describe('isRefusal', () => {
  it('is any blocked result, a stopped cross-origin redirect included', () => {
    // The web policy's redirect stop has its own remedy in the stop message.
    expect(isRefusal(blocked('cross_origin_redirect'))).toBe(true);
    expect(isRefusal(blocked('permission_denied'))).toBe(true);
    expect(isRefusal(toolFailure('x', { code: 'tool_error' }))).toBe(false);
    expect(isRefusal(undefined)).toBe(false);
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

  it('does not offer the inactive remedy the wrong gate would name', () => {
    // Each remedy is worded to follow "Nothing can proceed: ", so it must be actionable on
    // its own; an inactive call is fixed by activating the tool, not by a permission.
    const kinds: LocalRefusalKind[] = [...REFUSAL_KIND_ORDER];
    expect(REFUSAL_REMEDIES.inactive).toContain('ToolSearch');
    expect(REFUSAL_REMEDIES.inactive).not.toContain('grant the permission');
    expect(kinds).toContain('inactive');
  });

  it('points a streak of unparsed arguments at the route, not at a permission', () => {
    expect(REFUSAL_REMEDIES.malformed).toContain('never parsed as JSON');
    expect(REFUSAL_REMEDIES.malformed).not.toContain('grant the permission');
  });
});
