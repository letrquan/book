import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/** The mock is spawned with its stdin closed and both of its outputs piped. */
type MockChild = ChildProcessByStdio<null, Readable, Readable>;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MOCK = join(REPO_ROOT, '.claude', 'skills', 'run-book', 'mock-provider.mjs');

/** A port nothing is listening on: bind 0, read the port, close it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const started: MockChild[] = [];
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-mock-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const child of started.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
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
 * Start the mock and wait for its READY line — or, with `expectExit`, for it to
 * exit instead, which is how the pre-serving refusals are observed.
 */
async function startMock(
  args: string[],
  { expectExit = false }: { expectExit?: boolean } = {},
): Promise<MockRun> {
  const child = spawn(process.execPath, [MOCK, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  it('logs into a fresh private temp directory named on the READY line', async () => {
    const port = await freePort();
    const { ready } = await startMock([`--port`, String(port)]);

    const logPath = logPathOf(ready);
    const dir = dirname(logPath);
    // Not the predictable shared path any more, and a directory of the run's own.
    expect(logPath).not.toBe(join(tmpdir(), `book-mock-${port}.requests.jsonl`));
    expect(basename(logPath)).toBe('requests.jsonl');
    expect(basename(dir).startsWith(`book-mock-${port}-`)).toBe(true);
    // mkdtemp's own mode: nothing else on the machine can write into it.
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700);

    await (await post(`http://127.0.0.1:${port}`)).text();

    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ n: 0, sequenceIndex: 0 });
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

    const { exit } = await startMock([`--port`, String(await freePort()), '--request-log', link], {
      expectExit: true,
    });
    const result = await exit;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('mock-provider: refusing the request log');
    expect(result.stderr).toContain('symbolic link');
    // Never written through, and never served: the refusal is before READY.
    expect(readFileSync(target, 'utf8')).toBe('untouched');
  });
});

describe('mock-provider scenario turns', () => {
  it('answers a malformed turn with a 500 naming it, and keeps serving', async () => {
    const port = await freePort();
    const { child } = await startMock([
      `--port`,
      String(port),
      '--script',
      scenarioWith([{ text: 5 }, { text: 'after' }]),
    ]);
    const base = `http://127.0.0.1:${port}`;

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

  it('ends a stream that fails after the headers, and serves the next request', async (ctx) => {
    // No scenario turn reaches that path: after validation the only throw sites are a
    // destroyed socket (ClientGone, already handled) and `JSON.stringify` of data the
    // scenario itself wrote, which cannot be circular. The handler's post-header catch
    // is therefore untestable from a scenario, and this says so rather than assuming it.
    ctx.skip();
  });
});
