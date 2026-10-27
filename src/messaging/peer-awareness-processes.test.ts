/**
 * Peer awareness between real processes (#620 PR 4): two sessions sharing a `BOOK_HOME` and a git
 * worktree, each with its own live-session record, peer awareness and agent loop, as the TUI's
 * host wires them. B edits a file A has read; A's next `<session-state>` names B in the peer line
 * and attributes the change to it, and A's stale write is refused naming B. Integration tier: every
 * case spawns processes and runs git.
 *
 * Every record stays under a temporary `BOOK_HOME`, never the developer's own.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TSX_LOADER = import.meta.resolve('tsx');
const moduleUrl = (path: string) =>
  pathToFileURL(fileURLToPath(new URL(`../${path}`, import.meta.url))).href;

/**
 * A session process: its record, its peer awareness, and one agent loop per `turn` command, whose
 * model is a script of tool calls. Events go to stdout as JSON lines.
 */
const SESSION_SCRIPT = `
import { createInterface } from 'node:readline';
const { LiveSessionWriter } = await import(${JSON.stringify(moduleUrl('messaging/writer.ts'))});
const { PeerAwareness } = await import(${JSON.stringify(moduleUrl('messaging/peer-awareness.ts'))});
const { runAgentLoop } = await import(${JSON.stringify(moduleUrl('agent/loop.ts'))});
const { createDefaultRegistry } = await import(${JSON.stringify(moduleUrl('tools/registry.ts'))});
const { SessionRuntime } = await import(${JSON.stringify(moduleUrl('session/runtime.ts'))});
const { defaultConfig } = await import(${JSON.stringify(moduleUrl('test/fixtures.ts'))});
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
const writer = new LiveSessionWriter({ cwd: process.cwd(), sessionId: 'session-' + process.pid, version: 'test' });
await writer.start();
const peers = new PeerAwareness({ writer });
const runtime = new SessionRuntime();
const config = defaultConfig({ workspace: process.cwd(), maxTurns: 6 });
let history = [];
emit({ event: 'started', name: writer.current()?.name, worktree: writer.location?.worktree });
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.cmd !== 'turn') continue;
  const requests = [];
  let step = 0;
  const provider = {
    id: 'scripted',
    stream: async function* (_config, messages) {
      requests.push(messages);
      const call = command.calls[step++];
      if (call) yield { type: 'tool_call', toolCall: call };
      else yield { type: 'text', content: 'ok' };
      yield { type: 'done' };
    },
  };
  const results = [];
  history = await runAgentLoop(config, createDefaultRegistry(), command.prompt, history, {
    onText: () => {}, onToolCall: () => {}, onError: () => {}, onTurnStart: () => {}, onDone: () => {},
    onToolResult: (result) => results.push({ status: result.status, error: result.structuredError?.message }),
    onPermissionRequired: async () => 'allow',
  }, 'bypassPermissions', { provider, isNewSession: false, runtime, peerAwareness: peers });
  const user = [...requests[0]].reverse().find((message) => message.role === 'user');
  emit({ event: 'turn', state: JSON.stringify(user?.content ?? ''), results });
}
`;

interface SessionEvent {
  event: string;
  [field: string]: unknown;
}

class Session {
  readonly events: SessionEvent[] = [];
  readonly exited: Promise<number | null>;

  constructor(readonly child: ChildProcess) {
    createInterface({ input: child.stdout! }).on('line', (line) => {
      try {
        this.events.push(JSON.parse(line) as SessionEvent);
      } catch {
        // Not an event.
      }
    });
    this.exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  }

  command(value: object): void {
    this.child.stdin!.write(`${JSON.stringify(value)}\n`);
  }

  async waitFor(event: string, count = 1, timeoutMs = 30_000): Promise<SessionEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.filter((candidate) => candidate.event === event);
      if (found.length >= count) return found[count - 1]!;
      if (Date.now() > deadline) {
        throw new Error(`no ${event} event; saw ${JSON.stringify(this.events).slice(0, 2000)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

const read = (id: string, filePath: string) => ({ id, name: 'Read', arguments: { filePath } });

describe.skipIf(process.platform === 'win32')('peer awareness between processes', () => {
  let root: string;
  let home: string;
  let repo: string;
  let script: string;
  const sessions: Session[] = [];

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'bk-peers-')));
    home = join(root, 'home');
    repo = join(root, 'repo');
    script = join(root, 'session.mjs');
    writeFileSync(script, SESSION_SCRIPT);
    mkdirSync(join(repo, 'src'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'src', 'x.ts'), 'export const value = "one";\n');
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      session.child.kill('SIGKILL');
      await session.exited;
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function spawnSession(name: string): Session {
    const child = spawn(process.execPath, ['--import', TSX_LOADER, script], {
      cwd: repo,
      env: { ...process.env, BOOK_HOME: home, BOOK_SESSION_NAME: name },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const session = new Session(child);
    sessions.push(session);
    return session;
  }

  /** Wait until a record in the registry claims an edit of `path`. */
  async function recordedEdit(path: string): Promise<void> {
    const dir = join(home, 'live-sessions');
    const deadline = Date.now() + 15_000;
    for (;;) {
      const claimed = readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .some((name) => {
          try {
            const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
              recentEdits?: Array<{ path: string }>;
            };
            return record.recentEdits?.some((edit) => edit.path === path) ?? false;
          } catch {
            return false;
          }
        });
      if (claimed) return;
      if (Date.now() > deadline) throw new Error(`no record claims an edit of ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it("names B in A's next session-state and in A's stale-file refusal", async () => {
    const a = spawnSession('peer-a');
    const b = spawnSession('peer-b');
    expect(await a.waitFor('started')).toMatchObject({ name: 'peer-a', worktree: repo });
    expect(await b.waitFor('started')).toMatchObject({ name: 'peer-b', worktree: repo });

    a.command({ cmd: 'turn', prompt: 'read it', calls: [read('a-read', 'src/x.ts')] });
    await a.waitFor('turn');

    b.command({
      cmd: 'turn',
      prompt: 'change it',
      calls: [
        read('b-read', 'src/x.ts'),
        {
          id: 'b-edit',
          name: 'Edit',
          arguments: { filePath: 'src/x.ts', oldString: '"one"', newString: '"two"' },
        },
      ],
    });
    const bTurn = await b.waitFor('turn');
    expect(bTurn.results).toEqual([
      expect.objectContaining({ status: 'success' }),
      expect.objectContaining({ status: 'success' }),
    ]);
    await recordedEdit('src/x.ts');

    a.command({
      cmd: 'turn',
      prompt: 'change it too',
      calls: [
        {
          id: 'a-edit',
          name: 'Edit',
          arguments: { filePath: 'src/x.ts', oldString: '"one"', newString: '"three"' },
        },
      ],
    });
    const aTurn = await a.waitFor('turn', 2);
    const state = JSON.parse(aTurn.state as string) as string;
    expect(state).toContain('- Other Book sessions in this worktree: peer-b (');
    expect(state).toContain('recorded edits: src/x.ts just now');
    expect(state).toContain(
      '- src/x.ts changed on disk since you last read it. peer-b recorded an edit to src/x.ts just now. Re-read it; if your changes overlap, tell the user another session is editing it.',
    );
    expect(state).toContain('-export const value = "one";');
    expect(state).toContain('+export const value = "two";');

    const [refusal] = aTurn.results as Array<{ status: string; error?: string }>;
    expect(refusal!.status).not.toBe('success');
    expect(refusal!.error).toContain('changed or disappeared');
    expect(refusal!.error).toContain('peer-b recorded an edit to src/x.ts just now.');
    expect(readFileSync(join(repo, 'src', 'x.ts'), 'utf8')).toContain('"two"');
  }, 90_000);
});
