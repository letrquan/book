import { Bench } from 'tinybench';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import { marked, Tokens } from 'marked';
import { ThemeContext } from '../theme.js';
import { DEFAULT_THEME } from '../../types.js';
import { MarkdownBlock, wrapParagraphLines } from '../components/MarkdownBlock.js';
import { DiffBlock } from '../components/Diff.js';
import { ToolCallBlock } from '../components/ToolCallBlock.js';
import { wordWrap } from '../components/word-wrap.js';
import { toolSuccess } from '../../tools/result.js';

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
const largeToolOutput = Array.from({ length: 1000 }, (_, index) => `output line ${index + 1}`).join(
  '\n',
);
const multiHunkDiff = Array.from({ length: 120 }, (_, index) => [
  `@@ -${index * 3 + 1},2 +${index * 3 + 1},2 @@`,
  ` context ${index}`,
  `-const value = oldValue${index};`,
  `+const value = newValue${index};`,
])
  .flat()
  .join('\n');

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
  })
  .add('large tool output preview render', () => {
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ToolCallBlock
          name="Bash"
          args={{ command: 'large-output' }}
          result={toolSuccess(largeToolOutput, { toolCallId: 'bench-output' })}
          isExpanded
          terminalWidth={TERMINAL_WIDTH}
          reducedMotion
        />
      </ThemeContext.Provider>,
    );
    sink += view.lastFrame()?.length ?? 0;
    view.unmount();
    cleanup();
  })
  .add('multi-hunk diff preview render', () => {
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <DiffBlock
          output={multiHunkDiff}
          filePath="src/benchmark.ts"
          collapsed
          terminalWidth={TERMINAL_WIDTH}
        />
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

// Responsive wrapping now performs display-width-aware Unicode measurement, so
// markdown lexing is no longer the dominant cost in this synthetic ASCII case.
// Timing varies by machine; fail only on a material same-process regression.
if (optimizedMean >= legacyMean * 1.1) {
  console.error('Expected optimized paragraph wrapping to stay within 10% of legacy parsing.');
  process.exitCode = 1;
}

// Prevent the benchmarked work from being optimized away in overly aggressive runtimes.
if (sink === Number.MIN_SAFE_INTEGER) {
  console.log('unreachable', sink);
}
