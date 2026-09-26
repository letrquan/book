import { describe, expect, it } from 'vitest';
import { frontMatterClose, markdownContentStart } from './frontmatter.js';

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
  });

  it('keeps a heading that sits beside a prose label', () => {
    expect(
      markdownContentStart(['---', 'Author: Jane', '', '# Introduction', 'Summary: x', '---']),
    ).toBe(0);
    expect(markdownContentStart(['---', '# Release notes', 'Version: 1.2', '---'])).toBe(0);
  });
});
