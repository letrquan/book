/**
 * Peer awareness evaluation (#620 PR 4), mock mode: two sessions work in one git worktree with
 * overlapping edits, once without peer awareness (4c–4e off) and once with it (on). Both arms run
 * the real agent loop, tools, live-session writers and registry; only the model is scripted.
 *
 * The scenario: A reads `src/config.ts`; B reads it and changes one line; A then changes another
 * line. A's scripted model is a weak one: it notices another session only when a line in its
 * context names one (the 4c peer line, a 4d attribution, or a refusal naming the peer). When it
 * notices, it re-reads and edits just its line. When it does not, it rewrites the whole file from
 * what it read first, re-reading only to get past the stale-file refusal — the lost-update pattern
 * the harness is meant to prevent. So the mock measures whether the signal reaches the model, not
 * how a real model answers it; the real-model runs (PR body, owner's budget) measure that, with the
 * same scenario and a real provider in place of `weakModel`.
 *
 * Recorded per arm: lost edits (B's line gone at the end), conflicts noticed (A's context named B),
 * coordination (A told the user or messaged B), overlap warnings shown (4e, both sessions), and the
 * characters the peer lines added to A's prompt.
 *
 * Usage: npx tsx scripts/peer-awareness-eval.ts [--json]
 * No provider, no network, no cost.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAgentLoop } from '../src/agent/loop.js';
import type { LivenessProbe } from '../src/messaging/liveness.js';
import { PeerAwareness } from '../src/messaging/peer-awareness.js';
import { LiveSessionWriter } from '../src/messaging/writer.js';
import type { Provider } from '../src/provider/index.js';
import { SessionRuntime } from '../src/session/runtime.js';
import { defaultConfig } from '../src/test/fixtures.js';
import { createDefaultRegistry } from '../src/tools/registry.js';
import type { Message } from '../src/types/messages.js';
import type { ProviderMessage } from '../src/types/providers.js';
import type { ToolCall } from '../src/types/tools.js';

export interface ArmResult {
  arm: 'off' | 'on';
  /** B's change was overwritten. */
  lostEdits: number;
  /** A's context named B before A finished its edit. */
  conflictsNoticed: number;
  /** A told the user another session was editing the file (messaging is off in the mock). */
  coordination: number;
  /** 4e warnings shown, both sessions together. */
  overlapWarnings: number;
  /** Characters the peer lines and attributions added to A's prompt. */
  peerChars: number;
}

const FILE = 'src/config.ts';
const ORIGINAL = ['export const config = {', '  retries: 1,', '  timeoutMs: 1000,', '};', ''].join(
  '\n',
);
const PEER = /Other Book sessions in this worktree|recorded an edit to/;

function text(content: ProviderMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => ('text' in part ? String(part.text ?? '') : '')).join('\n');
  }
  return '';
}

/** A model that plays `calls` in order, then answers `answer`. */
function scripted(calls: ToolCall[], answer = 'done'): Provider {
  let step = 0;
  return {
    id: 'scripted',
    stream: async function* () {
      const call = calls[step++];
      if (call) yield { type: 'tool_call', toolCall: call };
      else yield { type: 'text', content: answer };
      yield { type: 'done' };
    },
  };
}

/** A's weak model for its second turn, as described above. */
function weakModel(
  firstRead: string,
  record: { noticed: boolean; told: boolean; peerChars: number },
): Provider {
  let step = 0;
  let id = 0;
  const call = (name: string, args: Record<string, unknown>): ToolCall => ({
    id: `a-${++id}`,
    name,
    arguments: args,
  });
  const mine = firstRead.replace('timeoutMs: 1000', 'timeoutMs: 5000');
  return {
    id: 'weak',
    stream: async function* (_config, messages) {
      const seen = messages.map((message) => text(message.content)).join('\n');
      if (step === 0) {
        record.peerChars = seen
          .split('\n')
          .filter((line) => PEER.test(line))
          .reduce((sum, line) => sum + line.length, 0);
      }
      if (PEER.test(seen)) record.noticed = true;
      step++;
      if (record.noticed) {
        // Re-read, change only its own line, and tell the user.
        if (step === 1) yield { type: 'tool_call', toolCall: call('Read', { filePath: FILE }) };
        else if (step === 2) {
          yield {
            type: 'tool_call',
            toolCall: call('Edit', {
              filePath: FILE,
              oldString: 'timeoutMs: 1000',
              newString: 'timeoutMs: 5000',
            }),
          };
        } else {
          record.told = true;
          yield {
            type: 'text',
            content: 'Another session is editing src/config.ts too; I changed only timeoutMs.',
          };
        }
      } else if (step === 1) {
        yield { type: 'tool_call', toolCall: call('Write', { filePath: FILE, content: mine }) };
      } else if (step === 2) {
        yield { type: 'tool_call', toolCall: call('Read', { filePath: FILE }) };
      } else if (step === 3) {
        yield { type: 'tool_call', toolCall: call('Write', { filePath: FILE, content: mine }) };
      } else {
        yield { type: 'text', content: 'Set timeoutMs to 5000.' };
      }
      yield { type: 'done' };
    },
  };
}

const callbacks = {
  onText: () => {},
  onToolCall: () => {},
  onToolResult: () => {},
  onError: () => {},
  onTurnStart: () => {},
  onDone: () => {},
  onPermissionRequired: async () => 'allow' as const,
};

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function runArm(arm: 'off' | 'on'): Promise<ArmResult> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `book-peer-eval-${arm}-`)));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(join(repo, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, FILE), ORIGINAL);

  // Two sessions in one process: B gets a pid of its own, and one probe vouches for both.
  const pids = { a: process.pid, b: process.pid + 1_000_000 };
  const probe: LivenessProbe = {
    isAlive: (pid) => pid === pids.a || pid === pids.b,
    startToken: async (pid) => `start-${pid}`,
    pidDomain: async () => 'eval:peer-awareness',
  };
  const writer = (pid: number, name: string) =>
    new LiveSessionWriter({
      cwd: repo,
      sessionId: `session-${name}`,
      version: 'eval',
      home,
      pid,
      probe,
      env: { ...process.env, BOOK_SESSION_NAME: name },
    });
  const writers = { a: writer(pids.a, 'peer-a'), b: writer(pids.b, 'peer-b') };
  await Promise.all([writers.a.start(), writers.b.start()]);
  const awareness =
    arm === 'on'
      ? {
          a: new PeerAwareness({ writer: writers.a, home, pid: pids.a, probe }),
          b: new PeerAwareness({ writer: writers.b, home, pid: pids.b, probe }),
        }
      : undefined;
  let overlapWarnings = 0;
  awareness?.a.subscribe(() => overlapWarnings++);
  awareness?.b.subscribe(() => overlapWarnings++);

  const config = defaultConfig({ workspace: repo, maxTurns: 8 });
  const runtimes = { a: new SessionRuntime(), b: new SessionRuntime() };
  const run = (who: 'a' | 'b', prompt: string, provider: Provider, history: Message[] = []) =>
    runAgentLoop(config, createDefaultRegistry(), prompt, history, callbacks, 'bypassPermissions', {
      provider,
      isNewSession: false,
      runtime: runtimes[who],
      ...(awareness ? { peerAwareness: awareness[who] } : {}),
    });

  try {
    const aHistory = await run(
      'a',
      'Look at the config.',
      scripted([{ id: 'a-0', name: 'Read', arguments: { filePath: FILE } }]),
    );
    const firstRead = readFileSync(join(repo, FILE), 'utf8');
    await run(
      'b',
      'Raise retries to 3.',
      scripted([
        { id: 'b-1', name: 'Read', arguments: { filePath: FILE } },
        {
          id: 'b-2',
          name: 'Edit',
          arguments: { filePath: FILE, oldString: 'retries: 1', newString: 'retries: 3' },
        },
      ]),
    );
    // B's edit reaches its record within the writer's 2 s throttle.
    if (awareness) await until(() => writers.b.current()?.recentEdits !== undefined);
    const record = { noticed: false, told: false, peerChars: 0 };
    await run('a', 'Set timeoutMs to 5000.', weakModel(firstRead, record), aHistory);
    if (awareness && record.noticed) {
      // A's own check runs as its edit is recorded; B, idle, hears on its next poll, once A's
      // record carries the edit.
      await until(() => writers.a.current()?.recentEdits !== undefined);
      await awareness.b.checkOverlaps();
      await until(() => overlapWarnings >= 2).catch(() => undefined);
    }
    const final = readFileSync(join(repo, FILE), 'utf8');
    return {
      arm,
      lostEdits: final.includes('retries: 3') ? 0 : 1,
      conflictsNoticed: record.noticed ? 1 : 0,
      coordination: record.told ? 1 : 0,
      overlapWarnings,
      peerChars: record.peerChars,
    };
  } finally {
    awareness?.a.close();
    awareness?.b.close();
    runtimes.a.dispose('eval');
    runtimes.b.dispose('eval');
    await Promise.all([writers.a.close(), writers.b.close()]);
    rmSync(root, { recursive: true, force: true });
  }
}

export async function runPeerAwarenessEval(): Promise<ArmResult[]> {
  return [await runArm('off'), await runArm('on')];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const results = await runPeerAwarenessEval();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        '| arm | lost edits | conflicts noticed | coordination | overlap warnings | peer chars |',
        '| --- | --- | --- | --- | --- | --- |',
        ...results.map(
          (r) =>
            `| ${r.arm} | ${r.lostEdits} | ${r.conflictsNoticed} | ${r.coordination} | ${r.overlapWarnings} | ${r.peerChars} |`,
        ),
        '',
      ].join('\n'),
    );
  }
}
