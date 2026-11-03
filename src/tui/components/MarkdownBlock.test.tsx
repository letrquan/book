import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Text } from 'ink';
import chalk from 'chalk';
import React from 'react';
import { marked } from 'marked';
import { ThemeContext } from '../theme.js';
import { DEFAULT_THEME } from '../../types/theme.js';
import {
  MarkdownBlock,
  expandRunTabs,
  streamingMarkdownWindow,
  useThrottledValue,
  wrapParagraphLines,
} from './MarkdownBlock.js';
import { expandTabs } from '../../cli/ink-frame-clip.js';
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

function numberedWords(count: number): string {
  return Array.from({ length: count }, (_, index) => `word${index}`).join(' ');
}

function tailOf(window: string): string {
  const banner = '… earlier response hidden while streaming\n\n';
  return window.startsWith(banner) ? window.slice(banner.length) : window;
}

/**
 * Where in `content` a live tail's own text starts, looking past a fence opening line the tail
 * re-adds for a cutoff inside code. `undefined` for an empty tail.
 */
function tailStartOffset(content: string, tail: string): number | undefined {
  if (tail === '') return undefined;
  if (content.endsWith(tail)) return content.length - tail.length;
  const body = tail.slice(tail.indexOf('\n') + 1);
  return content.endsWith(body) ? content.length - body.length : undefined;
}

const MARKER_WORDS = ['-', '+', '#', '3.', '2)', '2019.', '##'];

function markerProse(count: number): string {
  return Array.from({ length: count }, (_, index) =>
    index % 3 === 2 ? MARKER_WORDS[index % MARKER_WORDS.length] : `word${index}`,
  ).join(' ');
}

afterEach(() => {
  cleanup();
});

describe('MarkdownBlock', () => {
  it('bounds the live streaming tail while preserving the complete final content', () => {
    const content = `prefix-marker ${'x'.repeat(8_000)} suffix-marker`;
    const streaming = streamingMarkdownWindow(content, 80);

    expect(streaming).toContain('earlier response hidden while streaming');
    expect(streaming).not.toContain('prefix-marker');
    expect(streaming).toContain('suffix-marker');
  });

  it('preserves fenced-code context when the live tail crosses its cutoff', () => {
    const content = [
      '```typescript',
      'const prefix = 1;',
      'x'.repeat(900),
      'const suffix = 2;',
      '```',
    ].join('\n');
    const streaming = streamingMarkdownWindow(content, 20);

    expect(streaming).toContain('```typescript\n');
    expect(streaming).not.toContain('const prefix = 1');
    expect(streaming).toContain('const suffix = 2');
  });

  it('skips a truncated table and resumes at the next complete block', () => {
    const rows = Array.from({ length: 80 }, (_, index) => `| row ${index} | value ${index} |`);
    const content = [
      '| Name | Value |',
      '| --- | --- |',
      ...rows,
      '',
      '## Complete tail block',
      '',
      'Tail content',
    ].join('\n');
    const streaming = streamingMarkdownWindow(content, 20);

    expect(streaming).not.toContain('| row 79 |');
    expect(streaming).toContain('## Complete tail block');
    expect(streaming).toContain('Tail content');
  });

  it('does not expose an incomplete table when no safe block follows the cutoff', () => {
    const content = [
      '| Name | Value |',
      '| --- | --- |',
      ...Array.from({ length: 80 }, (_, index) => `| row ${index} | value ${index} |`),
    ].join('\n');
    const streaming = streamingMarkdownWindow(content, 20);

    expect(streaming).toContain('earlier response hidden while streaming');
    expect(streaming).not.toContain('| row');
  });

  it('keeps the live tail start fixed while a long paragraph streams', () => {
    const full = numberedWords(1500);
    // width 80 => maxCharacters = 1920, step = 320
    let jumps = 0;
    let pairs = 0;
    let previous = tailOf(streamingMarkdownWindow(full.slice(0, 3000), 80));
    for (let length = 3012; length <= full.length; length += 12) {
      const next = tailOf(streamingMarkdownWindow(full.slice(0, length), 80));
      pairs++;
      if (!next.startsWith(previous)) jumps++;
      previous = next;
    }

    expect(jumps).toBeLessThanOrEqual(Math.ceil((full.length - 3000) / 320) + 1);
    expect(pairs).toBeGreaterThan(jumps * 10);
  });

  it('starts the fallback tail at a word boundary', () => {
    const content = numberedWords(1500);
    for (let length = 3000; length <= content.length; length += 7) {
      const tail = tailOf(streamingMarkdownWindow(content.slice(0, length), 80));
      expect(tail).toMatch(/^word\d+/);
    }
  });

  it('keeps the live tail within the character budget', () => {
    const full = numberedWords(1500);
    for (let length = 1921; length <= full.length; length += 13) {
      expect(tailOf(streamingMarkdownWindow(full.slice(0, length), 80)).length).toBeLessThanOrEqual(
        1920,
      );
    }
  });

  it('does not snap the cutoff back over inline markdown near the start', () => {
    // Rounding the cutoff down would snap it to 0 here and put the markup in the tail, which
    // blanks the live view; rounding up starts past it.
    const content = `Use \`code\` and snake_case first. ${numberedWords(270)}`;
    expect(content.length).toBeGreaterThan(1920);
    expect(content.length - 1920).toBeLessThan(320);

    expect(tailOf(streamingMarkdownWindow(content, 80))).toMatch(/^word\d+/);
  });

  it('falls back to the rounded cutoff when no word starts within a step', () => {
    const content = `start ${'x'.repeat(8_000)}`;
    const rounded = Math.ceil((content.length - 1920) / 320) * 320;

    expect(tailOf(streamingMarkdownWindow(content, 80))).toBe(content.slice(rounded));
  });

  it('never starts the prose tail on a heading, list or quote marker', () => {
    const full = markerProse(1200);
    for (let length = 1921; length <= full.length; length += 7) {
      const tail = tailOf(streamingMarkdownWindow(full.slice(0, length), 80));
      expect(marked.lexer(tail)[0]?.type).toBe('paragraph');
    }
  });

  it('keeps the live tail within the character budget when marker words are skipped', () => {
    const full = markerProse(1500);
    for (let length = 1921; length <= full.length; length += 13) {
      expect(tailOf(streamingMarkdownWindow(full.slice(0, length), 80)).length).toBeLessThanOrEqual(
        1920,
      );
    }
  });

  it('keeps a paragraph break found from the raw cutoff', () => {
    const content = `${'a '.repeat(125)}\n\n${'b '.repeat(925)}\n\nxy`;
    const tail = tailOf(streamingMarkdownWindow(content, 80));

    expect(tail.startsWith('b b ')).toBe(true);
    expect(tail.endsWith('xy')).toBe(true);
  });

  it('starts a code block tail at the raw cutoff', () => {
    const content = `\`\`\`ts\n${Array.from({ length: 200 }, (_, index) => `const value${index} = ${index};`).join('\n')}`;
    const rawCutoff = content.length - 1920;
    expect(rawCutoff % 320).not.toBe(0);

    expect(tailOf(streamingMarkdownWindow(content, 80))).toBe(
      `\`\`\`ts\n${content.slice(rawCutoff)}`,
    );
  });

  it('opens the tail with the fence line when the cutoff lands inside it', () => {
    // width 80 => maxCharacters = 1920
    const head = `${numberedWords(120)}\n`;
    const code = Array.from({ length: 120 }, (_, index) => `const value${index} = ${index};`);
    const full = `${head}\`\`\`ts\n${code.join('\n')}`;

    // Every cutoff from the first backtick to the newline that ends the line.
    for (let offset = 0; offset <= '```ts'.length; offset++) {
      const length = head.length + offset + 1920;
      const tail = tailOf(streamingMarkdownWindow(full.slice(0, length), 80));
      expect(tail).toBe(full.slice(head.length, length));
      expect(marked.lexer(tail)[0]?.type).toBe('code');
    }
  });

  it('never moves the live tail start back across a fence that follows the cutoff (#268)', () => {
    // width 80 => maxCharacters = 1920. The fence opens on the line after a paragraph, with no
    // blank line between them, and a blank line only after it closes.
    const code = Array.from({ length: 12 }, (_, index) => `const value${index} = ${index};`);
    const full = `${numberedWords(500)}\n\`\`\`ts\n${code.join('\n')}\n\`\`\`\n\n${numberedWords(500)}`;
    let previous = -1;
    let frames = 0;
    for (let length = 1921; length <= full.length; length += 5) {
      const content = full.slice(0, length);
      const start = tailStartOffset(content, tailOf(streamingMarkdownWindow(content, 80)));
      if (start === undefined) continue;
      frames++;
      expect(start, `tail start at length ${length}`).toBeGreaterThanOrEqual(previous);
      previous = start;
    }
    expect(frames).toBeGreaterThan(100);
  });

  it('shows the whole fenced block, not what follows it, once the cutoff nears it (#268)', () => {
    const code = Array.from({ length: 12 }, (_, index) => `const value${index} = ${index};`);
    const head = `${numberedWords(500)}\n`;
    const full = `${head}\`\`\`ts\n${code.join('\n')}\n\`\`\`\n\n${numberedWords(500)}`;
    // A cutoff in the paragraph just before the fence line.
    const length = head.length - 40 + 1920;
    const tail = tailOf(streamingMarkdownWindow(full.slice(0, length), 80));

    expect(tail.startsWith('```ts\nconst value0 = 0;')).toBe(true);
    expect(marked.lexer(tail)[0]?.type).toBe('code');
  });

  it('starts the tail after a closing fence line the cutoff lands inside', () => {
    const code = Array.from({ length: 40 }, (_, index) => `const value${index} = ${index};`);
    const head = `\`\`\`ts\n${code.join('\n')}\n`;
    const full = `${head}\`\`\`\n${numberedWords(400)}`;

    for (let offset = 0; offset <= '```'.length; offset++) {
      const tail = tailOf(streamingMarkdownWindow(full.slice(0, head.length + offset + 1920), 80));
      expect(marked.lexer(tail)[0]?.type).toBe('paragraph');
      expect(tail).toMatch(/^word\d+ /);
    }
  });

  // The dash thematic breaks the prose fallback skips. `*` and `_` rules need no entry: the
  // fallback drops any tail that holds either character.
  it.each(['---', '-- -', '- - -', '-----', '---   '])(
    'never starts the prose tail on the thematic break %j',
    (rule) => {
      // width 80 => maxCharacters = 1920, step = 320: a 2100-character response puts the raw
      // cutoff at 180 and the rounded one at 320, where the rule starts.
      const lead = 'a '.repeat(160).slice(0, 319);
      const content = `${lead} ${rule}\n${numberedWords(400)}`.slice(0, 2100);

      const tail = tailOf(streamingMarkdownWindow(content, 80));

      expect(marked.lexer(tail)[0]?.type).toBe('paragraph');
      expect(tail).toMatch(/^word0 /);
    },
  );

  it('keeps a dash word that does not end its line at the start of the prose tail', () => {
    const lead = 'a '.repeat(160).slice(0, 319);
    const content = `${lead} --- and more\n${numberedWords(400)}`.slice(0, 2100);

    expect(tailOf(streamingMarkdownWindow(content, 80))).toBe(content.slice(320));
  });

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

  it('keeps a closing paragraph off a list that a link definition follows', () => {
    // A link definition draws nothing, so the paragraph after it must take the
    // gap from the block the reader actually saw above it.
    const view = render(
      withTheme(React.createElement(MarkdownBlock, { content: '- a\n- b\n\n[ref]: /u\n\nDone.' })),
    );
    const lines = frame(view.lastFrame).split('\n');

    expect(lines).toEqual(['  • a', '  • b', '', 'Done.']);
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

  it('marks inline code with colour only, never a background', () => {
    // A background pill behind every span turned a normal paragraph into a
    // row of highlighted badges. The code colour is the whole signal.
    const level = chalk.level;
    chalk.level = 3;
    try {
      const view = render(
        withTheme(React.createElement(MarkdownBlock, { content: 'Use the `readFile` function' })),
      );
      const raw = view.lastFrame() ?? '';
      expect(stripAnsi(raw)).toContain('readFile');
      expect(raw).not.toMatch(/\x1b\[48;/);
      // The span still carries the theme's inline-code colour.
      const [r, g, b] = [1, 3, 5].map((i) =>
        parseInt(DEFAULT_THEME.mdInlineCodeText.slice(i, i + 2), 16),
      );
      expect(raw).toContain(`\x1b[38;2;${r};${g};${b}mreadFile`);
    } finally {
      chalk.level = level;
    }
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
    // Depth is carried by weight and brightness, so the author's text is
    // rendered verbatim: no upper-casing, no rules, no leading hashes.
    expect(output).toContain('Heading One');
    expect(output).toContain('Heading Two');
    expect(output).toContain('Heading Three');
    expect(output).not.toContain('HEADING ONE');
    expect(output).not.toContain('──');
    expect(output).not.toContain('###');
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

  it('rules tables above, under the header, and below, with no vertical lines', () => {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content: '| Name | Value |\n|------|------:|\n| foo  | 42    |\n| bar  | 99    |',
        }),
      ),
    );
    const output = frame(view.lastFrame);
    const lines = output.split('\n');
    expect(lines.filter((line) => /^━+$/.test(line))).toHaveLength(2);
    expect(lines.filter((line) => /^─+$/.test(line))).toHaveLength(1);
    expect(output).not.toMatch(/[│┌├└]/);
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
    // Every rule spans the same width, so the columns sit inside them.
    const rules = lines.filter((line) => /^[━─]+$/.test(line));
    expect(rules).toHaveLength(3);
    expect(new Set(rules.map(displayWidth)).size).toBe(1);
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

  it('keeps Markdown structure visible while streaming', () => {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content: '# Live heading\n\n- first item\n- second item',
          terminalWidth: 40,
          isStreaming: true,
        }),
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('Live heading');
    expect(output).toContain('first item');
    expect(output).not.toContain('# Live heading');
  });

  it('renders the complete content immediately when streaming finishes', () => {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content: 'partial response',
          terminalWidth: 40,
          isStreaming: true,
        }),
      ),
    );

    view.rerender(
      withTheme(
        React.createElement(MarkdownBlock, {
          content: 'final response with complete content',
          terminalWidth: 40,
          isStreaming: false,
        }),
      ),
    );

    expect(frame(view.lastFrame)).toContain('final response with complete content');
  });
});

describe('MarkdownBlock code block with tabs (#547)', () => {
  const WIDTH = 73;
  const RECIPE = 'gcc -o program main.c util.c parser.c lexer.c codegen.c optimize.c -lm';
  const CONTENT = `Here is the Makefile:\n\n\`\`\`make\nall:\n\t${RECIPE}\n\tstrip program END\n\`\`\`\n\nThat is it. DONE`;

  /** The rows as the terminal draws them: each tab moved to the next 8-column stop from column 0. */
  function terminalRows(output: string): string[] {
    return output.split('\n').map((row) => expandTabs(row, displayWidth));
  }

  function nonBlank(value: string): string {
    return value.replace(/\s+/g, '');
  }

  it.each([
    ['settled', false],
    ['streaming', true],
  ])('measures a tab-led code line as the terminal does when %s', (_name, isStreaming) => {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content: CONTENT,
          terminalWidth: WIDTH,
          isStreaming,
        }),
      ),
    );
    const output = frame(view.lastFrame);

    // A tab left in a row is one the terminal expands past the width Ink laid the row out in.
    expect(output).not.toContain('\t');
    for (const row of terminalRows(output)) {
      expect(displayWidth(row)).toBeLessThanOrEqual(WIDTH);
    }
    // Nothing is lost: the recipe's characters are all there, in order, across its wrapped rows.
    const kept = nonBlank(
      output
        .split('\n')
        .map((row) => row.replace(/^[│\s]+/, ''))
        .join(''),
    );
    expect(kept).toContain(nonBlank(RECIPE));
    expect(kept).toContain(nonBlank('strip program END'));
    expect(output).toContain('DONE');
  });
});

describe('MarkdownBlock prose with tabs (#565)', () => {
  const WIDTH = 73;
  const CONTENT = [
    'Here is the data:',
    '',
    'name\tvalue\tunit\tcomment on the measured quantity which keeps going ENDA',
    '',
    '- item\tone\ttwo\tthree four five six seven eight nine ten eleven ENDB',
    '',
    '| name\tx | note |',
    '| --- | --- |',
    '| a\tb | cell\tENDC |',
    '',
    'span `x\ty\tz ENDD` end. DONE',
  ].join('\n');

  function terminalRows(output: string): string[] {
    return output.split('\n').map((row) => expandTabs(row, displayWidth));
  }

  it.each([
    ['settled', false],
    ['streaming', true],
  ])('measures a tab in a paragraph, list item, table cell and code span when %s', (_n, stream) => {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, {
          content: CONTENT,
          terminalWidth: WIDTH,
          isStreaming: stream,
        }),
      ),
    );
    const output = frame(view.lastFrame);
    expect(output).not.toContain('\t');
    for (const row of terminalRows(output)) {
      expect(displayWidth(row)).toBeLessThanOrEqual(WIDTH);
    }
    const flat = output.replace(/\s+/g, '');
    for (const word of ['going', 'ENDA', 'eleven', 'ENDB', 'ENDC', 'ENDD', 'DONE']) {
      expect(flat).toContain(word);
    }
  });

  it('never carries a row past the width with a tab run at the edge', () => {
    for (let lead = 60; lead < 74; lead++) {
      const content = `${'a'.repeat(lead)}\tnext word here`;
      const view = render(
        withTheme(React.createElement(MarkdownBlock, { content, terminalWidth: WIDTH })),
      );
      const output = frame(view.lastFrame);
      for (const row of output.split('\n')) {
        expect(displayWidth(row), `lead ${lead}`).toBeLessThanOrEqual(WIDTH);
      }
      expect(output.replace(/\s+/g, '')).toContain('nextwordhere');
    }
  });

  it('keeps a tab-aligned paragraph on tab stops from the start of the text', () => {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, { content: 'ab\tcd\tef', terminalWidth: WIDTH }),
      ),
    );
    expect(frame(view.lastFrame).trimEnd()).toBe('ab      cd      ef');
  });
});

describe('MarkdownBlock prose with tabs and no width (#578)', () => {
  it.each([
    // A list item's text starts after its marker, in column 4 (#605): `ab` ends in column 6, so
    // its first tab takes two cells to the stop at 8 rather than six.
    ['a paragraph', 'ab\tcd\tef', 'ab      cd      ef'],
    ['a list item', '- ab\tcd\tef', 'ab  cd      ef'],
  ])('draws no raw tab in %s', (_name, content, row) => {
    const view = render(withTheme(React.createElement(MarkdownBlock, { content })));
    const output = frame(view.lastFrame);
    expect(output).not.toContain('\t');
    expect(output).toContain(row);
  });
});

describe('expandRunTabs (#605)', () => {
  const run = (text: string, bold?: boolean) => ({ text, bold });
  const joined = (runs: Array<{ text: string }>) => runs.map((r) => r.text).join('');

  it('stops at the 8-column stops, counted from the column the text starts at', () => {
    expect(expandRunTabs([run('ab\tcd')])).toEqual([run('ab      cd')]);
    expect(expandRunTabs([run('ab\tcd')], 4)).toEqual([run('ab  cd')]);
    expect(expandRunTabs([run('\tx')], 4)).toEqual([run('    x')]);
    expect(expandRunTabs([run('\tx')], 8)).toEqual([run(`${' '.repeat(8)}x`)]);
  });

  it('carries the column across styled runs and restarts it at the start after a line break', () => {
    const runs = [run('ab', true), run('\t'), run('cd', true), run('\nx\ty')];
    expect(expandRunTabs(runs, 4).map((r) => r.text)).toEqual(['ab', '  ', 'cd', '\nx   y']);
  });

  it('keeps each run its own style, and returns a run without a tab as it was', () => {
    const plain = run('plain', true);
    const [kept, expanded] = expandRunTabs([plain, run('\tz', false)]);
    expect(kept).toBe(plain);
    expect(expanded).toEqual(run('   z', false));
    const none = [run('no tab', true)];
    expect(expandRunTabs(none)).toBe(none);
  });

  it('measures each character of a line once, however many styled runs it has', () => {
    // 3000 runs of one line, a tab in every thousandth. Measuring the line so far for every run
    // (as it did) takes millions of characters; the line's own length is a few thousand.
    const runs = Array.from({ length: 3000 }, (_, i) =>
      run(i % 1000 === 999 ? '\t' : 'ab', i % 2 === 0),
    );
    let measured = 0;
    const measure = (text: string) => {
      measured += text.length;
      return displayWidth(text);
    };

    const expanded = expandRunTabs(runs, 0, measure);

    expect(joined(expanded)).toBe(expandTabs(joined(runs), displayWidth));
    expect(expanded.map((r) => r.bold)).toEqual(runs.map((r) => r.bold));
    expect(measured).toBeLessThanOrEqual(3 * joined(expanded).length);
  });
});

describe('MarkdownBlock list items with tabs start after their marker (#605)', () => {
  const WIDTH = 73;

  function rows(content: string, width: number | undefined = WIDTH): string[] {
    const view = render(
      withTheme(
        React.createElement(MarkdownBlock, width ? { content, terminalWidth: width } : { content }),
      ),
    );
    return frame(view.lastFrame).split('\n');
  }

  it.each([
    ['with a width', WIDTH],
    ['without one', undefined],
  ])('puts a bullet item on the stops a terminal would, %s', (_name, width) => {
    // The marker is in column 2, the text from column 4: `cd` lands on the stop at 8, `ef` on 16.
    const [row] = rows('- ab\tcd\tef', width);
    expect(row).toBe('  \u2022 ab  cd      ef');
    expect(row!.indexOf('cd')).toBe(8);
    expect(row!.indexOf('ef')).toBe(16);
  });

  it('counts the wider marker of a numbered list, and of a task item', () => {
    expect(rows('1. a\tb\tc')[0]).toBe('  1. a  b       c');
    expect(rows('- [ ] a\tb')[0]).toBe('  [ ] a b');
    // One marker column for the whole list: item 1 is as far in as item 10.
    const ten = rows(Array.from({ length: 10 }, (_, i) => `${i + 1}. a${i}\tb`).join('\n'));
    expect(new Set(ten.map((row) => row.indexOf('b'))).size).toBe(1);
    expect(ten[0]!.indexOf('b')).toBe(16);
  });

  it('counts the lists an item is nested in', () => {
    const [outer, inner, last] = rows('- outer\n  - in\ttab\n- second\tx');
    expect(outer).toBe('  \u2022 outer');
    // The inner marker is in column 8 and its text in column 10: `tab` is on the stop at 16.
    expect(inner).toBe('        \u2022 in    tab');
    expect(inner!.indexOf('tab')).toBe(16);
    expect(last!.indexOf('x')).toBe(16);
    const deep = rows('- one\n  - two\n    - three\tx')[2]!;
    expect(deep.indexOf('x')).toBe(24);
  });

  it('measures a paragraph of a loose item from the item text, not from the marker', () => {
    const lines = rows('- a\n\n  para\tb\n\n- d\te');
    expect(lines.find((row) => row.includes('para'))!.indexOf('b')).toBe(16);
    expect(lines.find((row) => row.includes('d '))!.indexOf('e')).toBe(8);
  });

  it('leaves a paragraph, and text in a blockquote, counted from their own left edge', () => {
    expect(rows('ab\tcd\tef')[0]).toBe('ab      cd      ef');
    // After the rail, as a code block's text is.
    expect(rows('> ab\tcd\tef')[0]).toBe('\u2502 ab      cd      ef');
    expect(rows('- item\n\n  > ab\tcd')[1]).toBe('    \u2502 ab      cd');
  });
});

describe('useThrottledValue', () => {
  // The trailing-emit / within-window cadence is the contract's non-trivial
  // half, but fake-timer tests are flaky under ink-testing-library (React
  // effects don't reliably flush on advanceTimersByTime), so only the
  // synchronous-first-frame guarantee is asserted here — the one the
  // MarkdownBlock render tests above depend on. The trailing path is exercised
  // live by the streaming accumulator flush (32ms) → final onDone emit.
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
