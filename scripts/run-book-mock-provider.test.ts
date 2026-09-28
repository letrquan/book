import { spawn, type ChildProcessByStdio } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/** The mock is spawned with its stdin closed and both of its outputs piped. */
type MockChild = ChildProcessByStdio<null, Readable, Readable>;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MOCK = join(REPO_ROOT, '.claude', 'skills', 'run-book', 'mock-provider.mjs');

const started: MockChild[] = [];
/** Every directory this file makes, mock-made or not, gone after each test. */
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-mock-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const child of started.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    // On Windows this is TerminateProcess, which the mock's own handlers never see.
    child.kill();
    await new Promise((resolve) => child.once('close', resolve));
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface MockRun {
  child: MockChild;
  /** The READY line, or '' for a mock that refused before serving. */
  ready: string;
  stderr: () => string;
  exit: Promise<{ code: number | null; stderr: string }>;
}

/**
 * Start the mock on port 0 — the kernel's choice, so no test can collide with
 * another run's port — and wait for its READY line, or with `expectExit` for it to
 * exit instead, which is how the pre-serving refusals are observed.
 */
async function startMock(
  args: string[],
  { expectExit = false }: { expectExit?: boolean } = {},
): Promise<MockRun> {
  const child = spawn(process.execPath, [MOCK, '--port', '0', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  started.push(child);
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    err += chunk;
  });
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on('close', (code) => resolve({ code, stderr: err }));
  });
  if (expectExit) {
    await exited;
    return { child, ready: '', stderr: () => err, exit: exited };
  }
  const ready = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no READY within 15s; stderr:\n${err}`)),
      15000,
    );
    const poll = setInterval(() => {
      const match = out.match(/^MOCK-PROVIDER-READY (.*)$/m);
      if (!match) return;
      clearTimeout(timer);
      clearInterval(poll);
      resolve(match[0]);
    }, 25);
    child.once('close', () => {
      clearTimeout(timer);
      clearInterval(poll);
      reject(new Error(`mock exited before READY (code ${child.exitCode}); stderr:\n${err}`));
    });
  });
  return { child, ready, stderr: () => err, exit: exited };
}

/** The `<path>` of the `(requests -> <path>)` the READY line ends with. */
function logPathOf(readyLine: string): string {
  const match = readyLine.match(/\(requests -> (.+)\)$/);
  if (!match) throw new Error(`no log path in READY line: ${readyLine}`);
  return match[1];
}

/** The `http://127.0.0.1:<port>` the READY line names — port 0 resolved. */
function baseOf(readyLine: string): string {
  const match = readyLine.match(/MOCK-PROVIDER-READY (http:\/\/127\.0\.0\.1:\d+)/);
  if (!match) throw new Error(`no base URL in READY line: ${readyLine}`);
  return match[1];
}

/** One chat completion, as Book sends it. */
function post(base: string): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'mock-model',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
}

function scenarioWith(turns: unknown[]): string {
  const script = join(tempDir(), 'scenario.json');
  writeFileSync(script, JSON.stringify(turns));
  return script;
}

describe('mock-provider request log', () => {
  it('logs into a private temp directory, and removes it when the mock stops', async () => {
    const { child, ready, exit } = await startMock([]);

    const logPath = logPathOf(ready);
    const dir = dirname(logPath);
    // Cleaned up either way: the mock removes it, and this file would too.
    tempDirs.push(dir);
    // Not the predictable shared path any more, and a directory of the run's own.
    expect(basename(logPath)).toBe('requests.jsonl');
    expect(basename(dir).startsWith('book-mock-')).toBe(true);
    // mkdtemp's own mode: nothing else on the machine can write into it.
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700);

    await (await post(baseOf(ready))).text();

    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ n: 0, sequenceIndex: 0 });

    if (process.platform === 'win32') {
      // A hard kill runs none of the mock's own cleanup, so nothing to assert here;
      // afterEach removes what the mock could not.
      child.kill();
      await exit;
      return;
    }
    child.kill('SIGTERM');
    await exit;
    // The log of a run is the run's: a directory of whole request bodies does not
    // outlive it in a shared temp directory.
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses a --request-log that is a symbolic link', async (ctx) => {
    const dir = tempDir();
    const link = join(dir, 'log.jsonl');
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'untouched');
    try {
      symlinkSync(target, link);
    } catch (error) {
      // Windows without the SeCreateSymbolicLinkPrivilege.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        ctx.skip();
        return;
      }
      throw error;
    }

    const { exit } = await startMock(['--request-log', link], { expectExit: true });
    const result = await exit;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('mock-provider: refusing the request log');
    expect(result.stderr).toContain('symbolic link');
    // Never written through, and never served: the refusal is before READY.
    expect(readFileSync(target, 'utf8')).toBe('untouched');
  });

  it('exits before serving when the request log cannot be opened', async () => {
    // A log in a directory that does not exist: the open fails, and a mock that could
    // not open its log must not go on to announce one.
    const logPath = join(tempDir(), 'no-such-directory', 'log.jsonl');
    const { exit } = await startMock(['--request-log', logPath], { expectExit: true });
    const result = await exit;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('mock-provider: cannot open the request log');
    expect(result.stderr).toContain(logPath);
  });
});

describe('mock-provider scenario turns', () => {
  it('answers a malformed turn with a 500 naming it, and keeps serving', async () => {
    const { child, ready } = await startMock([
      '--request-log',
      join(tempDir(), 'requests.jsonl'),
      '--script',
      scenarioWith([{ text: 5 }, { text: 'after' }]),
    ]);
    const base = baseOf(ready);

    const first = await post(base);
    expect(first.status).toBe(500);
    const body = (await first.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe('mock_scenario_error');
    expect(body.error.message).toMatch(/turn 0/);
    expect(body.error.message).toMatch(/malformed/);

    // The script position still advanced, so this is turn 1 — and the fact that the
    // server answered at all is the fact that the malformed turn did not kill it.
    const second = await post(base);
    expect(second.status).toBe(200);
    expect(await second.text()).toContain('after');
    expect(child.exitCode).toBeNull();
  });

  it('accepts the shapes a scenario can write on purpose', async () => {
    // A null field reads as absent to the streamer, a setTimeout delay coerces, and a
    // nameless tool call is a router bug a scenario reproduces on purpose: none of
    // these may be refused as malformed.
    const { ready } = await startMock([
      '--request-log',
      join(tempDir(), 'requests.jsonl'),
      '--script',
      scenarioWith([
        { text: null, holdMs: null, thinkMs: '5' },
        { tool: { arguments: { file_path: 'a' } } },
        { tools: [{ name: 'Read' }], chunkDelayMs: 0 },
      ]),
    ]);
    const base = baseOf(ready);

    // Turn 0 falls back to the default reply; turn 1 streams a call with no name.
    expect(await answeredWith(base)).toContain('MOCK-OK');
    expect(await answeredWith(base)).toContain('"tool_calls"');
    expect(await answeredWith(base)).toContain('Read');
  });
});

/** One request's whole SSE stream, so a refusal cannot pass as an answer. */
async function answeredWith(base: string): Promise<string> {
  const response = await post(base);
  expect(response.status).toBe(200);
  return response.text();
}
