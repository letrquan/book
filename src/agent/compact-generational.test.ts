import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCompact } from './compact.js';
import type { Message } from '../types/messages.js';
import type { FileObservation } from '../types/tools.js';
import { compactTestConfig } from '../test/compact-fixture.js';

vi.mock('../provider/index.js', () => ({
  chatCompletionStream: vi.fn(),
  createProvider: () => ({
    id: 'test',
    stream: (...args: unknown[]) =>
      vi.mocked(chatCompletionStream)(...(args as Parameters<typeof chatCompletionStream>)),
  }),
}));

import { chatCompletionStream } from '../provider/index.js';

const mockedStream = vi.mocked(chatCompletionStream);

/**
 * What the HOST keeps across repeated compactions.
 *
 * The summarizer double below is deliberately perfect: it carries its previous
 * summary forward and appends one line per generation. So anything that goes
 * missing here was lost by Book, not by a model -- to the tail, to the carried
 * turns' budget, or to the handoff of the previous summary.
 */

const GENERATIONS = 6;

/** Things the user says, one per generation, including a rule in Vietnamese and one with no cue word. */
const STATEMENTS = [
  'Never touch the vendored parser under third_party/parser.',
  'Đừng đụng vào thư mục vendor.',
  "It'd be good if we stayed on Node 20.",
  'Use pnpm, not npm.',
  'The staging region is eu-west-2 now.',
  'Keep the public API of query() stable.',
];

function observation(path: string, timestamp: number): FileObservation {
  return {
    path,
    workspaceId: 'w',
    sha256: `${path}-${timestamp}`.padEnd(64, '0'),
    byteSize: 1,
    operation: 'edit',
    sourceRef: `session://current/event/${timestamp}`,
    timestamp,
  };
}

/** One user turn, a large assistant step that edits a file, and a short reply. */
function generationTurns(generation: number): Message[] {
  return [
    {
      id: `u${generation}`,
      role: 'user',
      content: STATEMENTS[generation],
      includeInContext: true,
      timestamp: generation * 10,
    },
    {
      id: `a${generation}`,
      role: 'assistant',
      content: `work for generation ${generation} `.repeat(1_500),
      includeInContext: true,
      timestamp: generation * 10 + 1,
      fileObservations: [observation(`src/g${generation}.ts`, generation * 10 + 1)],
    },
    {
      id: `r${generation}`,
      role: 'assistant',
      content: `generation ${generation} done`,
      includeInContext: true,
      timestamp: generation * 10 + 2,
    },
  ];
}

describe('generational compaction', () => {
  beforeEach(() => {
    mockedStream.mockReset();
    let calls = 0;
    mockedStream.mockImplementation(async function* (_config, messages) {
      calls++;
      const prompt = String(messages.at(-1)!.content);
      const previous = /<previous-summary>\n([\s\S]*?)\n<\/previous-summary>/.exec(prompt)?.[1];
      yield {
        type: 'text',
        content: `${previous ? `${previous}\n` : '## Progress\n'}- summarized pass ${calls}`,
      };
      yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('advances the generation, hands the summary forward, and keeps every user statement verbatim', async () => {
    let history: Message[] = [];
    for (let generation = 0; generation < GENERATIONS; generation++) {
      history = [...history, ...generationTurns(generation)];
      const result = await runCompact(compactTestConfig(), history, { trigger: 'auto' });
      expect(result.status, `generation ${generation}`).toBe('compacted');
      if (result.status !== 'compacted') return;
      history = result.replacementHistory;

      expect(result.checkpoint.generation).toBe(generation + 1);
      // Each pass's line is still there: nothing the summarizer carried was dropped by the host.
      for (let pass = 1; pass <= generation + 1; pass++) {
        expect(result.checkpoint.state.summary).toContain(`- summarized pass ${pass}`);
      }
      const visible = history
        .map((message) => message.contextContent ?? message.content)
        .join('\n');
      for (const statement of STATEMENTS.slice(0, generation + 1)) {
        expect(visible, `generation ${generation}: ${statement}`).toContain(statement);
      }
      const checkpoint = history.find((message) => message.kind === 'checkpoint')!;
      expect(checkpoint.content).not.toContain('"version"');
      expect(history.filter((message) => message.kind === 'checkpoint')).toHaveLength(1);
      expect(result.degraded).toBe(false);
    }
    const last = history.find((message) => message.kind === 'checkpoint')!.checkpointData!;
    // Files accumulate across generations, newest first, from the tools' records.
    expect(last.files.map((file) => file.path).slice(0, 2)).toEqual(['src/g5.ts', 'src/g4.ts']);
    expect(last.files.map((file) => file.path)).toContain('src/g0.ts');
  });
});
