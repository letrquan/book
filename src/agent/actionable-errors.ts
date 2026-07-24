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

export function permissionDeniedError(toolName: string, matchedRule?: string): string {
  return formatActionableToolError({
    code: 'permission_denied',
    action: `Permission to use ${toolName} was denied${matchedRule ? ` by rule ${matchedRule}` : ''}`,
    reason: 'The configured permission policy blocks this call.',
    restrictionIntent:
      'Do not bypass the intent through another shell, test runner, or indirect command.',
    alternatives: ['continue with local read-only verification when possible'],
    nextAction:
      'If the blocked action is essential, explain why and ask the user to approve that specific action.',
    requiresUserApproval: true,
  });
}
