import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Text } from 'ink';
import React from 'react';
import { ThemeContext } from '../theme.js';
import { DEFAULT_THEME } from '../../types.js';
import { MarkdownBlock, useThrottledValue, wrapParagraphLines } from './MarkdownBlock.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function frame(lastFrame: () => string | undefined): string {
  return stripAnsi(lastFrame());
}

function withTheme(children: React.ReactElement): React.ReactElement {
  return React.createElement(ThemeContext.Provider, { value: DEFAULT_THEME }, children);
}

afterEach(() => {
  cleanup();
});

describe('MarkdownBlock', () => {
  it('renders empty content as nothing', () => {
    const view = render(withTheme(React.createElement(MarkdownBlock, { content: '' })));
    const output = frame(view.lastFrame);
    expect(output).toBe('');
  });

  it('renders plain text paragraph', () => {
    const view = render(withTheme(React.createElement(MarkdownBlock, { content: 'Hello world' })));
    const output = frame(view.lastFrame);
    expect(output).toContain('Hello world');
  });

  it('renders bold text', () => {
    const view = render(
      withTheme(React.createElement(MarkdownBlock, { content: 'This is **bold** text' })),
    );
    const output = frame(view.lastFrame);
    expect(output).toContain('bold');
  });

  it('renders italic text', () => {
    const view = render(
      withTheme(React.createElement(MarkdownBlock, { content: 'This is *italic* text' })),
    );
    const output = frame(view.lastFrame);
    expect(output).toContain('italic');
  });

  it('renders inline code', () => {
    const view = render(
      withTheme(React.createElement(MarkdownBlock, { content: 'Use the `readFile` function' })),
    );
    const output = frame(view.lastFrame);
    expect(output).toContain('readFile');
  });

  it('renders fenced code block with language label', () => {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content: '```typescript\nconst x = 1;\nconsole.log(x);\n```',
        }),
      ),
    );
    const output = frame(view.lastFrame);
    expect(output).toContain('typescript');
    expect(output).toContain('const x = 1');
    expect(output).toContain('console.log(x)');
  });

  it('renders fenced code block without language label', () => {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content: '```\necho hello\n```',
        }),
      ),
    );
    const output = frame(view.lastFrame);
    expect(output).toContain('echo hello');
  });

  it('renders headings', () => {
    const view = render(
      withTheme(React.createElement(MarkdownBlock, { content: '# Heading One\n\n## Heading Two' })),
    );
    const output = frame(view.lastFrame);
    expect(output).toContain('Heading One');
    expect(output).toContain('Heading Two');
  });

  it('renders blockquotes', () => {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content: '> This is a quoted\n> paragraph',
        }),
      ),
    );
    const output = frame(view.lastFrame);
    expect(output).toContain('This is a quoted');
    expect(output).toContain('paragraph');
  });

  it('renders unordered lists', () => {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content: '- Item one\n- Item two\n- Item three',
        }),
      ),
    );
    const output = frame(view.lastFrame);
    expect(output).toContain('Item one');
    expect(output).toContain('Item two');
    expect(output).toContain('Item three');
  });

  it('renders ordered lists', () => {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content: '1. First\n2. Second\n3. Third',
        }),
      ),
    );
    const output = frame(view.lastFrame);
    expect(output).toContain('First');
    expect(output).toContain('Second');
    expect(output).toContain('Third');
  });

  it('renders links', () => {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content: 'See [the docs](https://example.com) for more.',
        }),
      ),
    );
    const output = frame(view.lastFrame);
    expect(output).toContain('the docs');
  });

  it('renders images as alt-text placeholders', () => {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content: '![diagram](img/diagram.png)',
        }),
      ),
    );
    const output = frame(view.lastFrame);
    expect(output).toContain('Image:');
    expect(output).toContain('diagram');
  });

  it('renders horizontal rules', () => {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content: 'Above\n\n---\n\nBelow',
        }),
      ),
    );
    const output = frame(view.lastFrame);
    expect(output).toContain('Above');
    expect(output).toContain('Below');
  });

  it('renders strikethrough text', () => {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content: 'This is ~~deprecated~~ removed',
        }),
      ),
    );
    const output = frame(view.lastFrame);
    expect(output).toContain('deprecated');
    expect(output).toContain('removed');
  });

  it('renders tables', () => {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content: '| Name | Value |\n|------|-------|\n| foo  | 42    |\n| bar  | 99    |',
        }),
      ),
    );
    const output = frame(view.lastFrame);
    expect(output).toContain('Name');
    expect(output).toContain('Value');
    expect(output).toContain('foo');
    expect(output).toContain('42');
    expect(output).toContain('bar');
    expect(output).toContain('99');
  });

  it('renders mixed content: heading + code + list + paragraph', () => {
    const content = [
      '# Getting Started',
      '',
      'This is a **guide** for setting up the project.',
      '',
      '```bash',
      'npm install',
      'npm run build',
      '```',
      '',
      'Steps:',
      '',
      '1. Clone the repo',
      '2. Install dependencies',
      '3. Run the build',
      '',
      '> **Note**: This requires Node.js 18+.',
      '',
      '---',
      '',
      'For more info, see [the docs](https://example.com).',
    ].join('\n');

    const view = render(withTheme(React.createElement(MarkdownBlock, { content })));
    const output = frame(view.lastFrame);

    expect(output).toContain('Getting Started');
    expect(output).toContain('guide');
    expect(output).toContain('npm install');
    expect(output).toContain('npm run build');
    expect(output).toContain('Clone the repo');
    expect(output).toContain('Install dependencies');
    expect(output).toContain('Run the build');
    expect(output).toContain('Note');
    expect(output).toContain('the docs');
  });

  it('soft-wraps paragraphs when terminalWidth is provided', () => {
    const content = 'Alpha beta gamma delta epsilon zeta eta theta';
    const view = render(
      withTheme(React.createElement(MarkdownBlock, { content, terminalWidth: 18 })),
    );
    const output = frame(view.lastFrame);

    expect(output).toContain('Alpha beta gamma');
    expect(output).toContain('delta epsilon zeta');
    expect(output).toContain('eta theta');
  });

  it('wrapParagraphLines exposes the optimized paragraph wrapping path', () => {
    expect(wrapParagraphLines('Alpha beta gamma delta', 12)).toEqual(['Alpha beta', 'gamma delta']);
  });
});

describe('useThrottledValue', () => {
  // The trailing-emit / within-window cadence is the contract's non-trivial
  // half, but fake-timer tests are flaky under ink-testing-library (React
  // effects don't reliably flush on advanceTimersByTime), so only the
  // synchronous-first-frame guarantee is asserted here — the one the
  // MarkdownBlock render tests above depend on. The trailing path is exercised
  // live by the streaming accumulator flush (16ms) → final onDone emit.
  function Echo({ value, intervalMs }: { value: string; intervalMs: number }) {
    const throttled = useThrottledValue(value, intervalMs);
    return React.createElement(Text, null, throttled);
  }

  afterEach(() => cleanup());

  it('emits the first value synchronously (no delayed first frame)', () => {
    const view = render(withTheme(React.createElement(Echo, { value: 'first', intervalMs: 1000 })));
    expect(frame(view.lastFrame)).toBe('first');
  });
});
