import { describe, expect, it } from 'vitest';
import {
  frontMatterClose,
  markdownContentStart,
  parseAllowedTools,
  parseFrontmatter,
} from './frontmatter.js';

describe('frontMatterClose', () => {
  it('finds the closing --- or ..., trailing spaces allowed', () => {
    expect(frontMatterClose(['---', 'a: 1', '---'])).toBe(2);
    expect(frontMatterClose(['---  ', 'a: 1', '...'])).toBe(2);
    expect(frontMatterClose(['---', 'a: 1', '---   '])).toBe(2);
  });

  it('returns -1 when nothing opens or closes the block', () => {
    expect(frontMatterClose(['# Title', '---'])).toBe(-1);
    expect(frontMatterClose(['---', 'a: 1'])).toBe(-1);
  });
});

describe('markdownContentStart', () => {
  it('skips front matter with comments before and between its keys', () => {
    expect(markdownContentStart(['---', '# c', 'a: 1', '', '# d', 'b: 2', '---', '# H'])).toBe(7);
  });

  it('treats a block whose # line stands alone as a rule and text', () => {
    expect(markdownContentStart(['---', 'Title: x', '', '# Intro', '', '---'])).toBe(0);
    expect(markdownContentStart(['---', '', '# First', '---'])).toBe(0);
    expect(markdownContentStart(['---', '# Skill metadata', '', 'name: deploy', '---'])).toBe(0);
  });

  it('keeps a heading that sits beside a prose label', () => {
    expect(
      markdownContentStart(['---', 'Author: Jane', '', '# Introduction', 'Summary: x', '---']),
    ).toBe(0);
    expect(markdownContentStart(['---', '# Release notes', 'Version: 1.2', '---'])).toBe(0);
  });
});

describe('parseFrontmatter block lists (#712)', () => {
  const list = (...items: string[]) =>
    parseFrontmatter(
      ['---', 'allowed-tools:', ...items.map((i) => `- ${i}`), '---', 'x'].join('\n'),
    ).frontmatter['allowed-tools'];

  it('unquotes a quoted block-list item as the scalar and inline forms do', () => {
    expect(list('"Read"', "'Read'", '"Bash(git *)"')).toEqual(['Read', 'Read', 'Bash(git *)']);
    const inline = parseFrontmatter('---\nallowed-tools: ["Read", "Bash(git *)"]\n---\nx');
    expect(inline.frontmatter['allowed-tools']).toEqual(['Read', 'Bash(git *)']);
  });

  it('leaves an unquoted item and a quote inside an item alone', () => {
    expect(list('Read', 'Bash(echo "a")')).toEqual(['Read', 'Bash(echo "a")']);
  });

  it('reads a quoted block list written with CRLF line endings', () => {
    const raw = '---\r\nallowed-tools:\r\n- "Read"\r\n- \'Task\'\r\n---\r\nx';
    expect(parseFrontmatter(raw).frontmatter['allowed-tools']).toEqual(['Read', 'Task']);
  });
});

describe('parseAllowedTools (#717)', () => {
  it('splits a string on commas and whitespace', () => {
    expect(parseAllowedTools('Read, Task')).toEqual(['Read', 'Task']);
    expect(parseAllowedTools('Read Task')).toEqual(['Read', 'Task']);
    expect(parseAllowedTools('Read,Task')).toEqual(['Read', 'Task']);
    expect(parseAllowedTools('  Read ,\t Task  ')).toEqual(['Read', 'Task']);
  });

  it('keeps a parenthesised pattern whole, spaces and commas inside it included', () => {
    expect(parseAllowedTools('Bash(git *), Read')).toEqual(['Bash(git *)', 'Read']);
    expect(parseAllowedTools('Bash(git commit:*) Read')).toEqual(['Bash(git commit:*)', 'Read']);
    expect(parseAllowedTools('Bash(a, b), Read')).toEqual(['Bash(a, b)', 'Read']);
  });

  it('keeps what an unclosed parenthesis swallows as one item, so it narrows and never widens', () => {
    expect(parseAllowedTools('Bash(git *, Read')).toEqual(['Bash(git *, Read']);
    expect(parseAllowedTools('Read) Task')).toEqual(['Read)', 'Task']);
  });

  it('reads an array item by item', () => {
    expect(parseAllowedTools(['Read', ' Bash(git *) ', ''])).toEqual(['Read', 'Bash(git *)']);
    expect(parseAllowedTools([])).toEqual([]);
  });

  it('gives undefined, as an absent key does, for an empty string or a non-list', () => {
    expect(parseAllowedTools('')).toBeUndefined();
    expect(parseAllowedTools('  , ')).toBeUndefined();
    expect(parseAllowedTools(undefined)).toBeUndefined();
    expect(parseAllowedTools(3)).toBeUndefined();
  });
});
