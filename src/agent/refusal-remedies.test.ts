import { describe, it, expect } from 'vitest';
import {
  OUTSIDE_WORKSPACE_REFUSAL_CODE,
  PATTERN_UNREADABLE_REFUSAL_CODE,
  REFUSAL_KIND_ORDER,
  REFUSAL_REMEDIES,
  invalidPatternRefusal,
  isRefusal,
  outsideWorkspaceRefusal,
  refusalKind,
  type LocalRefusalKind,
} from './refusal-remedies.js';
import { toolFailure } from '../tools/result.js';
import { CONTROL_CHARACTERS } from '../control-characters.js';
import type { ToolResult } from '../types/tools.js';

/** A blocked result carrying one refusal code, as a hook, gate or tool would return. */
function blocked(code: string): ToolResult {
  return toolFailure(`refused: ${code}`, { code, status: 'blocked' });
}

/**
 * A Glob pattern the matcher cannot read. It was refused as an unreachable path, which sent the model
 * after a directory: `additionalDirectories` for a pattern that is not about a directory at all. The
 * refusal is its own kind, carrying the matcher's reason, and naming no directory.
 */
describe('the unreadable-pattern refusal', () => {
  const refusal = (reason = 'the pattern nests 33 groups deep, more than 32'): string =>
    invalidPatternRefusal(
      'Glob',
      { arguments: { pattern: '!('.repeat(2500) + ')'.repeat(2500) } },
      reason,
    ).content ?? '';

  it('is classified as a pattern from its code alone, never as outside', () => {
    const result = invalidPatternRefusal('Glob', { arguments: { pattern: 'x' } }, 'too long');

    expect(refusalKind(result)).toBe('pattern');
    expect(refusalKind(result)).not.toBe('outside');
    expect(result.structuredError?.code).toBe(PATTERN_UNREADABLE_REFUSAL_CODE);
  });

  it('reaches the model in `content`, carrying the reason it can act on', () => {
    // The loop would otherwise retry the same pattern until the `all_tools_blocked` brake fired.
    const message = refusal();

    expect(message).toContain('The matcher cannot read the pattern');
    expect(message).toContain('33');
    expect(message).toContain('32');
    // And not 7 500 characters of it: the reason names the shape, which is what the model acts on.
    expect(message.length).toBeLessThan(700);
  });

  it('names no directory, because none of them would make the walk happen', () => {
    const message = refusal();

    expect(message).toContain('No permission rule, no directory in additionalDirectories');
    // Nor the two remedies this kind does not get: a rule and a directory are the fixes for the
    // refusals around it, and offering them here would send the model after neither.
    expect(message).toContain('nothing about the directory is wrong');
    expect(message).not.toMatch(/add (its|the) directory/i);
    expect(REFUSAL_REMEDIES.pattern).not.toContain('--permission-mode auto');
    expect(REFUSAL_REMEDIES.pattern).toContain('simpler pattern');
  });

  it('blocks rather than denying, and carries the call id when there is one', () => {
    const result = invalidPatternRefusal('Glob', { arguments: { pattern: 'x' } }, 'too long', {
      toolCallId: 'p3',
    });

    expect(result.status).toBe('blocked');
    expect(result.structuredError?.code).not.toBe('permission_denied');
    expect(result.toolCallId).toBe('p3');
    expect(result.structuredError?.details).toMatchObject({ tool: 'Glob' });
  });

  it('folds control characters out of the pattern it names', () => {
    const message = invalidPatternRefusal(
      'Glob',
      { arguments: { pattern: `src/${String.fromCharCode(0x1b)}[2J*.ts` } },
      'too long',
    ).content;

    expect(message).not.toContain(String.fromCharCode(0x1b));
  });
});

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

/**
 * #305 item 3. A Read no root serves is refused, not denied, and the two must never be confused:
 * a denial offers a permission rule, while this offers a directory. The classifier reads the
 * structured error's code, so the code is load-bearing, not decoration.
 */
describe('the outside-workspace refusal', () => {
  it('is classified as `outside` from its code alone', () => {
    const result = outsideWorkspaceRefusal('Read', { arguments: { filePath: '/etc/hostname' } });

    expect(refusalKind(result)).toBe('outside');
  });

  it('blocks, and is not a permission denial', () => {
    const result = outsideWorkspaceRefusal('Read', { arguments: { filePath: '/etc/hostname' } });

    expect(result.status).toBe('blocked');
    expect(result.structuredError?.code).toBe(OUTSIDE_WORKSPACE_REFUSAL_CODE);
    expect(result.structuredError?.code).not.toBe('permission_denied');
  });

  it('reaches the model in `content`, so the refusal is not a silent empty turn', () => {
    const result = outsideWorkspaceRefusal('Read', { arguments: { filePath: '/etc/hostname' } });

    // The loop would otherwise retry the same path until the `all_tools_blocked` brake fired.
    expect(result.content).toContain('additionalDirectories');
    expect(result.content).toContain('/etc/hostname');
  });

  it('names the directories already honored, so the message is specific', () => {
    const result = outsideWorkspaceRefusal(
      'Read',
      { arguments: { filePath: '/etc/hostname' } },
      { additionalRoots: ['/opt/one', '/opt/two'] },
    );

    expect(result.content).toContain('/opt/one, /opt/two');
  });

  it('says so when there are none, rather than printing an empty list', () => {
    const result = outsideWorkspaceRefusal('Read', { arguments: { filePath: '/etc/hostname' } });

    expect(result.content).toContain('(none)');
  });

  it('carries the call id, so the result lands on the call that asked', () => {
    const result = outsideWorkspaceRefusal(
      'Read',
      { arguments: { filePath: '/etc/hostname' } },
      { toolCallId: 'r7' },
    );

    expect(result.toolCallId).toBe('r7');
  });

  it('names the tool and the target in the structured error, for the activity log', () => {
    const result = outsideWorkspaceRefusal('Grep', {
      arguments: { pattern: 'secret', path: '/etc' },
    });

    expect(result.structuredError?.details).toMatchObject({ tool: 'Grep' });
  });

  it('maps to a remedy that names the directory rather than a permission rule', () => {
    // A rule cannot lift this: no permission rule and no permission mode can serve the path, so
    // a remedy that said "grant the permission" would be a dead end.
    expect(REFUSAL_REMEDIES.outside).toContain('additionalDirectories');
    expect(REFUSAL_REMEDIES.outside).not.toContain('--permission-mode auto');
  });

  /**
   * PR #334. The target is whatever argument the model wrote, and `noteChildRefusal` pushes this
   * message to the operator's terminal in print mode as an `agent_notice`. An ESC sequence there
   * can retitle the line or repaint the screen, and a bidi override can display the text as
   * something other than what it is — the same class the tool rows fold with the shared set
   * (#283). The doc comment claimed `printableRule` did this; nothing called it.
   */
  it('folds control characters out of the target before it names it', () => {
    const esc = String.fromCharCode(0x1b);
    const bidi = String.fromCharCode(0x202e);
    const result = outsideWorkspaceRefusal('Read', {
      arguments: { filePath: `/etc/${esc}[31mred${esc}[0m/${bidi}gnp.exe` },
    });

    const shown = `${result.content}\n${JSON.stringify(result.structuredError?.details)}`;

    expect(shown).not.toContain(esc);
    expect(shown).not.toContain(bidi);
    // Folded to spaces, not dropped: the model still needs to see which path it asked for.
    expect(result.content).toContain('/etc/ [31mred [0m/ gnp.exe');
  });

  it('folds a Glob pattern and a Grep scope on the same terms', () => {
    // Every branch of `readTargetOf` names a model-chosen string, so every one is folded. A Grep
    // falls back to its pattern when it names no scope.
    const anyControl = new RegExp(`[${CONTROL_CHARACTERS.source.slice(1, -2)}]`);
    for (const [tool, args] of [
      ['Glob', { pattern: `**/${String.fromCharCode(0x1b)}[2J*.ts` }],
      ['Grep', { path: `/etc/${String.fromCharCode(0x202e)}gnp` }],
      ['Grep', { pattern: `tok${String.fromCharCode(0x200e)}en` }],
    ] as const) {
      const result = outsideWorkspaceRefusal(tool, { arguments: args });
      expect(result.content, tool).not.toMatch(anyControl);
    }
  });
});
