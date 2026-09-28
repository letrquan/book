import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHeadless } from './headless.js';
import { createRegistry } from './tools/registry.js';
import { toolSuccess } from './tools/result.js';
import { defaultConfig } from './test/fixtures.js';
import type { HeadlessResult } from './types/public-sdk.js';

/**
 * `book -p --output-format stream-json` into a reader that has gone (#340).
 *
 * A closed pipe is only noticed on a write, and the notice arrives after the
 * write returns. So when the reader left during a turn the model spent silent,
 * the run used to write that turn's `tool_use` records into it, execute the
 * calls it had already paid for, and only then find out. These tests hold the
 * run at the tool boundary instead.
 */
let tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-reader-gone-'));
  tempDirs.push(dir);
  return dir;
}

function sse(chunks: string[]): Response {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function textDelta(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

/**
 * One tool call in a turn. `index` is the wire's own slot for it, so a turn
 * with two calls needs two of these: the same index twice is one call, with
 * both argument fragments merged into it.
 */
function toolDelta(id: string, name: string, args: Record<string, unknown>, index = 0): string {
  return `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [{ index, id, function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  })}\n\n`;
}

/** A stream that recorded what it was given, one entry per write. */
interface Sink {
  stream: Writable;
  lines: string[];
  dispose: () => void;
}

/**
 * A real `Writable`, because the whole contract is about the error a write's
 * callback reports: a host that hands `runHeadless` a plain `{ write }` object
 * has no callback to carry it.
 */
function createSink(
  options: {
    /** Fail every write with EPIPE once the first turn's answer has arrived. */
    closeAfterFirstTurn?: boolean;
    /**
     * Fail every write with EPIPE once this many `tool_use` records have been
     * written: the reader took a whole batch's announcements and then left,
     * while the first call of it is still running.
     */
    closeAfterToolUse?: number;
    /**
     * Deliver the failing callback on `process.nextTick`, as a pipe write that
     * fails synchronously does on Linux: the write returns before the callback
     * arrives, so anything checking the run's signal in between sees it healthy.
     */
    failOnNextTick?: boolean;
    /** The code a failed write reports; EPIPE is what a closed pipe gives. */
    failureCode?: string;
    /** Hold each write's callback open this long — a reader that is slow, not gone. */
    callbackDelayMs?: number;
    /** Never call the callback at all — a writer that cannot be waited on. */
    swallowCallback?: boolean;
  } = {},
): Sink {
  const lines: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let readerGone = false;
  let toolUseRecords = 0;
  const gone = (callback: (error?: Error | null) => void): void => {
    const error = Object.assign(new Error(`write ${options.failureCode ?? 'EPIPE'}`), {
      code: options.failureCode ?? 'EPIPE',
    });
    if (options.failOnNextTick) {
      process.nextTick(() => callback(error));
      return;
    }
    callback(error);
  };
  const stream = new Writable({
    write(chunk: unknown, _encoding, callback) {
      if (readerGone) {
        gone(callback);
        return;
      }
      const line = String(chunk);
      lines.push(line);
      if (!readerGone) {
        try {
          const event = JSON.parse(line) as { type?: string; complete?: boolean };
          // The reader takes everything through the first answer and then goes,
          // so this line is the last one it gets.
          if (
            options.closeAfterFirstTurn &&
            event.type === 'assistant' &&
            event.complete === true
          ) {
            readerGone = true;
          }
          // Or through a whole batch's announcements, which leaves it closing
          // while the batch's first call is still running.
          if (event.type === 'tool_use') {
            toolUseRecords++;
            if (toolUseRecords >= (options.closeAfterToolUse ?? Number.POSITIVE_INFINITY)) {
              readerGone = true;
            }
          }
        } catch {
          // A line that is not a record is none of this sink's business.
        }
      }
      if (options.swallowCallback) return;
      if (!options.callbackDelayMs) {
        callback();
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback();
      }, options.callbackDelayMs);
      timers.add(timer);
    },
  });
  // A failed write destroys the stream, and an `error` nobody listens for is an
  // uncaught exception. `process.stdout` has a handler in `cli/run.ts`; this is
  // its stand-in, and it is also what a real host's stream does.
  stream.on('error', () => {});
  return {
    stream,
    lines,
    dispose: () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      stream.destroy();
    },
  };
}

/**
 * A tool that records its own execution synchronously, before it yields: work
 * that is already done by the time an asynchronous abort lands, and that no
 * later result takes back.
 */
function markerRegistry(runs: string[]) {
  const registry = createRegistry();
  registry.register({
    name: 'Mark',
    description: 'Record that it ran',
    parameters: { type: 'object', properties: { label: { type: 'string' } } },
    execute: (args) => {
      runs.push(String(args.label ?? ''));
      return Promise.resolve(toolSuccess('marked'));
    },
  });
  return registry;
}

/** One run of the three-turn script below. */
interface ScriptedRun {
  fetchCalls: number;
  ran: string[];
  lines: string[];
  result: HeadlessResult;
  elapsedMs: number;
}

/**
 * Turn 1 talks and calls the marker, turn 2 does the same, turn 3 answers. A
 * reader that left after turn 1 makes turn 2 the one nothing is reading: its
 * request was served and answered, but every record it produced went into a
 * closed pipe.
 */
async function runScript(options: {
  sink?: Sink;
  stdout?: { write: (line: string) => boolean };
  outputFormat?: 'text' | 'json' | 'stream-json';
  prompt?: string;
  /** Shared between two runs that are compared: the workspace is in the record. */
  workspace?: string;
  /** How many of the script's turns call the marker; every one is a tool batch. */
  toolCallTurns?: number;
  /** Serial calls in the first turn — a batch the reader can leave in the middle of. */
  serialBatch?: boolean;
}): Promise<ScriptedRun> {
  const fetchCalls = { count: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      fetchCalls.count++;
      if (fetchCalls.count === 1) {
        const second = options.serialBatch
          ? toolDelta('mark-2', 'Mark', { label: 'second' }, 1)
          : '';
        return sse([
          textDelta('Working on it.'),
          toolDelta('mark-1', 'Mark', { label: 'first' }),
          second,
        ]);
      }
      if (fetchCalls.count === 2 && (options.toolCallTurns ?? 2) > 1) {
        return sse([textDelta('Almost.'), toolDelta('mark-2', 'Mark', { label: 'second' })]);
      }
      return sse([textDelta('Marked.')]);
    }),
  );
  const ran: string[] = [];
  const startedAt = Date.now();
  const result = await runHeadless(
    defaultConfig({
      baseUrl: 'http://localhost/v1',
      workspace: options.workspace ?? makeWorkspace(),
    }),
    markerRegistry(ran),
    {
      prompt: options.prompt ?? 'do the thing',
      inputFormat: 'text',
      outputFormat: options.outputFormat ?? 'stream-json',
      history: [],
      mode: 'bypassPermissions',
      maxTurns: 3,
      stdout: options.sink ? options.sink.stream : options.stdout,
    },
  );
  return {
    fetchCalls: fetchCalls.count,
    ran,
    lines: options.sink ? options.sink.lines : [],
    result,
    elapsedMs: Date.now() - startedAt,
  };
}

/** Everything that legitimately differs between two runs of the same script. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A clock reading or a measured span: the same run, and a different number. */
function isPerRunNumber(key: string): boolean {
  return (
    key === 'timestamp' || key.endsWith('At') || key.endsWith('_at') || key.startsWith('duration')
  );
}

function normalize(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name, item]) => [
        name,
        normalize(item, name),
      ]),
    );
  }
  if (typeof value === 'string' && UUID.test(value)) return '<uuid>';
  if (typeof value === 'number' && isPerRunNumber(key)) return 0;
  return value;
}

const eventsOf = (lines: string[]) => lines.map((line) => JSON.parse(line) as unknown);

describe('runHeadless — stream-json reader goes away', () => {
  it('does not execute the calls whose announcement the reader never took', async () => {
    const sink = createSink({ closeAfterFirstTurn: true });
    try {
      const run = await runScript({ sink });

      // The call the reader was there for ran. The next turn's request was
      // already paid for, and the work it announced was not: nobody is left to
      // read the result.
      expect(run.ran).toEqual(['first']);
      // A third request would be another one bought for a reader that is gone.
      expect(run.fetchCalls).toBe(2);
      expect(run.result.outcome).toEqual({
        status: 'cancelled',
        reason: 'caller_cancelled',
        partialOutput: true,
      });
    } finally {
      sink.dispose();
    }
  });

  it('writes the same records for a healthy reader as for a sink with no callback', async () => {
    const workspace = makeWorkspace();
    const sink = createSink();
    let streamed: ScriptedRun;
    try {
      streamed = await runScript({ sink, workspace });
    } finally {
      sink.dispose();
    }
    const plainWrites: string[] = [];
    const plain = await runScript({
      workspace,
      stdout: { write: (line) => (plainWrites.push(line), true) },
    });

    expect(streamed.ran).toEqual(['first', 'second']);
    expect(streamed.fetchCalls).toBe(3);
    expect(streamed.result.outcome).toMatchObject({ status: 'completed' });
    expect(plain.ran).toEqual(['first', 'second']);
    expect(normalize(eventsOf(plainWrites))).toEqual(normalize(eventsOf(sink.lines)));
  });

  it('does not start the next serial call of a batch after the reader leaves mid-batch', async () => {
    // The reader took both of the batch's announcements and went while the
    // first call was still running. That call's own `tool_result` is the write
    // that fails, and on a real pipe it fails synchronously while the callback
    // arrives on the next tick — so the next call's own abort check runs in
    // between, and the hold in front of that call is the only thing that can
    // stop it.
    const sink = createSink({ closeAfterToolUse: 2, failOnNextTick: true });
    try {
      const run = await runScript({ sink, serialBatch: true });

      expect(run.ran).toEqual(['first']);
      expect(run.fetchCalls).toBe(1);
      expect(run.result.outcome).toEqual({
        status: 'cancelled',
        reason: 'caller_cancelled',
        partialOutput: true,
      });
      // Nothing after the announcements reached the reader — not the first
      // call's result, and not the second call's anything.
      expect(run.lines.filter((line) => line.includes('"tool_result"'))).toEqual([]);
      expect(run.lines.filter((line) => line.includes('"tool_use"')).length).toBe(2);
    } finally {
      sink.dispose();
    }
  });

  it('runs every call of a healthy serial batch', async () => {
    const sink = createSink();
    try {
      const run = await runScript({ sink, serialBatch: true, toolCallTurns: 1 });
      expect(run.ran).toEqual(['first', 'second']);
      expect(run.result.outcome).toMatchObject({ status: 'completed' });
    } finally {
      sink.dispose();
    }
  });

  it('waits the cap for a slow reader, then stops waiting at the next boundary', async () => {
    const sink = createSink({ callbackDelayMs: 3000 });
    try {
      // One tool batch, so the run's whole wait for a writer that would not
      // answer is the one cap — and the run cannot have finished only because
      // the script happened to end.
      const run = await runScript({ sink, toolCallTurns: 1 });

      // It waited, gave the writer up, and went on: this reader is slow, not gone.
      expect(run.ran).toEqual(['first']);
      expect(run.result.outcome).toMatchObject({ status: 'completed' });
      expect(run.elapsedMs).toBeGreaterThanOrEqual(900);
      expect(run.elapsedMs).toBeLessThan(3000);
    } finally {
      sink.dispose();
    }
  });

  it('cancels cleanly on the other codes a closed far end arrives with', async () => {
    for (const failureCode of ['EOF', 'ECONNRESET', 'ERR_STREAM_DESTROYED']) {
      const sink = createSink({ closeAfterFirstTurn: true, failureCode });
      try {
        const run = await runScript({ sink });
        expect(run.ran).toEqual(['first']);
        expect(run.result.outcome).toMatchObject({
          status: 'cancelled',
          reason: 'caller_cancelled',
        });
      } finally {
        sink.dispose();
      }
    }
  });

  it('never waits on a writer in text or json output', async () => {
    for (const outputFormat of ['text', 'json'] as const) {
      const sink = createSink({ swallowCallback: true });
      try {
        const run = await runScript({ sink, outputFormat, prompt: 'say hi' });
        expect(run.result.outcome).toMatchObject({
          status: 'completed',
          reason: 'normal_completion',
        });
      } finally {
        sink.dispose();
      }
    }
  });
});
