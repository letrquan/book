import { describe, expect, it } from 'vitest';
import { findRelaxedMatch } from './fuzzy-match.js';

async function apply(
  content: string,
  oldString: string,
  newString: string,
): Promise<string | null> {
  const outcome = await findRelaxedMatch(content, oldString, newString);
  if (outcome.status !== 'found') return null;
  const { start, end, replacement } = outcome.match;
  return content.slice(0, start) + replacement + content.slice(end);
}

describe('findRelaxedMatch', () => {
  it('tolerates trailing whitespace differences', async () => {
    const content = 'const a = 1;  \nconst b = 2;\t\nconst c = 3;';
    const outcome = await findRelaxedMatch(
      content,
      'const a = 1;\nconst b = 2;',
      'const merged = 3;',
    );
    expect(outcome.status).toBe('found');
    if (outcome.status !== 'found') return;
    expect(outcome.match.rung).toBe('trailing-whitespace');
    await expect(apply(content, 'const a = 1;\nconst b = 2;', 'const merged = 3;')).resolves.toBe(
      'const merged = 3;\nconst c = 3;',
    );
  });

  it('matches a uniformly deeper-indented block and re-indents the replacement', async () => {
    const content = 'function outer() {\n        if (x) {\n            work();\n        }\n}';
    const oldString = 'if (x) {\n    work();\n}';
    const newString = 'if (x && y) {\n    workHarder();\n}';
    const outcome = await findRelaxedMatch(content, oldString, newString);
    expect(outcome.status).toBe('found');
    if (outcome.status !== 'found') return;
    expect(outcome.match.rung).toBe('indent-shift');
    await expect(apply(content, oldString, newString)).resolves.toBe(
      'function outer() {\n        if (x && y) {\n            workHarder();\n        }\n}',
    );
  });

  it('matches a shallower-indented block by stripping the uniform prefix', async () => {
    const content = 'if (x) {\n  work();\n}';
    const oldString = '    if (x) {\n      work();\n    }';
    const newString = '    if (y) {\n      rest();\n    }';
    const outcome = await findRelaxedMatch(content, oldString, newString);
    expect(outcome.status).toBe('found');
    if (outcome.status !== 'found') return;
    expect(outcome.match.rung).toBe('indent-shift');
    await expect(apply(content, oldString, newString)).resolves.toBe('if (y) {\n  rest();\n}');
  });

  it('rejects a remove-shift whose replacement cannot be shifted consistently', async () => {
    const content = 'if (x) {\n  work();\n}';
    const oldString = '    if (x) {\n      work();\n    }';
    // Closing brace is shallower than the 4-space remove prefix: a partial
    // shift would emit mixed indentation, so the match must be rejected.
    const newString = '    if (y) {\n      rest();\n  }';
    await expect(findRelaxedMatch(content, oldString, newString)).resolves.toMatchObject({
      status: 'not_found',
    });
  });

  it('leaves blank lines unindented when shifting the replacement', async () => {
    const content = '    first();\n    second();';
    const oldString = 'first();\nsecond();';
    const newString = 'first();\n\nsecond();';
    await expect(apply(content, oldString, newString)).resolves.toBe(
      '    first();\n\n    second();',
    );
  });

  it('reports ambiguity instead of guessing between equal candidates', async () => {
    const content = '  work();\n\n  work();';
    await expect(findRelaxedMatch(content, 'work();', 'rest();')).resolves.toMatchObject({
      status: 'ambiguous',
      count: 2,
    });
  });

  it('does not match mid-line fragments', async () => {
    const content = 'const value = compute(input);';
    await expect(
      findRelaxedMatch(content, 'compute(input)', 'compute(other)'),
    ).resolves.toMatchObject({ status: 'not_found' });
  });

  it('rejects whitespace-only oldString', async () => {
    await expect(findRelaxedMatch('a\n\nb', '\n', 'x')).resolves.toMatchObject({
      status: 'not_found',
    });
  });

  it('requires the whole block to share one uniform shift', async () => {
    const content = '    first();\n  second();';
    await expect(findRelaxedMatch(content, 'first();\nsecond();', 'x')).resolves.toMatchObject({
      status: 'not_found',
    });
  });

  it('treats blank oldString lines as matching whitespace-only file lines', async () => {
    const content = '  a();\n   \n  b();';
    const outcome = await findRelaxedMatch(content, 'a();\n\nb();', 'c();');
    expect(outcome.status).toBe('found');
    if (outcome.status !== 'found') return;
    await expect(apply(content, 'a();\n\nb();', 'c();')).resolves.toBe('  c();');
  });

  it('aborts through the signal on large scans', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    const bigContent = 'line();\n'.repeat(5000);
    await expect(
      findRelaxedMatch(bigContent, 'needle();\nother();', 'x', controller.signal),
    ).rejects.toThrow('stopped');
  });
});
