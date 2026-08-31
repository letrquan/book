import { describe, expect, it } from 'vitest';
import { marked, type Token } from 'marked';
import { inlineCode } from './markdown-inline.js';

/**
 * Tokenize the way `MarkdownBlock` does and flatten to leaves, so a test can
 * assert what the transcript row actually renders rather than what the string
 * looks like.
 */
function leafTokens(markdown: string): Token[] {
  const flatten = (tokens: Token[]): Token[] =>
    tokens.flatMap((token) => {
      const nested = (token as Token & { tokens?: Token[] }).tokens;
      return nested?.length ? flatten(nested) : [token];
    });
  return flatten(marked.lexer(markdown).filter((token) => token.type !== 'space'));
}

/** The completion row `app.tsx` builds, minus the parts that are real prose. */
function completionRow(command: string): string {
  return `✓ Background shell ${inlineCode(command)} exited (exit 0).`;
}

function renderedText(markdown: string): string {
  return leafTokens(markdown)
    .map((token) => (token as Token & { text?: string }).text ?? '')
    .join('');
}

describe('inlineCode', () => {
  it('keeps asterisks a prose renderer would eat as emphasis', () => {
    const command = 'node -e "setInterval(()=>{},1000)/*KILLPROBE*/"';

    // The bug: interpolated as prose, `*...*` is emphasis and both asterisks go.
    expect(renderedText(`✓ Background shell ${command} exited (exit 0).`)).not.toContain(
      '/*KILLPROBE*/',
    );

    const tokens = leafTokens(completionRow(command));
    const spans = tokens.filter((token) => token.type === 'codespan');
    expect(spans).toHaveLength(1);
    expect((spans[0] as Token & { text: string }).text).toBe(command);
    expect(renderedText(completionRow(command))).toBe(
      `✓ Background shell ${command} exited (exit 0).`,
    );
  });

  it.each([
    ['glob', 'rm -rf build/*'],
    ['literal asterisk grep', "grep -n '\*' src/*.ts"],
    ['heading character', 'sed -i "s/# old/# new/" notes.md'],
    ['link syntax', 'echo "[label](href)" > out.txt'],
    ['underscores', 'python -m my_module --flag_name value'],
    ['strikethrough', 'echo ~~not-struck~~'],
    ['backticks', 'echo `date`'],
    ['double backticks', 'echo ``weird``'],
    ['leading backtick', '`date`'],
    ['trailing space', 'npm run build '],
    ['leading space', ' npm run build'],
    ['tab', 'echo\tone'],
  ])('renders %s verbatim', (_label, command) => {
    const spans = leafTokens(completionRow(command)).filter((token) => token.type === 'codespan');
    expect(spans).toHaveLength(1);
    expect((spans[0] as Token & { text: string }).text).toBe(command);
  });

  it('flattens line breaks so the fence stays inside one paragraph', () => {
    // A `#` opening an embedded line would otherwise start an ATX heading,
    // splitting the paragraph and leaving the opening backtick unclosed.
    const command = 'cat <<EOF > notes.md\n# heading\nEOF';

    const spans = leafTokens(completionRow(command)).filter((token) => token.type === 'codespan');
    expect(spans).toHaveLength(1);
    expect((spans[0] as Token & { text: string }).text).toBe('cat <<EOF > notes.md # heading EOF');
    expect(renderedText(completionRow(command))).not.toContain('`');
  });

  it('normalizes every line ending the same way', () => {
    expect(inlineCode('a\r\nb')).toBe(inlineCode('a b'));
    expect(inlineCode('a\rb')).toBe(inlineCode('a b'));
    expect(inlineCode('a\nb')).toBe(inlineCode('a b'));
  });

  it('emits nothing rather than a stray fence for empty text', () => {
    expect(inlineCode('')).toBe('');
    expect(inlineCode('   ')).toBe('');
    expect(inlineCode('\n')).toBe('');
  });
});
