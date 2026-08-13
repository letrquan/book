// Temporary profiling harness for the two failing bench:ui scenarios.
// Run: node --import tsx src/tui/__benchmarks__/profile-focus.tsx <streaming|trace> [profile.cpuprofile]
// Profiles ONLY the rerender loop (not mount/compile) via the inspector API.
// Not part of the benchmark suite; delete when the investigation ends.
import { Session } from 'node:inspector';
import { writeFileSync } from 'node:fs';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import { ThemeContext } from '../theme.js';
import { DEFAULT_THEME } from '../../types/theme.js';
import { ChatPanel } from '../components/ChatPanel.js';
import type { Message } from '../../types/messages.js';
import type { ManagedAgentTrace } from '../managed-agent-transcript.js';

const TERMINAL_WIDTH = 80;

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

function makeRichStreamingMarkdown(): string {
  return Array.from({ length: 20 }, (_, index) => [
    `## Streaming section ${index + 1}`,
    '',
    `${makeParagraph(55)} **bold detail** and \`inlineCode\`.`,
    '',
    '- Preserve a responsive streaming tail',
    '- Apply full Markdown decoration after completion',
  ])
    .flat()
    .join('\n');
}

const streamingTranscript: Message[] = [
  ...Array.from({ length: 999 }, (_, index) => ({
    id: `stream-history-${index}`,
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `${index % 2 === 0 ? 'Question' : 'Answer'} ${index}`,
    includeInContext: true,
    timestamp: index,
  })),
  {
    id: 'stream-active',
    role: 'assistant' as const,
    content: makeRichStreamingMarkdown(),
    includeInContext: true,
    timestamp: 1_000,
  },
];

const scenario = process.argv[2] ?? 'streaming';
const profileOut = process.argv[3];

function startProfiler(session: Session): Promise<void> {
  return new Promise((resolve, reject) => {
    session.post('Profiler.enable', (err) => {
      if (err) return reject(err);
      session.post('Profiler.start', (startErr) => (startErr ? reject(startErr) : resolve()));
    });
  });
}

function stopProfiler(session: Session): Promise<object> {
  return new Promise((resolve, reject) => {
    session.post('Profiler.stop', (err, result) =>
      err ? reject(err) : resolve(result.profile as object),
    );
  });
}

function reportSamples(label: string, samples: number[]): void {
  const sorted = [...samples].sort((left, right) => left - right);
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  console.log(
    `${label}: mean ${mean.toFixed(2)}ms, p95 ${p95.toFixed(2)}ms (${sorted.length} iterations)`,
  );
}

const session = new Session();
session.connect();
const samples: number[] = [];

if (scenario === 'streaming') {
  const view = render(
    <ThemeContext.Provider value={DEFAULT_THEME}>
      <ChatPanel
        messages={streamingTranscript}
        streamingMessageId="stream-active"
        reducedMotion
        terminalWidth={TERMINAL_WIDTH}
        terminalHeight={40}
      />
    </ThemeContext.Provider>,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  let activeContent = streamingTranscript[streamingTranscript.length - 1].content;
  await startProfiler(session);
  for (let index = 0; index < 100; index++) {
    activeContent += 'x'.repeat(20);
    const next = streamingTranscript.slice();
    next[next.length - 1] = { ...next[next.length - 1], content: activeContent };
    const startedAt = performance.now();
    view.rerender(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ChatPanel
          messages={next}
          streamingMessageId="stream-active"
          reducedMotion
          terminalWidth={TERMINAL_WIDTH}
          terminalHeight={40}
        />
      </ThemeContext.Provider>,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    samples.push(performance.now() - startedAt);
  }
  const profile = await stopProfiler(session);
  if (profileOut) writeFileSync(profileOut, JSON.stringify(profile));
  view.unmount();
  cleanup();
} else {
  const view = render(
    <ThemeContext.Provider value={DEFAULT_THEME}>
      <ChatPanel
        messages={streamingTranscript}
        managedAgentTraces={new Map<string, ManagedAgentTrace>()}
        reducedMotion
        terminalWidth={TERMINAL_WIDTH}
        terminalHeight={40}
      />
    </ThemeContext.Provider>,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  await startProfiler(session);
  for (let index = 0; index < 60; index++) {
    const startedAt = performance.now();
    view.rerender(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ChatPanel
          messages={streamingTranscript}
          managedAgentTraces={new Map<string, ManagedAgentTrace>()}
          reducedMotion
          terminalWidth={TERMINAL_WIDTH}
          terminalHeight={40}
        />
      </ThemeContext.Provider>,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    samples.push(performance.now() - startedAt);
  }
  const profile = await stopProfiler(session);
  if (profileOut) writeFileSync(profileOut, JSON.stringify(profile));
  view.unmount();
  cleanup();
}
session.disconnect();
reportSamples(`${scenario} rerender (NODE_ENV=${process.env.NODE_ENV ?? 'undefined'})`, samples);
