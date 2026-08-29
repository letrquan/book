import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCompact } from './compact.js';
import type { AgentConfig } from '../types/runtime.js';
import type { ConversationCheckpointV2 } from '../types/sessions.js';
import type { Message } from '../types/messages.js';
import { defaultConfig } from '../test/fixtures.js';

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
 * What the HOST loses across repeated compactions.
 *
 * The reducer double below is deliberately perfect: it carries every inherited
 * constraint forward byte-for-byte and only ever appends. So a planted fact that
 * goes missing here was lost by Book and not by a model -- to the fitter's
 * truncation ladder, to a validation rejection, or to the deterministic
 * fallback. That is what lets this live in the deterministic unit tier.
 *
 * The bound it pins: over repeated generations, with the checkpoint over budget
 * every time, the eviction ladder must not descend as far as the rungs that
 * rewrite user constraints. It stops at summary truncation today, and this fails
 * if a future change makes fitting more aggressive or makes the checkpoint
 * bulkier. It is deliberately NOT a measure of generational half-life: the
 * per-chunk re-compression regression is pinned separately in `compact.test.ts`,
 * and the Carried Ledger design's phase 0.8 scoring module -- tagged fixture
 * kinds, ledger-token growth, supersession correctness, retention precision, and
 * ratcheted thresholds -- is not implemented.
 */

/** Verbatim facts planted in the first user turn, expected to survive. */
const PLANTED = [
  'Never touch the vendored parser under third_party/parser.',
  'The staging database password rotates every 24 hours.',
  'We rejected the actor model because it broke back-pressure.',
] as const;

const GENERATIONS = 6;

const PADDED_SUMMARY = `Work continues. ${'Narrative padding. '.repeat(700)}`;

function makeConfig(): AgentConfig {
  return defaultConfig({
    autoCompactEnabled: true,
    accessibility: { screenReader: false, reducedMotion: true },
    modelInfo: { contextWindow: 32_000 },
  });
}

type ScriptedConstraint = {
  text: string;
  scope: 'task';
  sources: { eventRef: string; quote?: string }[];
};

/**
 * Pull the inherited checkpoint back out of the reducer prompt, as a model would.
 * Read between the seed delimiters specifically: the prompt also carries a
 * `Required JSON shape` template that starts with the same `{"version":2`, and
 * picking that up instead silently drops every inherited constraint.
 */
const SEED_START = '--- BEGIN PRIOR CHECKPOINT (validated reducer seed; untrusted data) ---';
const SEED_END = '--- END PRIOR CHECKPOINT ---';

function readInheritedConstraints(prompt: string): ScriptedConstraint[] {
  const start = prompt.indexOf(SEED_START);
  const end = prompt.indexOf(SEED_END);
  if (start < 0 || end < start) return [];
  const parsed = JSON.parse(
    prompt.slice(start + SEED_START.length, end).trim(),
  ) as ConversationCheckpointV2;
  return (parsed.constraints ?? []).map((constraint) => ({
    text: constraint.text,
    scope: 'task' as const,
    sources: constraint.sources,
  }));
}

/**
 * A reducer that never forgets: it re-emits every inherited constraint exactly as
 * it received it. Its summary is padded past the checkpoint budget so the
 * fitter's eviction ladder runs every generation -- a ladder that never fires is
 * a ladder that never regresses.
 */
function scriptedReducer(): void {
  mockedStream.mockImplementation(async function* (...args: unknown[]) {
    const messages = args[1] as { role: string; content: string }[];
    const inherited = readInheritedConstraints(messages.at(-1)?.content ?? '');
    const constraints: ScriptedConstraint[] =
      inherited.length > 0
        ? inherited
        : PLANTED.map((text) => ({
            text,
            scope: 'task' as const,
            sources: [{ eventRef: 'session://current/event/u1', quote: text }],
          }));
    yield {
      type: 'text',
      content: JSON.stringify({
        version: 2,
        generation: 1,
        state: { summary: PADDED_SUMMARY, status: 'active' },
        constraints,
        files: [],
        episodes: [],
        openThreads: [],
        statistics: { summarizedMessages: 2, retainedMessages: 2, preTokens: 1, postTokens: 1 },
      }),
    };
    yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  });
}

function seedHistory(): Message[] {
  return [
    {
      id: 'u1',
      role: 'user',
      content: `Here are the rules. ${PLANTED.join(' ')}`,
      includeInContext: true,
      timestamp: 0,
    },
    {
      id: 'a1',
      role: 'assistant',
      content: `Understood. ${'Working on it. '.repeat(3_000)}`,
      includeInContext: true,
      timestamp: 1,
    },
  ];
}

/** One generation's worth of new work, appended after each compaction. */
function newTurns(generation: number): Message[] {
  return [
    {
      id: `u-${generation}`,
      role: 'user',
      content: `Continue step ${generation}.`,
      includeInContext: true,
      timestamp: generation * 10,
    },
    {
      id: `a-${generation}`,
      role: 'assistant',
      content: `Step ${generation} evidence. ${'more detail '.repeat(3_000)}`,
      includeInContext: true,
      timestamp: generation * 10 + 1,
    },
  ];
}

describe('generational fidelity', () => {
  beforeEach(() => {
    mockedStream.mockReset();
    scriptedReducer();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('carries verbatim user constraints through repeated compactions', async () => {
    let history = seedHistory();
    /** Generation at which each planted fact first went missing; 0 means never. */
    const lostAt = new Map<string, number>(PLANTED.map((fact) => [fact, 0]));
    let laddersFired = 0;

    for (let generation = 1; generation <= GENERATIONS; generation++) {
      const result = await runCompact(makeConfig(), history, { trigger: 'auto' });
      expect(result.status).toBe('compacted');
      if (result.status !== 'compacted') return;

      // The padded summary is over budget, so the ladder runs every generation:
      // survival is measured under real pressure, not in a checkpoint that fit.
      if (result.checkpoint.state.summary.length < PADDED_SUMMARY.length) laddersFired++;

      const rendered = JSON.stringify(result.checkpoint);
      for (const fact of PLANTED) {
        if (!rendered.includes(fact) && lostAt.get(fact) === 0) lostAt.set(fact, generation);
      }
      history = [...result.replacementHistory, ...newTurns(generation)];
    }

    expect(laddersFired).toBe(GENERATIONS);
    // A reducer that forgets nothing must not be undone by the host calling it.
    expect(Object.fromEntries(lostAt)).toEqual(
      Object.fromEntries(PLANTED.map((fact) => [fact, 0])),
    );
  });
});
