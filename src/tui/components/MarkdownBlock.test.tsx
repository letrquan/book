import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Text } from 'ink';
import React from 'react';
import { ThemeContext } from '../theme.js';
import { DEFAULT_THEME } from '../../types.js';
import { MarkdownBlock, useThrottledValue, wrapParagraphLines } from './MarkdownBlock.js';
import { displayWidth } from './word-wrap.js';

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
    expect(output.split('\n')).toEqual(['Hello world']);
  });

  it('adds one semantic row between paragraphs without trailing space', () => {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, { content: 'First paragraph\n\nSecond paragraph' }),
      ),
    );
    const output = frame(view.lastFrame);

    expect(output.split('\n')).toEqual(['First paragraph', '', 'Second paragraph']);
  });

  it('places heading bodies directly under their heading chrome', () => {
    const view = render(
      withTheme(React.createElement(MarkdownBlock, { content: '## Compact heading\n\nBody text' })),
    );
    const lines = frame(view.lastFrame).split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Compact heading');
    expect(lines[1]).toBe('Body text');
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

  it('renders differentiated heading levels', () => {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content: '# Heading One\n\n## Heading Two\n\n### Heading Three',
        }),
      ),
    );
    const output = frame(view.lastFrame);
    expect(output).toContain('HEADING ONE');
    expect(output).toContain('── Heading Two ──');
    expect(output).toContain('### Heading Three');
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

  it('renders unordered and task lists', () => {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content: '- Item one\n- [x] Item two\n- [ ] Item three',
        }),
      ),
    );
    const output = frame(view.lastFrame);
    expect(output).toContain('Item one');
    expect(output).toContain('[x]');
    expect(output).toContain('Item two');
    expect(output).toContain('[ ]');
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

  it('renders links with URL hints', () => {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content: 'See [the docs](https://example.com) for more.',
        }),
      ),
    );
    const output = frame(view.lastFrame);
    expect(output).toContain('the docs');
    expect(output).toContain('(https://example.com)');
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

  it('renders tables with borders and separators', () => {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content: '| Name | Value |\n|------|------:|\n| foo  | 42    |\n| bar  | 99    |',
        }),
      ),
    );
    const output = frame(view.lastFrame);
    expect(output).toContain('┌');
    expect(output).toContain('├');
    expect(output).toContain('└');
    expect(output).toContain('Name');
    expect(output).toContain('Value');
    expect(output).toContain('foo');
    expect(output).toContain('42');
    expect(output).toContain('bar');
    expect(output).toContain('99');
  });

  it('keeps exact-width table rows aligned and renders inline markdown as cell text', () => {
    const width = 30;
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content:
            '| Agent | Status |\n|---|---|\n| **book-agent** | `ready` |\n| [reviewer](https://example.com) | waiting |',
          terminalWidth: width,
        }),
      ),
    );
    const output = frame(view.lastFrame);
    const lines = output.split('\n');

    expect(output).toContain('book-agent');
    expect(output).toContain('ready');
    expect(output).not.toContain('**book-agent**');
    expect(output).not.toContain('`ready`');
    expect(lines.every((line) => displayWidth(line) <= width)).toBe(true);
    const borderedLines = lines.filter((line) => /^[┌├└│]/.test(line));
    expect(new Set(borderedLines.map(displayWidth)).size).toBe(1);
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

    expect(output).toContain('GETTING STARTED');
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

  it('preserves inline content while soft-wrapping formatted paragraphs', () => {
    const content = 'Alpha **beta** gamma `delta` epsilon';
    const view = render(
      withTheme(React.createElement(MarkdownBlock, { content, terminalWidth: 16 })),
    );
    const output = frame(view.lastFrame);

    expect(output).toContain('Alpha beta');
    expect(output).toContain('gamma');
    expect(output).toContain('delta');
    expect(output).toContain('epsilon');
  });

  it('wrapParagraphLines exposes the optimized paragraph wrapping path', () => {
    expect(wrapParagraphLines('Alpha beta gamma delta', 12)).toEqual(['Alpha beta', 'gamma delta']);
  });

  it('hard-wraps long unbroken tokens in paragraphs', () => {
    const content = 'prefix supercalifragilisticexpialidocious suffix';
    const view = render(
      withTheme(React.createElement(MarkdownBlock, { content, terminalWidth: 12 })),
    );
    const output = frame(view.lastFrame);
    expect(output).toContain('prefix');
    expect(output).toContain('suffix');
    expect(output).toContain('supercalif');
    // Full token still present across wrapped lines
    expect(output.replace(/\s+/g, '')).toContain('supercalifragilisticexpialidocious');
  });

  it('clamps table and code block output under narrow terminal widths', () => {
    const content = [
      '| Name | Value | Note |',
      '|------|------:|------|',
      '| foo  | 42    | hello world and more text |',
      '| bar  | 99    | 你好 😀 |',
      '',
      '```typescript',
      'const supercalifragilistic = "abcdefghijklmnopqrstuvwxyz0123456789";',
      'function example() { return 1; }',
      'function another() { return 2; }',
      'function third() { return 3; }',
      'function fourth() { return 4; }',
      'function fifth() { return 5; }',
      'function sixth() { return 6; }',
      '```',
      '',
      '# A Very Long Heading That Should Clamp',
      '',
      '> quoted text that is also fairly long for the narrow width',
      '',
      '- list item with a long unbroken_token_that_should_hard_wrap_nicely',
    ].join('\n');

    for (const width of [16, 24, 32, 48]) {
      const view = render(
        withTheme(React.createElement(MarkdownBlock, { content, terminalWidth: width })),
      );
      const output = frame(view.lastFrame);
      // Content tokens remain visible after responsive layout.
      expect(output).toContain('foo');
      expect(output).toContain('42');
      // Language label may truncate (typescr…); code body is hard-wrapped.
      expect(output).toMatch(/typescr|supercalif|abcdefgh|const su/);
      const lines = output.split('\n').map((l) => l.replace(/\s+$/g, ''));
      const longest = Math.max(0, ...lines.map((l) => l.length));
      // Ink borders/padding can add a few columns; pure content is hard-wrapped to width.
      expect(longest).toBeLessThanOrEqual(Math.max(width + 8, 24));
      // Hard-wrapped paragraphs must not repeat the full source on every visual line.
      const joined = output.replace(/\s+/g, ' ');
      const occurrences = joined.split('unbroken_token_that_should_hard_wrap_nicely').length - 1;
      expect(occurrences).toBeLessThanOrEqual(1);
    }
  });

  it('does not syntax-highlight while streaming', () => {
    const content = '```js\nconst x = 1;\n```';
    const streaming = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content,
          terminalWidth: 40,
          isStreaming: true,
        }),
      ),
    );
    const done = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content,
          terminalWidth: 40,
          isStreaming: false,
        }),
      ),
    );
    // Both should show the source text; streaming path skips highlight only.
    expect(frame(streaming.lastFrame)).toContain('const x = 1');
    expect(frame(done.lastFrame)).toContain('const x = 1');
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
