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
    expect(error).not.toContain('add a permissions.allow rule');
    // An ask rule prompts in `auto` too (#527), so `auto` is no way through.
    expect(error).not.toContain('--permission-mode auto');
    expect(error).toContain('--permission-mode bypassPermissions');
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

  it('says a dismissed prompt went unanswered rather than declined', () => {
    const error = permissionDeniedError('Bash', { kind: 'dismissed' });
    expect(error).toContain('dismissed');
    expect(error).not.toContain('The user declined');
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

  it('keeps a model-chosen argument from writing control sequences to the terminal', () => {
    const rule = `Bash(echo \u001b]0;owned\u0007 \u009b31m \u202eevil\nsecond line)`;
    for (const text of [
      unattendedRefusalNotice('Bash', { kind: 'rule_or_auto', rule })!,
      permissionDeniedError('Bash', {
        kind: 'no_approver',
        remedy: { kind: 'rule_or_auto', rule },
      }),
    ]) {
      expect(text).not.toMatch(
        /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/,
      );
      expect(text).not.toContain('second line');
      expect(text).not.toContain('owned');
    }
  });
});

// A rule that `printableRule` would cut or clean is not the rule: a cut one has no closing paren,
// and `parseRule` reads `Bash(cd /very/long…` as a bare `Bash` rule that allows everything.
describe('a rule that cannot be printed whole is described, never quoted (#512)', () => {
  const long = `Bash(cd ${'/very/long/path'.repeat(14)} && npm test)`;
  const tabbed = 'Bash(cd x &&\tnpm test)';
  const everyRemedy = (rule: string) =>
    [
      { kind: 'rule_or_auto', rule },
      { kind: 'allow_rule_only', rule },
      { kind: 'ask_rule', rule },
      { kind: 'compound_under_policy', rule },
      { kind: 'compound_under_policy', askRule: rule },
    ] as const;

  it.each([
    ['a 200-character compound command', long],
    ['a command containing a tab', tabbed],
  ])('names no part of %s', (_label, rule) => {
    expect(long.length).toBeGreaterThan(120);
    for (const remedy of everyRemedy(rule)) {
      const texts = [
        permissionDeniedError('Bash', { kind: 'no_approver', remedy }),
        unattendedRefusalNotice('Bash', remedy)!,
      ];
      for (const text of texts) {
        expect(text, remedy.kind).not.toContain('…');
        expect(text, remedy.kind).not.toContain('Bash(cd');
        expect(text, remedy.kind).not.toContain('"Bash(');
        expect(text, remedy.kind).not.toMatch(/\t/);
      }
    }
  });

  it('says the exact rule is too long to print, and still names the other ways through', () => {
    const text = unattendedRefusalNotice('Bash', { kind: 'rule_or_auto', rule: long })!;
    expect(text).toContain('too long');
    expect(text).toContain('--permission-mode auto');
    const compound = unattendedRefusalNotice('Bash', {
      kind: 'compound_under_policy',
      rule: long,
    })!;
    expect(compound).toContain('too long');
    expect(compound).toContain('as its own Bash call');
    expect(compound).toContain('bypassPermissions');
  });

  it('still quotes a rule that prints whole', () => {
    const text = unattendedRefusalNotice('Bash', { kind: 'rule_or_auto', rule: 'Bash(npm test)' })!;
    expect(text).toContain('"Bash(npm test)"');
  });
});

// `Bash` with no pattern is a rule that allows every command, so a remedy with no rule to name must
// not name the bare tool.
describe('a remedy with no rule to name never suggests a bare Bash rule (#512)', () => {
  it.each(['rule_or_auto', 'allow_rule_only'] as const)('%s', (kind) => {
    for (const text of [
      permissionDeniedError('Bash', { kind: 'no_approver', remedy: { kind } }),
      unattendedRefusalNotice('Bash', { kind })!,
    ]) {
      expect(text).not.toMatch(/"Bash"/);
      expect(text).toContain('no single permissions.allow rule');
      expect(text).toContain('one-line Bash call');
    }
  });

  // The clause names why the command has no rule, not always the `*` (review of #531).
  it.each([
    ['a line break', { lineBreak: true, wildcard: false }, { star: false, oneLine: true }],
    ['a *', { lineBreak: false, wildcard: true }, { star: true, oneLine: false }],
    ['both', { lineBreak: true, wildcard: true }, { star: true, oneLine: true }],
  ])('names %s as the reason', (_label, noRule, says) => {
    for (const remedy of [
      { kind: 'rule_or_auto', noRule },
      { kind: 'allow_rule_only', noRule },
    ] as const) {
      for (const text of [
        permissionDeniedError('Bash', { kind: 'no_approver', remedy }),
        unattendedRefusalNotice('Bash', remedy)!,
      ]) {
        expect(text).toContain('no single permissions.allow rule');
        expect(text.includes('`*`'), text).toBe(says.star);
        expect(text.includes('a rule holds one line'), text).toBe(says.oneLine);
        expect(text.includes('one-line Bash call'), text).toBe(says.oneLine);
        expect(text.includes('names its files'), text).toBe(says.star);
      }
    }
  });

  it('says why a non-Bash call with a wildcard has no rule, and names no bare tool rule', () => {
    const remedy = { kind: 'rule_or_auto', noRule: { lineBreak: false, wildcard: true } } as const;
    for (const text of [
      permissionDeniedError('Write', { kind: 'no_approver', remedy }),
      unattendedRefusalNotice('Write', remedy)!,
    ]) {
      expect(text).not.toMatch(/"Write/);
      expect(text).toContain('`*` or `?`');
      expect(text).not.toContain('Bash call');
      expect(text).toContain('--permission-mode auto');
    }
  });

  it('keeps the auto option only where auto applies', () => {
    expect(unattendedRefusalNotice('Bash', { kind: 'rule_or_auto' })!).toContain(
      '--permission-mode auto',
    );
    // Skill consent keeps its note that `auto` still asks.
    expect(unattendedRefusalNotice('Bash', { kind: 'allow_rule_only' })!).toContain('still asks');
  });
});

describe('the compound command remedy (#512)', () => {
  const remedy = { kind: 'compound_under_policy', rule: 'Bash(cd x && npm test)' } as const;

  it('names the three real ways through, and never --permission-mode auto', () => {
    const error = permissionDeniedError('Bash', { kind: 'no_approver', remedy });
    expect(error).toContain('as its own Bash call');
    expect(error).toContain('permissions.allow');
    expect(error).toContain('"Bash(cd x && npm test)"');
    expect(error).toContain('bypassPermissions');
    expect(error).not.toContain('--permission-mode auto');
    const notice = unattendedRefusalNotice('Bash', remedy)!;
    expect(notice).toContain('"Bash(cd x && npm test)"');
    expect(notice).toContain('bypassPermissions');
    expect(notice).not.toContain('--permission-mode auto');
  });

  it('leaves out the allow rule when no exact rule could admit the command', () => {
    const error = permissionDeniedError('Bash', {
      kind: 'no_approver',
      remedy: { kind: 'compound_under_policy' },
    });
    expect(error).toContain('as its own Bash call');
    expect(error).toContain('bypassPermissions');
    expect(error).not.toContain('permissions.allow');
  });

  it('says the ask rule outranks an allow rule when one matched the whole command', () => {
    const error = permissionDeniedError('Bash', {
      kind: 'no_approver',
      remedy: {
        kind: 'compound_under_policy',
        rule: 'Bash(curl x && rm y)',
        askRule: 'Bash(curl *)',
      },
    });
    expect(error).toContain('permissions.ask rule Bash(curl *)');
    expect(error).not.toContain('"Bash(curl x && rm y)"');
    expect(error).not.toContain('--permission-mode auto');
  });

  it('does not promise that removing the ask rule is enough while other Bash rules exist', () => {
    const remedy = {
      kind: 'compound_under_policy',
      askRule: 'Bash(curl *)',
    } as const;
    for (const text of [
      permissionDeniedError('Bash', { kind: 'no_approver', remedy }),
      unattendedRefusalNotice('Bash', remedy)!,
    ]) {
      expect(text).toContain('permissions.ask rule Bash(curl *)');
      expect(text).toContain('not enough on its own while any other Bash deny or ask rule exists');
      expect(text).toContain('works in every case');
      expect(text).toContain('as its own Bash call');
    }
  });
});
