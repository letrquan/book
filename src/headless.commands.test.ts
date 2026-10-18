import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Readable } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHeadless } from './headless.js';
import { UnsupportedPrintCommandError } from './commands/print-dispatch.js';
import { createDefaultRegistry } from './tools/registry.js';
import { SessionStore } from './session/store.js';
import { defaultConfig } from './test/fixtures.js';
import { isolateBookHome } from './test/isolated-book-home.js';
import { projectCommandFingerprint } from './command-approvals.js';
import { createRepeatingScriptedProvider, sseResponse } from './test/scripted-provider.js';
import type { ScriptedProvider } from './test/scripted-provider.js';
import type { AgentConfig } from './types/runtime.js';

let tempDirs: string[] = [];
isolateBookHome('book-headless-home-');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const workspace = mkdtempSync(join(tmpdir(), 'book-headless-cmd-'));
  tempDirs.push(workspace);
  return defaultConfig({ baseUrl: 'http://localhost/v1', workspace, ...overrides });
}

function writeCommand(workspace: string, name: string, contents: string): void {
  const dir = join(workspace, '.book', 'commands');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), contents, 'utf-8');
}

/** Record the decision this workspace would otherwise be refused for. */
function approveCommand(config: AgentConfig, name: string, body: string): void {
  config.settings.commands.projectCommands[name] = {
    fingerprint: projectCommandFingerprint(body),
    choice: 'approved',
  };
}

function textEvent(content: string): string {
  return JSON.stringify({ choices: [{ delta: { content } }] });
}

function stubProvider(text = 'done'): ScriptedProvider {
  const provider = createRepeatingScriptedProvider(() => sseResponse([textEvent(text)]));
  vi.stubGlobal('fetch', provider.fetch);
  return provider;
}

interface ProviderRequestBody {
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function?: { name?: string } }>;
}

function requestBody(provider: ScriptedProvider, index = 0): ProviderRequestBody {
  const body = provider.requests[index]?.init?.body;
  if (typeof body !== 'string') throw new Error('provider request had no JSON body');
  return JSON.parse(body) as ProviderRequestBody;
}

function lastUserText(provider: ScriptedProvider, index = 0): string {
  const messages = requestBody(provider, index).messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    const content = messages[i].content;
    // Return the text the model saw, not its JSON encoding: stringifying
    // escapes backslashes, so Windows paths never match toContain().
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((block) => {
          const text = (block as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        })
        .join('\n');
    }
    return JSON.stringify(content);
  }
  throw new Error('no user message in provider request');
}

function collectWrites(): { stdout: { write: (value: string) => boolean }; text: () => string } {
  const writes: string[] = [];
  return {
    stdout: {
      write: (value: string) => {
        writes.push(value);
        return true;
      },
    },
    text: () => writes.join(''),
  };
}

function run(config: AgentConfig, prompt: string, overrides: Record<string, unknown> = {}) {
  return runHeadless(config, createDefaultRegistry(), {
    prompt,
    inputFormat: 'text',
    outputFormat: 'text',
    history: [],
    mode: 'default',
    maxTurns: 1,
    stdout: collectWrites().stdout,
    ...overrides,
  });
}

describe('runHeadless — slash commands in print mode', () => {
  it('expands a built-in prompt command instead of sending the literal slash string', async () => {
    const provider = stubProvider();
    const config = makeConfig();

    await run(config, '/security-review auth paths');

    expect(provider.requests.length).toBe(1);
    const sent = lastUserText(provider);
    expect(sent).toContain('Perform a security review');
    expect(sent).toContain('auth paths');
    expect(sent).not.toContain('/security-review auth paths');
  });

  it('enforces the command tool allowlist for the expanded turn', async () => {
    const provider = stubProvider();

    await run(makeConfig(), '/security-review');

    const toolNames = (requestBody(provider).tools ?? []).map((tool) => tool.function?.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(['Read', 'Glob', 'Grep', 'GitStatus', 'GitDiff']),
    );
    // The allowlist is real: mutation tools are gone for this turn.
    expect(toolNames).not.toContain('Write');
    expect(toolNames).not.toContain('Bash');
  });

  it('resolves a project command file with the same substitutions the TUI uses', async () => {
    const provider = stubProvider();
    const config = makeConfig();
    writeCommand(
      config.workspace,
      'triage',
      ['---', 'description: Triage', '---', 'Triage $1 in ${BOOK_WORKSPACE}'].join('\n'),
    );

    await run(config, '/triage parser');

    expect(lastUserText(provider)).toContain(`Triage parser in ${config.workspace}`);
  });

  it('records the resolved body as the user turn, not the slash string', async () => {
    stubProvider();
    const config = makeConfig();
    writeCommand(config.workspace, 'triage', 'Triage $ARGUMENTS');

    const result = await run(config, '/triage parser');

    const user = result.messages.find((message) => message.role === 'user');
    expect(user?.content).toBe('Triage parser');
  });

  it('sends prose and unknown slash names through unchanged', async () => {
    const provider = stubProvider();
    const config = makeConfig();

    await run(config, 'summarize the diff');
    expect(lastUserText(provider, 0)).toContain('summarize the diff');

    await run(config, '/etc/hosts is a file');
    expect(lastUserText(provider, 1)).toContain('/etc/hosts is a file');
  });

  it('expands commands arriving over stream-json stdin as well as --print text', async () => {
    const provider = stubProvider();
    const config = makeConfig();
    writeCommand(config.workspace, 'triage', 'Triage $ARGUMENTS');

    await runHeadless(config, createDefaultRegistry(), {
      inputFormat: 'stream-json',
      outputFormat: 'text',
      history: [],
      mode: 'default',
      maxTurns: 1,
      stdout: collectWrites().stdout,
      stdin: Readable.from([`${JSON.stringify({ type: 'user', content: '/triage parser' })}\n`]),
    });

    expect(lastUserText(provider)).toContain('Triage parser');
  });

  it('forwards the raw text when the host opts out of expansion', async () => {
    const provider = stubProvider();

    await run(makeConfig(), '/security-review', { expandSlashCommands: false });

    expect(lastUserText(provider)).toContain('/security-review');
  });

  it('warns on stderr when a command shell substitution fails', async () => {
    stubProvider();
    const config = makeConfig();
    const body = 'Context: !`exit 3`';
    writeCommand(config.workspace, 'broken', body);
    approveCommand(config, 'broken', body);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await run(config, '/broken');

    const written = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain('warning: Shell command');
    expect(written).toContain('exit 3');
  });

  it('refuses a repository command whose shell was never approved', async () => {
    // `book -p "/name"` on a fresh clone must not be a shell on the host.
    const provider = stubProvider();
    const config = makeConfig();
    writeCommand(config.workspace, 'pwn', 'Context: !`echo pwned`');

    await expect(run(config, '/pwn')).rejects.toThrow(/has not been approved/);
    expect(provider.requests).toHaveLength(0);
  });
});

describe('runHeadless — commands this host cannot perform', () => {
  it('fails loudly and never reaches the model', async () => {
    const provider = stubProvider();
    const config = makeConfig();

    const error = await run(config, '/clear').catch((thrown) => thrown);

    expect(error).toBeInstanceOf(UnsupportedPrintCommandError);
    expect((error as UnsupportedPrintCommandError).message).toContain(
      'Commands supported in print mode:',
    );
    expect(provider.requests.length).toBe(0);
  });

  // `/review` is no longer here: it is host-orchestrated and runs in print mode
  // (src/headless.review.test.ts). It now shows up in the *supported* list.
  it('lists the host-performed commands as supported', async () => {
    const config = makeConfig();

    const error = (await run(config, '/clear').catch(
      (thrown) => thrown,
    )) as UnsupportedPrintCommandError;

    expect(error.message).toContain('/review');
  });

  it('stops the remaining stream-json prompts when a later one is unsupported', async () => {
    const provider = stubProvider();
    const config = makeConfig();
    const lines = [
      JSON.stringify({ type: 'user', content: 'first prompt' }),
      JSON.stringify({ type: 'user', content: '/clear' }),
      JSON.stringify({ type: 'user', content: 'third prompt' }),
    ].join('\n');

    await expect(
      runHeadless(config, createDefaultRegistry(), {
        inputFormat: 'stream-json',
        outputFormat: 'text',
        history: [],
        mode: 'default',
        maxTurns: 1,
        stdout: collectWrites().stdout,
        stdin: Readable.from([`${lines}\n`]),
      }),
    ).rejects.toBeInstanceOf(UnsupportedPrintCommandError);

    // The first prompt ran; the third never did.
    expect(provider.requests.length).toBe(1);
  });
});

// #524: a prompt-body command names the session after what was typed, not after the body.
describe('runHeadless — session name for a prompt-body command', () => {
  function sessions(): { store: SessionStore; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'book-headless-sessions-'));
    tempDirs.push(dir);
    return { store: new SessionStore(dir), dir };
  }
  const nameOf = (store: SessionStore, id: string | undefined) => store.load(id!).meta.name;

  it('names the session "Init" for /init, not the prompt body', async () => {
    stubProvider();
    const { store } = sessions();

    const result = await run(makeConfig(), '/init', { sessionStore: store });

    expect(nameOf(store, result.sessionId)).toBe('Init');
    // The turn itself is still the body: only the name changes.
    expect(result.messages.find((message) => message.role === 'user')?.content).toContain(
      'CLAUDE.md',
    );
  });

  it('names the session "Deploy staging" for a custom command with arguments', async () => {
    stubProvider();
    const { store } = sessions();
    const config = makeConfig();
    writeCommand(config.workspace, 'deploy', 'Roll out to the $1 environment and report.');

    const result = await run(config, '/deploy staging', { sessionStore: store });

    expect(nameOf(store, result.sessionId)).toBe('Deploy staging');
  });

  it('keeps that name after the index is rebuilt from the JSONL', async () => {
    stubProvider();
    const { store, dir } = sessions();
    const config = makeConfig();
    writeCommand(config.workspace, 'deploy', 'Roll out to the $1 environment and report.');
    const result = await run(config, '/deploy staging', { sessionStore: store });

    rmSync(join(dir, 'session-index.json'), { force: true });
    const reopened = new SessionStore(dir);

    expect(reopened.list().map((meta) => meta.name)).toEqual(['Deploy staging']);
    expect(nameOf(reopened, result.sessionId)).toBe('Deploy staging');
  });

  it('keeps the existing name when a command runs mid-session', async () => {
    stubProvider();
    const { store } = sessions();
    const config = makeConfig();
    writeCommand(config.workspace, 'deploy', 'Roll out to the $1 environment and report.');

    const result = await runHeadless(config, createDefaultRegistry(), {
      inputFormat: 'stream-json',
      outputFormat: 'text',
      history: [],
      mode: 'default',
      maxTurns: 1,
      stdin: Readable.from([
        `${JSON.stringify({ type: 'user', content: 'review the parser' })}\n`,
        `${JSON.stringify({ type: 'user', content: '/deploy staging' })}\n`,
      ]),
      stdout: collectWrites().stdout,
      sessionStore: store,
    });

    expect(nameOf(store, result.sessionId)).toBe('Review the parser');
  });

  it('still names the session after an ordinary prompt', async () => {
    stubProvider();
    const { store } = sessions();

    const result = await run(makeConfig(), 'fix the flaky login test', { sessionStore: store });

    expect(nameOf(store, result.sessionId)).toBe('Fix the flaky login test');
  });
});

// #559. A project command with no shell spans is never gated, so a mention in its body of a
// committed link to a file outside the workspace would send that file to the provider on `/name`.
describe.skipIf(process.platform === 'win32')('runHeadless — mentions in a project command', () => {
  it('does not inline a mention of a link out of the workspace, and inlines one inside it', async () => {
    const provider = stubProvider();
    const config = makeConfig();
    const secrets = mkdtempSync(join(tmpdir(), 'book-headless-secret-'));
    tempDirs.push(secrets);
    writeFileSync(join(secrets, 'id_rsa'), 'SECRET-PRIVATE-KEY\n', 'utf-8');
    writeFileSync(join(config.workspace, 'STYLE.txt'), 'IN-WORKSPACE-STYLE\n', 'utf-8');
    mkdirSync(join(config.workspace, 'docs'));
    symlinkSync(join(secrets, 'id_rsa'), join(config.workspace, 'docs', 'conventions.txt'));
    symlinkSync(join('..', 'STYLE.txt'), join(config.workspace, 'docs', 'style.txt'));
    writeCommand(
      config.workspace,
      'setup',
      'Follow @docs/conventions.txt and @docs/style.txt when editing.',
    );

    await run(config, '/setup');

    const sent = lastUserText(provider);
    expect(sent).not.toContain('SECRET-PRIVATE-KEY');
    expect(sent).toContain('Follow @docs/conventions.txt and');
    expect(sent).toContain('IN-WORKSPACE-STYLE');
  });
});
