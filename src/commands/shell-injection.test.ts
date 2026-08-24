import { describe, expect, it } from 'vitest';
import { applyShellInjections, extractShellInjections } from './shell-injection.js';

describe('extractShellInjections', () => {
  it('extracts an inline shell span', () => {
    const body = 'Branch: !`git branch --show-current`';
    const [injection] = extractShellInjections(body);
    expect(injection).toMatchObject({ kind: 'command', command: 'git branch --show-current' });
    expect(body.slice(injection.start, injection.end)).toBe('!`git branch --show-current`');
  });

  it('extracts a fenced shell block', () => {
    const body = 'Status:\n```!\ngit status --short\n```\ndone';
    const [injection] = extractShellInjections(body);
    expect(injection.kind).toBe('block');
    expect(injection.command).toBe('git status --short');
    expect(body.slice(injection.start, injection.end)).toBe('```!\ngit status --short\n```');
  });

  it('ignores a plain code span but keeps later offsets correct', () => {
    const body = 'Call `render()` then !`echo hi`';
    const injections = extractShellInjections(body);
    expect(injections).toHaveLength(1);
    expect(injections[0].command).toBe('echo hi');
    expect(body.slice(injections[0].start, injections[0].end)).toBe('!`echo hi`');
  });

  it('accepts the leading-bang-inside-backticks spelling', () => {
    expect(extractShellInjections('`!echo hi`')[0]).toMatchObject({
      kind: 'command',
      command: 'echo hi',
    });
  });

  it('preserves order across both forms', () => {
    const injections = extractShellInjections('!`one`\n```!\ntwo\n```\n!`three`');
    expect(injections.map((injection) => injection.command)).toEqual(['one', 'two', 'three']);
  });

  it('returns nothing for a body with no substitution', () => {
    expect(extractShellInjections('Just prose with `code` in it.')).toEqual([]);
  });
});

describe('applyShellInjections', () => {
  it('substitutes each span with its output', () => {
    const body = 'a !`one` b !`two` c';
    const result = applyShellInjections(body, extractShellInjections(body), ['1', '2']);
    expect(result).toBe('a 1 b 2 c');
  });

  it('never rescans output as source', () => {
    // A block that prints an injection marker used to have it executed by the
    // second pass. Spans are taken from the original body, so the marker is
    // inert text in the prompt.
    const body = 'x\n```!\nprint\n```\ny';
    const result = applyShellInjections(body, extractShellInjections(body), ['!`rm -rf /`']);
    expect(result).toBe('x\n!`rm -rf /`\ny');
    // The substituted text is not itself a span of the resolved body it came from.
    expect(extractShellInjections(body)).toHaveLength(1);
  });

  it('leaves the body untouched when there is nothing to substitute', () => {
    expect(applyShellInjections('plain', [], [])).toBe('plain');
  });
});

describe('backtick parity outside the block', () => {
  it('finds a fenced block after an unrelated plain fence', () => {
    // Folding both forms into one alternation let the plain fence shift backtick
    // parity, so the inline branch ate the first backtick of the `!` opener and
    // the block was extracted as an inline command.
    const body = ['```', 'sample out', '```', '', '```!', 'git log', '```'].join('\n');
    expect(extractShellInjections(body)).toEqual([
      { kind: 'block', command: 'git log', start: 20, end: 36 },
    ]);
    expect(body.slice(20, 36)).toBe('```!\ngit log\n```');
  });

  it('substitutes that block without leaving stray backticks', () => {
    const body = ['```', 'sample out', '```', '', '```!', 'git log', '```'].join('\n');
    const result = applyShellInjections(body, extractShellInjections(body), ['abc123 fix']);
    expect(result).toBe('```\nsample out\n```\n\nabc123 fix');
  });

  it('finds a fenced block after a stray backtick in prose', () => {
    const body = ['Use ` carefully.', '', '```!', 'git log', '```'].join('\n');
    const [injection] = extractShellInjections(body);
    expect(injection).toMatchObject({ kind: 'block', command: 'git log' });
  });

  it('does not let a block body pair backticks with later prose', () => {
    const body = ['```!', 'echo `x`', '```', '', 'then !`echo hi`'].join('\n');
    expect(extractShellInjections(body).map((injection) => injection.command)).toEqual([
      'echo `x`',
      'echo hi',
    ]);
  });
});
