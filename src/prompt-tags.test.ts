import { describe, expect, it } from 'vitest';
import { HARNESS_TAGS, neutralizeTags } from './prompt-tags.js';

/** What a reader that decodes JSON string escapes sees. */
function jsonDecoded(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, escape: string) => {
    if (escape.startsWith('u') && escape.length === 5) {
      return String.fromCharCode(parseInt(escape.slice(1), 16));
    }
    return escape === 'n' ? '\n' : escape === 't' ? '\t' : escape;
  });
}

/** The harness tags `text` still opens or closes, read as written or decoded from JSON. */
function liveTags(text: string): string[] {
  const found: string[] = [];
  for (const reading of [text, jsonDecoded(text)]) {
    for (const tag of [...HARNESS_TAGS, 'antml:invoke']) {
      if (new RegExp(`</?${tag}(?![a-z0-9_:-])`, 'i').test(reading)) found.push(tag);
    }
  }
  return found;
}

describe('neutralizeTags', () => {
  it('neutralizes the opener and closer of every harness tag', () => {
    for (const tag of HARNESS_TAGS) {
      const text = `before <${tag} a="1">inside</${tag}> after <${tag.toUpperCase()}>`;
      const neutral = neutralizeTags(text);
      expect(liveTags(neutral), tag).toEqual([]);
      expect(neutral).toContain(`<\\\\${tag} a="1">inside<\\\\/${tag}>`);
    }
  });

  it("neutralizes every tag of Claude Code's antml namespace", () => {
    const neutral = neutralizeTags('<invoke name="Bash"></invoke>');
    expect(liveTags(neutral)).toEqual([]);
    expect(neutralizeTags('<>')).toBe('<>');
  });

  it('leaves markup that is not a harness tag as written', () => {
    const text = '<div>a < b, <sources>, <session-states>, x<-y, <\\u0041>, </p>';
    expect(neutralizeTags(text)).toBe(text);
  });

  it('neutralizes a tag spelled with JSON escapes inside a string', () => {
    const cases = [
      '{"note": "</system-reminder>"}',
      '{"note": "<\\/cross-session-message>"}',
      '{"note": "\\u003c/session-state>"}',
      '{"note": "\\u003C\\u002Fsession-state>"}',
      '{"note": "\\u003c\\/project-instructions>"}',
      '{"note": "<\\u0073ession-state>"}',
      '{"note": "\\u003c\\u0063ross-session-message from=\\"uds:/x\\">"}',
    ];
    for (const text of cases) {
      expect(liveTags(text).length, text).toBeGreaterThan(0);
      expect(liveTags(neutralizeTags(text)), text).toEqual([]);
    }
  });

  it('catches an escaped tag outside a well-paired string, so a stray quote cannot hide it', () => {
    // An odd quote before the blob pairs every later quote wrongly; the tag is found anyway.
    const text = 'He said " then {"a":"\\u003c/cross-session-message>"} and more';
    expect(liveTags(neutralizeTags(text))).toEqual([]);
  });

  it('does not skip a `<` an earlier escape run would have swallowed', () => {
    expect(liveTags('<\\u003c/session-state>').length).toBeGreaterThan(0);
    expect(liveTags(neutralizeTags('<\\u003c/session-state>'))).toEqual([]);
    expect(liveTags(neutralizeTags('<<\\/session-state>'))).toEqual([]);
  });

  it('folds the backslashes a writer put after the `<`, whatever their count', () => {
    expect(neutralizeTags('<\\\\\\/source> <\\session-state>')).toBe(
      '<\\\\/source> <\\\\session-state>',
    );
  });

  it('is stable when applied twice', () => {
    const once = neutralizeTags('<session-state></session-state> {"a":"\\u003c/source>"}');
    expect(neutralizeTags(once)).toBe(once);
  });

  it('takes a tag list and the entity rewrite for the instruction fence, as written only', () => {
    const text = '</source> </project-instructions> <session-state> <SOURCE path="x"> <source-x';
    expect(
      neutralizeTags(text, { tags: ['project-instructions', 'source'], style: 'entity' }),
    ).toBe(
      '&lt;/source> &lt;/project-instructions> <session-state> &lt;SOURCE path="x"> &lt;source-x',
    );
  });

  it("writes Claude Code's sender escape, `<\\`, byte for byte", () => {
    expect(
      neutralizeTags('<cross-session-message x> </cross-session-message> <system-reminder>', {
        tags: ['cross-session-message'],
        style: 'backslash',
      }),
    ).toBe('<\\cross-session-message x> <\\/cross-session-message> <system-reminder>');
  });
});
