import { Bench } from 'tinybench';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import { marked, Tokens } from 'marked';
import { ThemeContext } from '../theme.js';
import { DEFAULT_THEME } from '../../types.js';
import { MarkdownBlock, wrapParagraphLines } from '../components/MarkdownBlock.js';
import { wordWrap } from '../components/word-wrap.js';

const TERMINAL_WIDTH = 80;
let sink = 0;

function makeParagraph(wordCount: number): string {
  const words = [
    'streaming',
    'assistant',
    'markdown',
    'rendering',
    'performance',
    'terminal',
    'wrapping',
    'benchmark',
    'content',
    'latency',
  ];
  return Array.from({ length: wordCount }, (_, i) => words[i % words.length]).join(' ');
}

function makeMarkdown(): string {
  const paragraph = makeParagraph(220);
  return [
    '# UI benchmark sample',
    '',
    paragraph,
    '',
    '- Keep streaming smooth',
    '- Avoid extra markdown parsing',
    '- Preserve terminal-friendly wrapping',
    '',
    '```ts',
    'const value = wrapParagraphLines(input, 80);',
    'console.log(value.length);',
    '```',
    '',
    paragraph,
  ].join('\n');
}

function legacyWrappedParagraph(rawText: string, terminalWidth: number): string[] {
  const wrapped = wordWrap(rawText, terminalWidth);
  const tokens = marked.lexer(wrapped);
  const lines: string[] = [];
  for (const token of tokens) {
    if (token.type === 'paragraph') {
      const paragraph = token as Tokens.Paragraph;
      lines.push(paragraph.tokens.map((inline) => ('text' in inline ? inline.text : '')).join(''));
    }
  }
  return lines;
}

function getMeanMs(bench: Bench, name: string): number {
  const task = bench.getTask(name);
  const mean = (task?.result as { latency?: { mean?: number } } | undefined)?.latency?.mean;
  if (typeof mean !== 'number') {
    throw new Error(`Benchmark task did not complete: ${name}`);
  }
  return mean;
}

const paragraph = makeParagraph(700);
const markdown = makeMarkdown();

const bench = new Bench({ time: 500, warmupTime: 100, warmupIterations: 16 });

bench
  .add('legacy wrap + marked.lexer', () => {
    sink += legacyWrappedParagraph(paragraph, TERMINAL_WIDTH).length;
  })
  .add('optimized wrapParagraphLines', () => {
    sink += wrapParagraphLines(paragraph, TERMINAL_WIDTH).length;
  })
  .add('MarkdownBlock render sample', () => {
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <MarkdownBlock content={markdown} terminalWidth={TERMINAL_WIDTH} />
      </ThemeContext.Provider>,
    );
    sink += view.lastFrame()?.length ?? 0;
    view.unmount();
    cleanup();
  });

await bench.run();

console.table(bench.table());

const legacyMean = getMeanMs(bench, 'legacy wrap + marked.lexer');
const optimizedMean = getMeanMs(bench, 'optimized wrapParagraphLines');
const speedup = legacyMean / optimizedMean;

console.log(
  `Optimized paragraph wrapping is ${speedup.toFixed(2)}x faster ` +
    `(legacy ${legacyMean.toFixed(4)}ms, optimized ${optimizedMean.toFixed(4)}ms).`,
);

// Timing varies by machine; require a same-process relative win without encoding
// an absolute latency threshold into the benchmark.
if (optimizedMean >= legacyMean * 0.99) {
  console.error('Expected optimized paragraph wrapping to be faster than legacy parsing.');
  process.exitCode = 1;
}

// Prevent the benchmarked work from being optimized away in overly aggressive runtimes.
if (sink === Number.MIN_SAFE_INTEGER) {
  console.log('unreachable', sink);
}
