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

/** What refused a call that needed permission. */
export type PermissionDenialCause =
  /** A `permissions.deny` rule, which applies in every mode. */
  | { kind: 'rule'; rule?: string }
  /** A person declined the prompt. */
  | { kind: 'user' }
  /** Nothing in this run can answer a prompt (print mode, the SDK, a background agent). */
  | { kind: 'no_approver'; askRule?: string }
  /** `dontAsk` mode refuses every call that would need approval. */
  | { kind: 'dont_ask'; askRule?: string };

const DO_NOT_BYPASS =
  'Do not bypass the intent through another shell, test runner, or indirect command.';
const LOCAL_ALTERNATIVE = 'continue with local read-only verification when possible';

function askRuleNote(askRule: string | undefined): string {
  return askRule ? ` The permissions.ask rule ${askRule} requires approval for it.` : '';
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
    case 'no_approver':
      return formatActionableToolError({
        code: 'permission_denied',
        action: denied,
        reason:
          'This call needs approval, and nothing in this run can answer a permission prompt ' +
          '(print mode, the SDK and background agents cannot ask), so it was refused.' +
          askRuleNote(cause.askRule),
        restrictionIntent: DO_NOT_BYPASS,
        alternatives: [LOCAL_ALTERNATIVE],
        nextAction:
          'Do not retry this call unchanged. Continue without it if you can; if it is essential, ' +
          'stop and say it needs approval: the operator can allow it with a permissions.allow ' +
          'rule or --permission-mode auto.',
        requiresUserApproval: true,
      });
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
 * The operator-facing line for a call refused because nothing could answer its prompt, printed
 * once per tool per run (on stderr in print mode, as a `notice` event in stream-json).
 */
export function unattendedRefusalNotice(toolName: string, rule: string): string {
  return (
    `${toolName} needs approval, and nothing in this run can answer a permission prompt, so ` +
    `the call was refused. To allow it, add a permissions.allow rule such as "${rule}" to your ` +
    'settings, or run with --permission-mode auto.'
  );
}
