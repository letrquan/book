import { describe, expect, it } from 'vitest';
import { frontMatterClose, markdownContentStart, parseFrontmatter } from './frontmatter.js';

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

describe('parseFrontmatter', () => {
  it('closes the block on the shared delimiter rule', () => {
    expect(parseFrontmatter('---\nname: x\n...\nbody')).toEqual({
      body: 'body',
      frontmatter: { name: 'x' },
    });
    expect(parseFrontmatter('---\nname: y\n---  \nbody')).toEqual({
      body: 'body',
      frontmatter: { name: 'y' },
    });
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
});
