import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runEvaluationProcess } from './runner.js';

describe('runEvaluationProcess', () => {
  it('runs in a fresh workspace with isolated Book and user-state paths', async () => {
    const result = await runEvaluationProcess({
      command: process.execPath,
      args: [
        '-e',
        [
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "fs.writeFileSync(path.join(process.cwd(), 'result.txt'), 'ok');",
          'process.stdout.write(JSON.stringify({',
          'cwd: process.cwd(),',
          'bookHome: process.env.BOOK_HOME,',
          'home: process.env.HOME,',
          'runId: process.env.BOOK_EVALUATION_RUN_ID,',
          'secret: process.env.BOOK_API_KEY,',
          '}));',
        ].join(''),
      ],
      timeoutMs: 5_000,
      sourceEnv: { PATH: process.env.PATH, BOOK_API_KEY: 'must-not-leak' },
      retainWorkspace: true,
    });

    try {
      expect(result.status).toBe('completed');
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        cwd: result.workspace,
        bookHome: result.bookHome,
        home: result.root,
        runId: result.runId,
      });
      expect(await readFile(join(result.workspace, 'result.txt'), 'utf8')).toBe('ok');
    } finally {
      await rm(result.root, { recursive: true, force: true });
    }
  });

  it('copies only explicitly allowlisted ambient variables', async () => {
    const result = await runEvaluationProcess({
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write(JSON.stringify({allowed:process.env.EVAL_ALLOWED,blocked:process.env.EVAL_BLOCKED}))',
      ],
      timeoutMs: 5_000,
      sourceEnv: { PATH: process.env.PATH, EVAL_ALLOWED: 'yes', EVAL_BLOCKED: 'no' },
      envAllowlist: ['EVAL_ALLOWED'],
    });

    expect(result.status).toBe('completed');
    expect(JSON.parse(result.stdout)).toEqual({ allowed: 'yes' });
    await expect(access(result.root)).rejects.toThrow();
  });

  it('bounds captured output and distinguishes timeouts', async () => {
    const output = await runEvaluationProcess({
      command: process.execPath,
      args: ['-e', "process.stdout.write('abcdefghij')"],
      timeoutMs: 5_000,
      maxOutputBytes: 4,
    });
    expect(output).toMatchObject({
      status: 'completed',
      stdout: 'abcd',
      stdoutTruncated: true,
    });

    const timedOut = await runEvaluationProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 50,
    });
    expect(timedOut.status).toBe('timed-out');
  });

  it('terminates evaluator descendants before returning a timeout', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'book-harness-tree-test-'));
    const readyPath = join(testRoot, 'ready.txt');
    const survivorPath = join(testRoot, 'survivor.txt');
    const grandchildSource = [
      "const fs = require('node:fs');",
      "setTimeout(() => fs.writeFileSync(process.env.SURVIVOR_PATH, 'alive'), 1000);",
      'setInterval(() => {}, 1000);',
    ].join('');
    const parentSource = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { stdio: 'ignore' });`,
      "fs.writeFileSync(process.env.READY_PATH, 'ready');",
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('');

    try {
      const startedAt = Date.now();
      const result = await runEvaluationProcess({
        command: process.execPath,
        args: ['-e', parentSource],
        timeoutMs: 300,
        terminationGraceMs: 50,
        env: { READY_PATH: readyPath, SURVIVOR_PATH: survivorPath },
      });
      expect(result.status).toBe('timed-out');
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      await expect(readFile(readyPath, 'utf8')).resolves.toBe('ready');
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));
      await expect(access(survivorPath)).rejects.toThrow();
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it('preserves non-zero, cancelled, and spawn-failed terminal states', async () => {
    const failed = await runEvaluationProcess({
      command: process.execPath,
      args: ['-e', 'process.exit(7)'],
      timeoutMs: 5_000,
    });
    expect(failed).toMatchObject({ status: 'failed', exitCode: 7 });

    const controller = new AbortController();
    const cancellation = runEvaluationProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancellation).resolves.toMatchObject({ status: 'cancelled' });

    const spawnFailed = await runEvaluationProcess({
      command: join(tmpdir(), `missing-book-evaluator-${process.pid}`),
      timeoutMs: 5_000,
    });
    expect(spawnFailed.status).toBe('spawn-failed');
    expect(spawnFailed.stderr).not.toBe('');
  });

  it('prepares fixtures before the child process starts', async () => {
    const result = await runEvaluationProcess({
      command: process.execPath,
      args: ['-e', "process.stdout.write(require('node:fs').readFileSync('fixture.txt', 'utf8'))"],
      timeoutMs: 5_000,
      prepare: async ({ workspace }) => {
        await writeFile(join(workspace, 'fixture.txt'), 'ready', 'utf8');
      },
    });
    expect(result).toMatchObject({ status: 'completed', stdout: 'ready' });
  });

  it('does not allow callers to replace runner-owned isolation variables', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'book-harness-runner-test-'));
    try {
      await expect(
        runEvaluationProcess({
          command: process.execPath,
          timeoutMs: 5_000,
          temporaryRoot,
          retainWorkspace: true,
          env: { BOOK_HOME: 'shared-home' },
        }),
      ).rejects.toThrow('Evaluation runner owns environment variable BOOK_HOME.');
      expect(await readdir(temporaryRoot)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
