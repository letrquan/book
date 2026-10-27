/**
 * Real-API probe for stable tools on Anthropic (#619). Three requests, back to back, through
 * Book's own catalog, message builder and Anthropic client, with one activation between the
 * first and the second:
 *
 *   1. every authorized tool declared, the deferred ones with `defer_loading`, no beta header;
 *   2. the host loads GitLog; the request ends with a `role: "system"` message carrying a
 *      `tool_addition` for it, and sends `anthropic-beta: mid-conversation-tool-changes-2026-07-01`;
 *   3. the addition is sent again where it was, before the reply to request 2.
 *
 * It prints, per request, whether the beta header went out, a hash of `tools[]`, and the usage
 * cache fields, then checks that `tools[]` never changed, that request 2 read back everything
 * request 1 wrote (the activation kept the cache), and that request 3 read past the tools, through
 * request 2's messages. Request 3 also asks the model whether it now has GitLog.
 *
 * The key comes from BOOK_PROBE_ANTHROPIC_API_KEY only, and is never printed. Nothing reads
 * ~/.book: the config is built here, BOOK_HOME points at a throwaway directory, and the
 * workspace is an empty temp directory. It costs three short requests (roughly 10–20k cached
 * prompt tokens on the first) on the chosen model.
 *
 * Usage:
 *   BOOK_PROBE_ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/probe-stable-tools.ts [--model claude-opus-5-5]
 *
 * Exit status: 0 when every check passes, 1 when one fails, 2 when the probe could not decide
 * (a request failed, or the prefix was too short to cache).
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, ProviderMessageMetadata, Usage } from '../src/types/messages.js';
import type { AgentConfig } from '../src/types/runtime.js';
import type { ToolContext } from '../src/types/tools.js';

const KEY_VARIABLE = 'BOOK_PROBE_ANTHROPIC_API_KEY';
const BASE_URL = 'https://api.anthropic.com';
const BETA = 'mid-conversation-tool-changes-2026-07-01';

interface Captured {
  beta: string | undefined;
  toolsHash: string;
  toolCount: number;
  deferredCount: number;
  roles: string[];
}

interface Turn {
  captured: Captured;
  usage: Usage | undefined;
  text: string;
  error?: string;
  metadata?: ProviderMessageMetadata;
}

function parseModel(argv: string[]): string {
  const index = argv.indexOf('--model');
  return index >= 0 && argv[index + 1] ? argv[index + 1]! : 'claude-opus-5-5';
}

async function main(): Promise<number> {
  const apiKey = process.env[KEY_VARIABLE];
  if (!apiKey) {
    console.error(`Set ${KEY_VARIABLE} to an Anthropic API key. It is read from there only.`);
    return 2;
  }
  const model = parseModel(process.argv.slice(2));
  const bookHome = await mkdtemp(join(tmpdir(), 'book-probe-home-'));
  const workspace = await mkdtemp(join(tmpdir(), 'book-probe-workspace-'));
  // Before any Book module loads, so nothing can resolve the real home.
  process.env.BOOK_HOME = bookHome;
  try {
    return await probe(model, apiKey, workspace);
  } finally {
    await rm(bookHome, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

async function probe(model: string, apiKey: string, workspace: string): Promise<number> {
  const { DEFAULT_SETTINGS } = await import('../src/settings.js');
  const { createToolSurface } = await import('../src/tools/catalog.js');
  const { createDefaultRegistry } = await import('../src/tools/registry.js');
  const { buildMessages } = await import('../src/agent/context.js');
  const { chatCompletionStream } = await import('../src/provider/anthropic.js');
  const { keepsToolsStable } = await import('../src/provider/port.js');

  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.observability.toolTelemetry = false;
  const config: AgentConfig = {
    apiKey,
    baseUrl: BASE_URL,
    provider: 'anthropic',
    model,
    maxTurns: 3,
    maxTokens: 2048,
    compactStrategy: settings.compactStrategy,
    autoCompactEnabled: false,
    workspace,
    animation: { typewriterSpeed: 0, spinnerStyle: 'dots' },
    accessibility: { screenReader: false, reducedMotion: false },
    settings,
    retry: {
      maxAttempts: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      totalBudgetMs: 0,
      requestTimeoutMs: 120_000,
      streamStallTimeoutMs: 120_000,
      toolRetries: 0,
      watchdog: false,
    },
  };
  const context: ToolContext = {
    workspaceRoot: workspace,
    env: {},
    currentMode: 'default',
    backgroundShells: { nextId: 1, shells: new Map() },
  };
  const surface = createToolSurface({
    config,
    context,
    definitions: createDefaultRegistry().getDefinitions(),
  });
  console.log(`model ${model}; Book would keep tools stable here: ${keepsToolsStable(config)}`);

  // Capture what goes on the wire: the beta header and the request's shape, never the key.
  const realFetch = globalThis.fetch;
  let captured: Captured | undefined;
  globalThis.fetch = async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = JSON.parse(String(init?.body)) as {
      tools?: Array<{ defer_loading?: boolean }>;
      messages: Array<{ role: string }>;
    };
    captured = {
      beta: headers['anthropic-beta'],
      toolsHash: createHash('sha256')
        .update(JSON.stringify(body.tools ?? []))
        .digest('hex')
        .slice(0, 16),
      toolCount: body.tools?.length ?? 0,
      deferredCount: body.tools?.filter((tool) => tool.defer_loading).length ?? 0,
      roles: body.messages.map((message) => message.role),
    };
    return realFetch(input, init);
  };

  const history: Message[] = [];
  const turns: Turn[] = [];
  const ask = async (text: string): Promise<Turn> => {
    history.push({
      id: `user-${history.length}`,
      role: 'user',
      content: text,
      includeInContext: true,
      timestamp: Date.now(),
    });
    const request = surface.prepareRequest(history, { stable: true });
    const messages = await buildMessages(config, history, [], undefined, undefined, {
      toolCatalogSummary: surface.catalogSummary(),
    });
    let answer = '';
    let usage: Usage | undefined;
    let metadata: ProviderMessageMetadata | undefined;
    let error: string | undefined;
    for await (const event of chatCompletionStream(config, messages, request.tools, {
      toolAdditions: request.additions,
    })) {
      if (event.type === 'text') answer += event.content ?? '';
      if (event.type === 'error') error = `${event.errorCode ?? 'error'}: ${event.error}`;
      if (event.type === 'done') {
        usage = event.usage;
        metadata = event.providerMetadata;
        surface.markAnswered();
      }
    }
    history.push({
      id: `assistant-${history.length}`,
      role: 'assistant',
      content: answer,
      providerMetadata: metadata,
      includeInContext: true,
      timestamp: Date.now(),
    });
    const turn: Turn = { captured: captured!, usage, text: answer.trim(), error, metadata };
    turns.push(turn);
    return turn;
  };

  try {
    await ask('Probe request 1 of 3. Reply with the single word ONE. Do not call any tool.');
    if (!turns[0]!.error) {
      // The activation: a host load, as a skill resource or a routed intent makes one.
      const loaded = surface.activate(['GitLog'], 'host');
      if (!loaded.includes('GitLog')) throw new Error('GitLog did not load');
      await ask('Probe request 2 of 3. Reply with the single word TWO. Do not call any tool.');
    }
    if (turns[1] && !turns[1].error) {
      await ask(
        'Probe request 3 of 3. Without calling it, answer YES if a tool named GitLog is available to you now, otherwise NO.',
      );
    }
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log('');
  for (const [index, turn] of turns.entries()) {
    const usage = turn.usage;
    console.log(
      [
        `request ${index + 1}:`,
        `beta=${turn.captured.beta ?? '-'}`,
        `tools=${turn.captured.toolCount} (${turn.captured.deferredCount} deferred) sha256:${turn.captured.toolsHash}`,
        `roles=${turn.captured.roles.join(',')}`,
      ].join(' '),
    );
    if (turn.error) {
      console.log(`  error: ${turn.error}`);
      continue;
    }
    console.log(
      `  input_tokens=${usage?.promptTokens ?? '?'} cache_creation_input_tokens=${usage?.cacheCreationInputTokens ?? '?'} cache_read_input_tokens=${usage?.cacheReadInputTokens ?? '?'}`,
    );
    console.log(`  reply: ${JSON.stringify(turn.text.slice(0, 80))}`);
    if (turn.metadata?.toolAdditions) {
      console.log(`  recorded additions: ${turn.metadata.toolAdditions.join(',')}`);
    }
  }
  console.log('');

  if (turns.length < 3 || turns.some((turn) => turn.error || !turn.usage)) {
    console.log('INCONCLUSIVE: a request failed; see its error above.');
    return 2;
  }
  const [first, second, third] = turns as [Turn, Turn, Turn];
  const written = (turn: Turn) =>
    (turn.usage!.cacheCreationInputTokens ?? 0) + (turn.usage!.cacheReadInputTokens ?? 0);
  if ((first.usage!.cacheCreationInputTokens ?? 0) === 0) {
    console.log('INCONCLUSIVE: request 1 wrote no cache (the prefix is below the minimum).');
    return 2;
  }
  const checks: Array<[string, boolean]> = [
    [
      'tools[] is byte-identical on all three requests',
      new Set(turns.map((turn) => turn.captured.toolsHash)).size === 1,
    ],
    ['request 1 declares deferred tools', first.captured.deferredCount > 0],
    ['request 1 sends no beta header', first.captured.beta === undefined],
    [
      'request 2 ends with the addition and sends the beta',
      second.captured.beta === BETA && second.captured.roles.at(-1) === 'system',
    ],
    [
      'request 3 sends the addition again, before the reply to request 2, with the beta',
      third.captured.beta === BETA &&
        third.captured.roles.join(',') === 'user,assistant,user,system,assistant,user',
    ],
    [
      `request 2 read back everything request 1 cached (${second.usage!.cacheReadInputTokens ?? 0} >= ${written(first)})`,
      (second.usage!.cacheReadInputTokens ?? 0) >= written(first),
    ],
    [
      `request 3 read past the tools, through request 2's messages (${third.usage!.cacheReadInputTokens ?? 0} >= ${written(second)})`,
      (third.usage!.cacheReadInputTokens ?? 0) >= written(second),
    ],
  ];
  for (const [label, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'} ${label}`);
  console.log(
    `INFO the model answered ${JSON.stringify(third.text.slice(0, 40))} to whether GitLog is available (YES expected)`,
  );
  return checks.every(([, passed]) => passed) ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  },
);
