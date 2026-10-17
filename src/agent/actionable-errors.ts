import type { MissingRuleReason } from '../permissions.js';

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
  /**
   * A `permissions.allow` rule, or `--permission-mode auto`. `rule` is absent when no single rule
   * covers exactly the call (a Bash command that spans lines or holds `*`, #521; an argument
   * holding `*` or `?`): the bare tool name would allow every call, so it is never offered in its
   * place. `noRule` then says why (`missingRuleReason` in `permissions.ts`).
   */
  | { kind: 'rule_or_auto'; rule?: string; noRule?: MissingRuleReason }
  /** A `permissions.ask` rule asks for it, and no allow rule outranks an ask rule. */
  | { kind: 'ask_rule'; rule: string }
  /** Skill consent: an allow rule lets it through, but `auto` still asks. Fields as above. */
  | { kind: 'allow_rule_only'; rule?: string; noRule?: MissingRuleReason }
  /** A persistent background shell asks in every mode but bypassPermissions, allow rules or not. */
  | { kind: 'bypass_only' }
  /** A Read, Glob or Grep the tool itself refuses: nothing lets it through. */
  | { kind: 'outside_workspace' }
  /**
   * A compound Bash command while a Bash deny or ask rule exists: asked about in every mode but
   * bypassPermissions, `auto` included (see `compoundUnderPolicy` in `permissions.ts`).
   * `rule` is the exact rule that would admit the command, absent when none could (a multi-line
   * command, or one containing `*`); `askRule` is the ask rule that matched it, which
   * outranks every allow rule, so an exact rule would not help.
   */
  | { kind: 'compound_under_policy'; rule?: string; askRule?: string };

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

/** Longest rule a remedy quotes. */
const RULE_TEXT_MAX = 120;

/**
 * A rule fit to print: its first line, with control characters (escape sequences, bidi
 * overrides, line separators) turned into spaces, and its length capped. The rule is built from
 * a model-chosen argument, and print mode writes the notice straight to the operator's terminal.
 */
function printableRule(rule: string): string {
  const firstLine = rule.split(/\r\n|\r|\n/, 1)[0];
  const flat = firstLine.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    ' ',
  );
  return flat.length > RULE_TEXT_MAX ? `${flat.slice(0, RULE_TEXT_MAX - 1)}…` : flat;
}

/** What stands in for a rule that cannot be printed whole. */
const UNPRINTABLE_RULE =
  'its exact rule, which is too long or holds characters that cannot be printed here';

/**
 * A rule to quote, or `undefined` when printing it would alter it. A cut rule has no closing
 * paren, and `parseRule` reads `Bash(cd /very/long…` as a bare `Bash` rule that allows every
 * command, so a rule {@link printableRule} would change is described instead, never quoted.
 */
function quotableRule(rule: string): string | undefined {
  return printableRule(rule) === rule ? rule : undefined;
}

/**
 * What to do when a call has no rule of its own, naming the reason it has none: a Bash command
 * that spans lines (a rule holds one line), one holding `*`, or both; or another tool's argument
 * holding `*` or `?`. A rule holding those would be a wildcard that admits other calls too.
 */
function noRuleClause(toolName: string, noRule: MissingRuleReason | undefined): string {
  if (toolName !== 'Bash') {
    return 'write a permissions.allow rule that covers only what you mean to allow (none is derived from this call: its argument holds a `*` or `?`, which a rule reads as a wildcard that admits other calls too)';
  }
  const star = 'a `*` in a rule is a wildcard that admits other commands too';
  if (noRule?.lineBreak && noRule.wildcard) {
    return `have each command sent as its own one-line Bash call that names its files instead of using \`*\` (no single permissions.allow rule covers this command: a rule holds one line, and ${star})`;
  }
  if (noRule?.wildcard) {
    return `have the command sent as one that names its files instead of using \`*\` (no single permissions.allow rule covers this command: ${star})`;
  }
  if (noRule?.lineBreak) {
    return 'have each command sent as its own one-line Bash call (no single permissions.allow rule covers this command: a rule holds one line)';
  }
  return 'have the command sent as its own one-line Bash call (no single permissions.allow rule covers this command)';
}

/** "a permissions.allow rule such as "<rule>"", or what to do when no rule can be shown. */
function allowRuleClause(
  toolName: string,
  rule: string | undefined,
  noRule: MissingRuleReason | undefined,
): string {
  if (rule === undefined) return noRuleClause(toolName, noRule);
  const quotable = quotableRule(rule);
  return quotable
    ? `add a permissions.allow rule such as "${quotable}" to your settings`
    : `add a permissions.allow rule for this command (${UNPRINTABLE_RULE}) to your settings`;
}

/** The ask rule that matched, quoted when it prints whole. */
function askRuleRef(rule: string): string {
  return `permissions.ask rule ${quotableRule(rule) ?? `that matches it (${UNPRINTABLE_RULE})`}`;
}

/** The operator's way through, as a clause that follows "To allow it, ". */
function remedyClause(toolName: string, remedy: UnattendedRemedy): string | undefined {
  switch (remedy.kind) {
    case 'rule_or_auto':
      return `${allowRuleClause(toolName, remedy.rule, remedy.noRule)}, or run with --permission-mode auto`;
    case 'ask_rule':
      return `narrow or remove the ${askRuleRef(remedy.rule)}, which asks for it in every mode but bypassPermissions and outranks any allow rule, or run with --permission-mode bypassPermissions`;
    case 'allow_rule_only':
      return `${allowRuleClause(toolName, remedy.rule, remedy.noRule)} (--permission-mode auto still asks for it)`;
    case 'bypass_only':
      return 'run with --permission-mode bypassPermissions: a persistent background shell asks in every other mode, whatever the allow rules say';
    case 'compound_under_policy': {
      const send = 'have each command sent as its own Bash call';
      const bypass =
        'run with --permission-mode bypassPermissions (every other mode asks for a compound command while a Bash deny or ask rule exists)';
      if (remedy.askRule) {
        // Sending each command alone is the one remedy that always works: the compound ask fires
        // whatever the ask rule says while any other Bash deny or ask rule exists.
        return `${send} (this works in every case), narrow or remove the ${askRuleRef(remedy.askRule)}, which asks for it and outranks any allow rule (removing it is not enough on its own while any other Bash deny or ask rule exists, since every compound command asks then), or ${bypass}`;
      }
      if (remedy.rule) {
        const quotable = quotableRule(remedy.rule);
        return quotable
          ? `${send}, add the exact rule "${quotable}" to permissions.allow in your settings, or ${bypass}`
          : `${send}, add the exact permissions.allow rule for this command (${UNPRINTABLE_RULE}) to your settings, or ${bypass}`;
      }
      return `${send} (no exact allow rule can admit this command), or ${bypass}`;
    }
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
      const clause = remedyClause(toolName, cause.remedy);
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
  const clause = remedyClause(toolName, remedy);
  if (!clause) return undefined;
  return (
    `${toolName} needs approval, and nothing in this run can answer a permission prompt, so ` +
    `the call was refused. To allow it, ${clause}.`
  );
}
