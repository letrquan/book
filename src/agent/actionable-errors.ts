export interface ActionableToolError {
  code: string;
  action: string;
  reason: string;
  restrictionIntent?: string;
  alternatives?: string[];
  nextAction?: string;
  requiresUserApproval?: boolean;
}

export function formatActionableToolError(error: ActionableToolError): string {
  const lines = [`${error.action}: ${error.reason}`];
  if (error.restrictionIntent) lines.push('', error.restrictionIntent);
  if (error.alternatives?.length)
    lines.push('', `Safe alternatives: ${error.alternatives.join('; ')}.`);
  if (error.nextAction) lines.push('', `Next action: ${error.nextAction}`);
  return lines.join('\n');
}

/** What would let a call through that nothing in the run could approve, if anything. */
export type UnattendedRemedy =
  /** A `permissions.allow` rule, or `--permission-mode auto`. */
  | { kind: 'rule_or_auto'; rule: string }
  /** A `permissions.ask` rule asks for it, and no allow rule outranks an ask rule. */
  | { kind: 'ask_rule'; rule: string }
  /** Skill consent: an allow rule lets it through, but `auto` still asks. */
  | { kind: 'allow_rule_only'; rule: string }
  /** A persistent background shell asks in every mode but bypassPermissions, allow rules or not. */
  | { kind: 'bypass_only' }
  /** A Read, Glob or Grep the tool itself refuses: nothing lets it through. */
  | { kind: 'outside_workspace' };

/** What refused a call that needed permission. */
export type PermissionDenialCause =
  /** A `permissions.deny` rule, which applies in every mode. */
  | { kind: 'rule'; rule?: string }
  /** A person declined the prompt. */
  | { kind: 'user' }
  /** Nothing in this run can answer a prompt (print mode, the SDK, a background agent). */
  | { kind: 'no_approver'; remedy: UnattendedRemedy }
  /** The prompt was withdrawn before anyone answered it. */
  | { kind: 'dismissed' }
  /** `dontAsk` mode refuses every call that would need approval. */
  | { kind: 'dont_ask'; askRule?: string };

const DO_NOT_BYPASS =
  'Do not bypass the intent through another shell, test runner, or indirect command.';
const LOCAL_ALTERNATIVE = 'continue with local read-only verification when possible';

function askRuleNote(askRule: string | undefined): string {
  return askRule ? ` The permissions.ask rule ${askRule} requires approval for it.` : '';
}

/** The operator's way through, as a clause that follows "To allow it, ". */
function remedyClause(remedy: UnattendedRemedy): string | undefined {
  switch (remedy.kind) {
    case 'rule_or_auto':
      return `add a permissions.allow rule such as "${remedy.rule}" to your settings, or run with --permission-mode auto`;
    case 'ask_rule':
      return `narrow or remove the permissions.ask rule ${remedy.rule}, which asks for it and outranks any allow rule, or run with --permission-mode auto`;
    case 'allow_rule_only':
      return `add a permissions.allow rule such as "${remedy.rule}" to your settings (--permission-mode auto still asks for it)`;
    case 'bypass_only':
      return 'run with --permission-mode bypassPermissions: a persistent background shell asks in every other mode, whatever the allow rules say';
    case 'outside_workspace':
      return undefined;
  }
}

export function permissionDeniedError(toolName: string, cause: PermissionDenialCause): string {
  const denied = `Permission to use ${toolName} was denied`;
  switch (cause.kind) {
    case 'rule':
      return formatActionableToolError({
        code: 'permission_denied',
        action: `${denied}${cause.rule ? ` by rule ${cause.rule}` : ''}`,
        reason: 'A permissions.deny rule blocks this call in every permission mode.',
        restrictionIntent: DO_NOT_BYPASS,
        alternatives: [LOCAL_ALTERNATIVE],
        nextAction:
          'If the blocked action is essential, explain why and ask the user to change that rule.',
        requiresUserApproval: true,
      });
    case 'user':
      return formatActionableToolError({
        code: 'permission_denied',
        action: denied,
        reason: 'The user declined this call when asked.',
        restrictionIntent: DO_NOT_BYPASS,
        alternatives: [LOCAL_ALTERNATIVE],
        nextAction:
          'If the blocked action is essential, explain why and ask the user to approve that specific action.',
        requiresUserApproval: true,
      });
    case 'dismissed':
      return formatActionableToolError({
        code: 'permission_denied',
        action: denied,
        reason:
          'The permission prompt was dismissed before anyone answered it (the run was ' +
          'interrupted, the session changed, or the agent was stopped).',
        restrictionIntent: DO_NOT_BYPASS,
        alternatives: [LOCAL_ALTERNATIVE],
        nextAction: 'If the call is still needed, make it again once the work resumes.',
        requiresUserApproval: true,
      });
    case 'no_approver': {
      const clause = remedyClause(cause.remedy);
      return formatActionableToolError({
        code: 'permission_denied',
        action: denied,
        reason:
          'This call needs approval, and nothing in this run can answer a permission prompt ' +
          '(print mode, the SDK and background agents cannot ask), so it was refused.' +
          (clause
            ? ''
            : ' Its target is outside the workspace, which Read, Glob and Grep cannot open even when allowed.'),
        restrictionIntent: DO_NOT_BYPASS,
        alternatives: [LOCAL_ALTERNATIVE],
        nextAction: clause
          ? 'Do not retry this call unchanged. Continue without it if you can; if it is essential, ' +
            `stop and say it needs approval. To allow it, the operator can ${clause}.`
          : 'Do not retry it. Work from files inside the workspace.',
        requiresUserApproval: true,
      });
    }
    case 'dont_ask':
      return formatActionableToolError({
        code: 'permission_denied',
        action: denied,
        reason:
          'dontAsk mode refuses every call that would need approval.' + askRuleNote(cause.askRule),
        restrictionIntent: DO_NOT_BYPASS,
        alternatives: [LOCAL_ALTERNATIVE],
        nextAction:
          'Do not retry this call unchanged. Continue without it if you can; if it is essential, ' +
          'stop and say it needs approval in another permission mode.',
        requiresUserApproval: true,
      });
  }
}

/**
 * The operator-facing line for a call refused because nothing could answer its prompt, shown once
 * per session per tool and remedy (on stderr in print mode, as a `notice` event in stream-json).
 * `undefined` when nothing would let the call through.
 */
export function unattendedRefusalNotice(
  toolName: string,
  remedy: UnattendedRemedy,
): string | undefined {
  const clause = remedyClause(remedy);
  if (!clause) return undefined;
  return (
    `${toolName} needs approval, and nothing in this run can answer a permission prompt, so ` +
    `the call was refused. To allow it, ${clause}.`
  );
}
