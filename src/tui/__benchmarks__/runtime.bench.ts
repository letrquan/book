import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { performance } from 'perf_hooks';
import { RewindSnapshotStore } from '../../rewind/snapshot-store.js';
import { SessionStore } from '../../session/store.js';
import { fileTools } from '../../tools/file.js';
import { webTools } from '../../tools/web.js';
import { shellTools } from '../../tools/shell.js';
import { AgentContextCache, buildMessages } from '../../agent/context.js';
import { defaultConfig } from '../../test/fixtures.js';
import { createMessageAccumulator } from '../hooks/message-accumulator.js';
import { AgentStore } from '../../agents/store.js';
import type { AgentRecord } from '../../agents/types.js';
import type { Message } from '../../types/messages.js';
import type { BackgroundShellStore } from '../../types/runtime.js';

interface MetricsHint {
  bytesRead?: number;
  filesOpened?: number;
  childProcesses?: number;
}

interface Measurement extends MetricsHint {
  name: string;
  wallMs: number;
  cpuMs: number;
  peakHeapDeltaMb: number;
  retainedHeapDeltaMb: number;
}

const measurements: Measurement[] = [];
const scale = Math.max(1, Number.parseInt(process.env.BOOK_BENCH_SCALE ?? '1', 10) || 1);

async function measure(
  name: string,
  operation: () => void | Promise<void>,
  hint: MetricsHint = {},
): Promise<void> {
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  const startedAt = performance.now();
  let peakHeap = heapBefore;
  const sampler = setInterval(() => {
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }, 5);
  try {
    await operation();
  } finally {
    clearInterval(sampler);
  }
  const wallMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuBefore);
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  global.gc?.();
  measurements.push({
    name,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1_000,
    peakHeapDeltaMb: (peakHeap - heapBefore) / (1024 * 1024),
    retainedHeapDeltaMb: (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024),
    ...hint,
  });
}

function writeSessionFile(root: string, id: string, recordCount: number): number {
  const records = [
    JSON.stringify({
      type: 'session_meta',
      timestamp: 1,
      data: {
        kind: 'session_meta',
        id,
        cwd: root,
        createdAt: 1,
        updatedAt: recordCount,
        messageCount: recordCount,
      },
    }),
  ];
  for (let index = 0; index < recordCount; index++) {
    records.push(
      JSON.stringify({
        type: index % 2 === 0 ? 'user' : 'assistant',
        eventId: `${id}-${index}`,
        timestamp: index + 2,
        data: { content: `message ${index} searchable-token`, complete: true },
      }),
    );
  }
  const text = `${records.join('\n')}\n`;
  writeFileSync(join(root, `${id}.jsonl`), text);
  return Buffer.byteLength(text);
}

function writeIndexedSessions(root: string, count: number): void {
  const sessions: Record<string, unknown> = {};
  for (let index = 0; index < count; index++) {
    const id = `session-${index}`;
    const meta = {
      id,
      cwd: root,
      name: `Session ${index}`,
      createdAt: index,
      updatedAt: index,
      messageCount: 2,
    };
    sessions[id] = { meta, lastMessageRole: 'assistant', snapshotIds: [] };
    writeFileSync(
      join(root, `${id}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', timestamp: index, data: { kind: 'session_meta', ...meta } })}\n`,
    );
  }
  writeFileSync(join(root, 'session-index.json'), JSON.stringify({ version: 1, sessions }));
}

function assistant(id: string, content = ''): Message {
  return { id, role: 'assistant', content, includeInContext: true, timestamp: 1 };
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'book-runtime-bench-'));
  try {
    const workspace = join(root, 'workspace');
    const rewindRoot = join(root, 'rewind');
    mkdirSync(workspace);
    for (let index = 0; index < 500 * scale; index++) {
      const directory = join(workspace, `dir-${index % 20}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `file-${index}.txt`), `line ${index}\nsearch target\n`);
    }
    mkdirSync(join(workspace, '.book'), { recursive: true });
    writeFileSync(join(workspace, '.book', 'debug.log'), 'x'.repeat(4 * 1024 * 1024));
    writeFileSync(join(workspace, 'binary.bin'), Buffer.from('binary\0search target'));

    const rewind = new RewindSnapshotStore(workspace, rewindRoot);
    await measure(
      'rewind: cold capture',
      async () => {
        const result = await rewind.captureAsync();
        if (!result.ok) throw new Error(result.reason);
      },
      { filesOpened: 501 * scale },
    );
    await measure(
      'rewind: unchanged warm capture',
      async () => {
        const result = await rewind.captureAsync();
        if (!result.ok) throw new Error(result.reason);
      },
      { filesOpened: 0 },
    );
    writeFileSync(join(workspace, 'dir-0', 'file-0.txt'), 'changed\n');
    await measure(
      'rewind: one changed file',
      async () => {
        const result = await rewind.captureAsync();
        if (!result.ok) throw new Error(result.reason);
      },
      { filesOpened: 1 },
    );
    await measure(
      'rewind: oversized .book log excluded',
      async () => {
        const result = await rewind.captureAsync();
        if (
          !result.ok ||
          result.manifest.entries.some((entry) => entry.path.startsWith('.book/'))
        ) {
          throw new Error('workspace-local Book data was captured');
        }
      },
      { filesOpened: 0 },
    );

    for (const count of [100, 1_000, 10_000]) {
      const sessionRoot = join(root, `sessions-${count}`);
      mkdirSync(sessionRoot);
      writeIndexedSessions(sessionRoot, count * scale);
      const store = new SessionStore(sessionRoot);
      await measure(
        `sessions: list ${count * scale}`,
        () => {
          if (store.list().length !== count * scale) throw new Error('session count mismatch');
        },
        { filesOpened: 1 },
      );
    }

    const replayRoot = join(root, 'replay');
    mkdirSync(replayRoot);
    for (const count of [100, 1_000, 10_000]) {
      const id = `replay-${count}`;
      const bytes = writeSessionFile(replayRoot, id, count * scale);
      await measure(
        `sessions: replay ${count * scale} records`,
        () => {
          const loaded = new SessionStore(replayRoot).load(id);
          if (loaded.transcript.length === 0) throw new Error('empty replay');
        },
        { bytesRead: bytes, filesOpened: 1 },
      );
    }
    const searchStore = new SessionStore(replayRoot);
    searchStore.load('replay-10000');
    await measure(
      'sessions: repeated search/read',
      () => {
        for (let index = 0; index < 20; index++) {
          const hit = searchStore.searchCurrent('replay-10000', 'searchable-token', 1)[0];
          if (hit) searchStore.readCurrent('replay-10000', [hit.ref]);
        }
      },
      { filesOpened: 0 },
    );

    const grep = fileTools.find((tool) => tool.name === 'Grep');
    if (!grep) throw new Error('Grep tool unavailable');
    const grepContext = { workspaceRoot: workspace, env: {} };
    await measure(
      'grep: early match',
      async () => {
        await grep.execute({ pattern: 'changed', include: '**/*.txt', head_limit: 1 }, grepContext);
      },
      { childProcesses: 1 },
    );
    await measure(
      'grep: late match',
      async () => {
        await grep.execute({ pattern: `line ${499 * scale}`, include: '**/*.txt' }, grepContext);
      },
      { childProcesses: 1 },
    );
    await measure(
      'grep: no match',
      async () => {
        await grep.execute({ pattern: 'definitely-absent-token', include: '**/*' }, grepContext);
      },
      { childProcesses: 1 },
    );
    await measure(
      'grep: binary-heavy filtering',
      async () => {
        await grep.execute({ pattern: 'search target', include: '**/*' }, grepContext);
      },
      { childProcesses: 1 },
    );
    await measure(
      'grep: cancellation',
      async () => {
        const controller = new AbortController();
        const pending = grep.execute(
          { pattern: 'definitely-absent-token', include: '**/*' },
          { ...grepContext, signal: controller.signal },
        );
        controller.abort(new Error('benchmark cancellation'));
        await pending.catch(() => undefined);
      },
      { childProcesses: 1 },
    );

    const config = defaultConfig({ workspace });
    const contextCache = new AgentContextCache();
    await measure(
      'context: cold construction',
      async () => {
        await buildMessages(
          config,
          [assistant('history', 'done')],
          undefined,
          undefined,
          undefined,
          undefined,
          contextCache,
        );
      },
      { childProcesses: 2 },
    );
    await measure(
      'context: warm construction',
      async () => {
        await buildMessages(
          config,
          [assistant('history', 'done')],
          undefined,
          undefined,
          undefined,
          undefined,
          contextCache,
        );
      },
      { childProcesses: 0, filesOpened: 0 },
    );
    writeFileSync(join(workspace, 'CLAUDE.md'), 'Updated benchmark instructions.');
    contextCache.beginTurn();
    await measure('context: instruction invalidation', async () => {
      await buildMessages(
        config,
        [assistant('history', 'done')],
        undefined,
        undefined,
        undefined,
        undefined,
        contextCache,
      );
    });

    for (const messageCount of [10, 100, 1_000]) {
      await measure(`streaming: 1000 deltas with ${messageCount} messages`, () => {
        let messages = Array.from({ length: messageCount }, (_, index) =>
          assistant(`a-${index}`, 'done'),
        );
        messages.push(assistant('active'));
        const ref = { current: messages };
        const accumulator = createMessageAccumulator(
          'active',
          (update) => {
            messages = update(messages);
            ref.current = messages;
          },
          ref,
        );
        for (let index = 0; index < 1_000; index++) accumulator.addText('x');
        accumulator.flush();
        if (messages.at(-1)?.content.length !== 1_000) throw new Error('delta loss');
      });
    }

    const fetchTool = webTools.find((tool) => tool.name === 'WebFetch');
    if (!fetchTool) throw new Error('WebFetch tool unavailable');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('x'.repeat(1024 * 1024));
    await measure(
      'resources: large WebFetch response',
      async () => {
        const result = await fetchTool.execute({ url: 'https://example.com/large' }, grepContext);
        if (result.status !== 'success' || !(result.data as { truncated?: boolean }).truncated) {
          throw new Error('WebFetch limit was not applied');
        }
      },
      { bytesRead: 256 * 1024 },
    );
    globalThis.fetch = originalFetch;

    const shellOutput = shellTools.find((tool) => tool.name === 'BashOutput');
    if (!shellOutput) throw new Error('BashOutput tool unavailable');
    const shells: BackgroundShellStore = { nextId: 101, shells: new Map() };
    const finishedAt = Date.now();
    for (let index = 0; index < 100; index++) {
      shells.shells.set(`shell_${index}`, {
        id: `shell_${index}`,
        command: 'completed',
        effectiveCommand: 'completed',
        workdir: workspace,
        status: 'exited',
        output: 'x'.repeat(64 * 1024),
        readOffset: 0,
        truncatedBytes: 0,
        startedAt: finishedAt - 1,
        finishedAt: finishedAt + index,
      });
    }
    await measure('resources: background-shell retention pruning', async () => {
      await shellOutput.execute(
        { shell_id: 'shell_99' },
        { workspaceRoot: workspace, env: {}, backgroundShells: shells },
      );
      if (shells.shells.size !== 20) throw new Error('terminal shell cap was not applied');
    });

    const debugPath = join(root, 'bounded-debug.log');
    const debugModule = pathToFileURL(join(process.cwd(), 'src', 'debug-log.ts')).href;
    await measure(
      'resources: bounded debug-log growth',
      () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              '--import',
              'tsx',
              '--input-type=module',
              '--eval',
              `const { createDebugLogger } = await import(${JSON.stringify(debugModule)}); const log = createDebugLogger('bench'); for (let i = 0; i < 10000; i++) log.debug('x'.repeat(100));`,
            ],
            {
              cwd: process.cwd(),
              windowsHide: true,
              env: {
                ...process.env,
                BOOK_DEBUG: '1',
                BOOK_DEBUG_FILE: debugPath,
                BOOK_DEBUG_MAX_BYTES: String(64 * 1024),
                BOOK_DEBUG_BACKUPS: '2',
              },
              stdio: 'ignore',
            },
          );
          child.once('error', reject);
          child.once('close', (code) => {
            if (code !== 0) reject(new Error(`debug logger child exited with ${code}`));
            else resolve();
          });
        }),
      { childProcesses: 1 },
    );
    const retainedDebugBytes = [debugPath, `${debugPath}.1`, `${debugPath}.2`]
      .filter(existsSync)
      .reduce((total, path) => total + statSync(path).size, 0);
    if (retainedDebugBytes > 3 * 64 * 1024) throw new Error('debug log rotation exceeded its cap');

    const agentRoot = join(root, 'agents');
    const writer = new AgentStore('repo', agentRoot);
    for (let index = 0; index < 100 * scale; index++) {
      const now = Date.now();
      const record: AgentRecord = {
        id: `agent-${index}`,
        name: 'explorer',
        role: 'explorer',
        description: 'benchmark',
        status: 'completed',
        applicationStatus: 'not_applied',
        prompt: 'benchmark',
        referencedEvidenceIds: [],
        transcript: [assistant(`agent-message-${index}`, 'x'.repeat(100_000))],
        pendingMessages: [],
        createdAt: now,
        updatedAt: now,
      };
      writer.saveAgent(record);
    }
    await measure(
      'resources: lazy agent-store initialization',
      () => {
        const store = new AgentStore('repo', agentRoot);
        if (store.listAgents().some((record) => record.transcript.length > 0)) {
          throw new Error('agent transcript eagerly materialized');
        }
      },
      { filesOpened: 100 * scale },
    );

    console.table(
      measurements.map((item) => ({
        name: item.name,
        wallMs: item.wallMs.toFixed(2),
        cpuMs: item.cpuMs.toFixed(2),
        peakHeapDeltaMb: item.peakHeapDeltaMb.toFixed(2),
        retainedHeapDeltaMb: item.retainedHeapDeltaMb.toFixed(2),
        bytesRead: item.bytesRead ?? '',
        filesOpened: item.filesOpened ?? '',
        childProcesses: item.childProcesses ?? '',
      })),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
