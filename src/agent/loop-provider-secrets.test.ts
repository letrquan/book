import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentLoop } from './loop.js';
import { createDefaultRegistry } from '../tools/registry.js';
import { PROVIDER_KEY_MARKER } from '../provider-secrets.js';
import { TOOL_RESULT_MAX_BYTES } from '../tools/result.js';
import { defaultConfig } from '../test/fixtures.js';
import { removeWhenReleased } from '../test/remove-when-released.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import type { Provider } from '../provider/index.js';
import type { Message } from '../types/messages.js';
import type { ToolResult } from '../types/tools.js';

/**
 * #411: a provider key a command prints must not reach the model, the persisted session or the
 * `tool-output/` spill file. The Bash children keep inheriting `BOOK_API_KEY`; only what Book
 * records is redacted.
 */

const KEY = 'sk-live-0123456789abcdef';

let workspace: string;
let toolOutputRoot: string;
const origKey = process.env.BOOK_API_KEY;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-loop-secrets-'));
  toolOutputRoot = mkdtempSync(join(tmpdir(), 'book-loop-secrets-out-'));
});

afterEach(async () => {
  if (origKey === undefined) delete process.env.BOOK_API_KEY;
  else process.env.BOOK_API_KEY = origKey;
  await removeWhenReleased(workspace);
  await removeWhenReleased(toolOutputRoot);
});

function callbacks(overrides: Partial<AgentLoopCallbacks> = {}): AgentLoopCallbacks {
  return {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onError: () => {},
    onTurnStart: () => {},
    onDone: () => {},
    onPermissionRequired: async () => 'allow' as const,
    ...overrides,
  };
}

/** Everything one Bash call leaves behind, serialized so a key anywhere shows up. */
interface Observed {
  /** What the second provider request carried: the model's whole view of the result. */
  sentToModel: string;
  /** The results the host receives and the messages it persists. */
  persisted: string;
  results: ToolResult[];
  /** Every file written under `tool-output/`. */
  spills: string[];
}

/** A script whose body is `body`, run through the real Bash tool under the real loop. */
async function runBash(
  body: string,
  config = defaultConfig({ workspace, maxTurns: 3 }),
): Promise<Observed> {
  const script = join(workspace, 'emit.cjs');
  writeFileSync(script, body);
  const command = `"${process.execPath}" "${script}"`;
  let turn = 0;
  let secondRequest = '';
  const provider: Provider = {
    id: 'scripted',
    stream: async function* (_config, messages) {
      turn++;
      if (turn === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 'bash-1', name: 'Bash', arguments: { command } },
        };
      } else {
        secondRequest = JSON.stringify(messages);
        yield { type: 'text', content: 'done' };
      }
      yield { type: 'done' };
    },
  };
  const results: ToolResult[] = [];
  const completed: Message[] = [];
  const history = await runAgentLoop(
    config,
    createDefaultRegistry(),
    'run it',
    [],
    callbacks({
      onToolResult: (result) => results.push(result),
      onAssistantMessageComplete: (message) => completed.push(message),
    }),
    'bypassPermissions',
    { provider, isNewSession: false, toolOutputRoot },
  );
  const spills = readdirSync(toolOutputRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'));
  return {
    sentToModel: secondRequest,
    persisted: JSON.stringify({ history, completed, results }),
    results,
    spills,
  };
}

/** key, filler that straddles the preview cut with a second key inside it, filler, key. */
function bigOutputScript(key: string, tail: string): string {
  const keyLiteral = JSON.stringify(key);
  return [
    `const key = ${keyLiteral};`,
    `process.stdout.write('first=' + key + '\\n');`,
    `process.stdout.write('a'.repeat(${TOOL_RESULT_MAX_BYTES} - 20) + key + 'b'.repeat(2000) + '\\n');`,
    `process.stdout.write('last=' + key + '\\n');`,
    tail,
  ].join('\n');
}

function expectClean(observed: Observed, key: string): void {
  expect(observed.sentToModel).not.toContain(key);
  expect(observed.persisted).not.toContain(key);
  for (const spill of observed.spills) expect(spill).not.toContain(key);
}

describe('runAgentLoop — provider keys are redacted from tool output (#411)', () => {
  it('redacts a key configured as a literal provider apiKey, including in the spill file', async () => {
    const config = defaultConfig({ workspace, maxTurns: 3 });
    config.settings.provider.work = {
      type: 'openai',
      baseURL: 'http://x/v1',
      models: {},
      apiKey: KEY,
    };

    const observed = await runBash(bigOutputScript(KEY, ''), config);

    expectClean(observed, KEY);
    // The output really was clipped and spilled, with the marker on both sides of the cut.
    expect(observed.spills).toHaveLength(1);
    expect(observed.sentToModel).toContain('first=' + PROVIDER_KEY_MARKER);
    expect(observed.spills[0]).toContain('first=' + PROVIDER_KEY_MARKER);
    expect(observed.spills[0]).toContain('last=' + PROVIDER_KEY_MARKER);
    expect(observed.spills[0].split(PROVIDER_KEY_MARKER)).toHaveLength(4);
    // `details` is derived from the same clean text.
    const details = observed.results[0].presentation?.details ?? '';
    expect(details).not.toContain(KEY);
  });

  it('redacts the BOOK_API_KEY value a Bash child inherits', async () => {
    process.env.BOOK_API_KEY = KEY;
    const config = defaultConfig({ workspace, maxTurns: 3 });
    const body = [
      `const key = process.env.BOOK_API_KEY ?? '';`,
      `console.log('k=' + key);`,
      `process.stdout.write('a'.repeat(${TOOL_RESULT_MAX_BYTES} * 2) + '\\n');`,
      `console.log('k2=' + key);`,
    ].join('\n');

    const observed = await runBash(body, config);

    // The child still received the key (environment inheritance is unchanged): it printed it.
    expect(observed.spills).toHaveLength(1);
    expect(observed.spills[0]).toContain(`k=${PROVIDER_KEY_MARKER}`);
    expect(observed.spills[0]).toContain(`k2=${PROVIDER_KEY_MARKER}`);
    expectClean(observed, KEY);
  });

  it('redacts a key from a failing command: message, head/tail preview and spill file', async () => {
    const config = defaultConfig({ workspace, maxTurns: 3 });
    config.settings.provider.work = {
      type: 'openai',
      baseURL: 'http://x/v1',
      models: {},
      apiKey: KEY,
    };
    const body = bigOutputScript(
      KEY,
      `process.stderr.write('stderr=' + key + '\\n');\nprocess.exit(1);`,
    );

    const observed = await runBash(body, config);

    expect(observed.results[0].status).not.toBe('success');
    expectClean(observed, KEY);
    expect(observed.sentToModel).toContain(PROVIDER_KEY_MARKER);
    expect(observed.spills.join('\n')).toContain(PROVIDER_KEY_MARKER);
  });

  it('redacts a key from a small failing command', async () => {
    process.env.BOOK_API_KEY = KEY;
    const body = `console.error('boom ' + process.env.BOOK_API_KEY);\nprocess.exit(1);`;

    const observed = await runBash(body);

    expect(observed.results[0].status).not.toBe('success');
    expectClean(observed, KEY);
    expect(observed.sentToModel).toContain(`boom ${PROVIDER_KEY_MARKER}`);
  });

  it('leaves a configured key shorter than 8 characters alone', async () => {
    const short = 'sevenk7';
    const config = defaultConfig({ workspace, maxTurns: 3, apiKey: short });
    config.settings.provider.work = {
      type: 'openai',
      baseURL: 'http://x/v1',
      models: {},
      apiKey: short,
    };

    const observed = await runBash(`console.log('value=${short}');`, config);

    expect(observed.sentToModel).toContain(`value=${short}`);
    expect(observed.sentToModel).not.toContain(PROVIDER_KEY_MARKER);
  });
});
