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
    const error = permissionDeniedError('Read', { kind: 'no_approver' });
    expect(error).toContain('print mode');
    expect(error).toContain('permissions.allow');
    expect(error).toContain('--permission-mode auto');
    expect(error).toContain('Do not retry this call unchanged');
    expect(error).not.toContain('configured permission policy');
    expect(error).not.toContain('by rule');
    expect(
      permissionDeniedError('Read', { kind: 'no_approver', askRule: 'Read(secrets/**)' }),
    ).toContain('permissions.ask rule Read(secrets/**)');
  });

  it('says dontAsk refused the call rather than a rule', () => {
    const error = permissionDeniedError('Read', { kind: 'dont_ask' });
    expect(error).toContain('dontAsk');
    expect(error).not.toContain('configured permission policy');
  });

  it('tells the operator how to let a refused call through', () => {
    const notice = unattendedRefusalNotice('Read', 'Read(../notes.txt)');
    expect(notice).toContain('Read');
    expect(notice).toContain('"Read(../notes.txt)"');
    expect(notice).toContain('--permission-mode auto');
  });
});
