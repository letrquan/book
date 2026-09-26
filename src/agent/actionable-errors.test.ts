import { describe, expect, it } from 'vitest';
import { permissionDeniedError, unattendedRefusalNotice } from './actionable-errors.js';

describe('actionable tool errors', () => {
  it('names the matched deny rule and safe recovery path', () => {
    const error = permissionDeniedError('Bash', { kind: 'rule', rule: 'Bash(git push *)' });
    expect(error).toContain('Bash(git push *)');
    expect(error).toContain('permissions.deny');
    expect(error).toContain('Do not bypass');
    expect(error).toContain('ask the user');
  });

  it('says the user declined when a person refused the prompt', () => {
    const error = permissionDeniedError('Read', { kind: 'user' });
    expect(error).toContain('The user declined');
    expect(error).not.toContain('configured permission policy');
  });

  it('says nobody could be asked in an unattended run, and names the remedies (#264)', () => {
    const error = permissionDeniedError('Bash', {
      kind: 'no_approver',
      remedy: { kind: 'rule_or_auto', rule: 'Bash(npm test)' },
    });
    expect(error).toContain('print mode');
    expect(error).toContain('"Bash(npm test)"');
    expect(error).toContain('--permission-mode auto');
    expect(error).toContain('Do not retry this call unchanged');
    expect(error).not.toContain('configured permission policy');
    expect(error).not.toContain('by rule');
  });

  it('points at the ask rule, not at an allow rule it outranks', () => {
    const error = permissionDeniedError('Read', {
      kind: 'no_approver',
      remedy: { kind: 'ask_rule', rule: 'Read(secrets/**)' },
    });
    expect(error).toContain('permissions.ask rule Read(secrets/**)');
    expect(error).toContain('--permission-mode auto');
    expect(error).not.toContain('add a permissions.allow rule');
  });

  it('offers only what works for skill consent and a persistent background shell', () => {
    const skill = permissionDeniedError('InvokeSkill', {
      kind: 'no_approver',
      remedy: { kind: 'allow_rule_only', rule: 'InvokeSkill(review)' },
    });
    expect(skill).toContain('"InvokeSkill(review)"');
    expect(skill).toContain('--permission-mode auto still asks');
    const shell = permissionDeniedError('Bash', {
      kind: 'no_approver',
      remedy: { kind: 'bypass_only' },
    });
    expect(shell).toContain('--permission-mode bypassPermissions');
    expect(shell).not.toContain('--permission-mode auto');
    expect(shell).not.toContain('add a permissions.allow rule');
  });

  it('says a file tool cannot reach outside the workspace instead of offering a remedy', () => {
    const error = permissionDeniedError('Read', {
      kind: 'no_approver',
      remedy: { kind: 'outside_workspace' },
    });
    expect(error).toContain('outside the workspace');
    expect(error).not.toContain('--permission-mode auto');
    expect(error).not.toContain('permissions.allow');
  });

  it('says dontAsk refused the call rather than a rule', () => {
    const error = permissionDeniedError('Read', { kind: 'dont_ask' });
    expect(error).toContain('dontAsk');
    expect(error).not.toContain('configured permission policy');
  });

  it('tells the operator how to let a refused call through', () => {
    const notice = unattendedRefusalNotice('Read', {
      kind: 'rule_or_auto',
      rule: 'Read(../notes.txt)',
    });
    expect(notice).toContain('Read needs approval');
    expect(notice).toContain('"Read(../notes.txt)"');
    expect(notice).toContain('--permission-mode auto');
    expect(unattendedRefusalNotice('Read', { kind: 'outside_workspace' })).toBeUndefined();
  });
});
