import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  TOOL_EVAL_TASKS,
  type ScriptedCall,
  type ToolEvalFixture,
  type ToolEvalTask,
} from './tool-discovery-eval-tasks.js';

/**
 * The scripted models of `npm run eval:tools -- --mock`: an OpenAI-compatible endpoint whose every
 * reply is decided from the request alone, the tools it declares and the results it carries. That
 * is what makes the mock a measurement: an arm that declares a tool earlier, or admits a direct
 * call, changes what Book sends, and the scripted model answers what Book sent. (The run-book mock
 * provider replays a fixed sequence, so it cannot react to the tools array.)
 *
 * - `weak` never searches: it calls the task's tool when the request declares it, and otherwise
 *   works around it with `curl`, `git log` or a hand-written file.
 * - `naive` calls the task's tool by name whether or not it is declared, and loads it with
 *   `select:` when Book refuses it as not active.
 * - `searching` calls the tool when it is declared, and otherwise searches for it first.
 */

export const MOCK_POLICIES = ['weak', 'naive', 'searching'] as const;
export type MockPolicy = (typeof MOCK_POLICIES)[number];

/** The scripted model's id: the policy and the task, so the user's text never names the script. */
export const mockModelId = (policy: MockPolicy, task: string): string => `${policy}.${task}`;

interface ChatToolCall {
  id: string;
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatRequest {
  model?: string;
  messages?: ChatMessage[];
  tools?: Array<{ function?: { name?: string } }>;
}

export type MockReply = { text: string } | { calls: ScriptedCall[] };

const text = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part as { text?: string }).text ?? '').join('')
      : '';

const failed = (output: string): boolean => /(^|\n)ERROR \[/.test(output);

/** The scripted final answer: the first codename a tool's output holds. */
function answerFrom(output: string): string {
  const codename = /\b[A-Z]{3,}-\d{4}\b/.exec(output)?.[0];
  return codename ? `The codename is ${codename}.` : 'Done.';
}

/** The scripted model's next reply to `request`. */
export function mockReply(
  policy: MockPolicy,
  task: ToolEvalTask,
  fixture: ToolEvalFixture,
  request: ChatRequest,
): MockReply {
  const declared = new Set((request.tools ?? []).map((tool) => tool.function?.name));
  const messages = request.messages ?? [];
  let lastAssistant = messages.length - 1;
  while (lastAssistant >= 0 && messages[lastAssistant].role !== 'assistant') lastAssistant--;
  const target = task.script.target(fixture);
  if (lastAssistant === -1 || !messages[lastAssistant].tool_calls?.length) {
    const prelude = task.script.prelude ?? [];
    if (declared.has(task.target) || policy === 'naive') return { calls: [...prelude, target] };
    if (policy === 'searching') {
      return {
        calls: [...prelude, { name: 'ToolSearch', arguments: { query: task.script.searchQuery } }],
      };
    }
    return { calls: [...prelude, ...task.script.fallback(fixture)] };
  }
  const calls = messages[lastAssistant].tool_calls!.map((call) => ({
    name: call.function.name,
    output: text(
      messages.find((message) => message.role === 'tool' && message.tool_call_id === call.id)
        ?.content,
    ),
  }));
  const targetCall = calls.find((call) => call.name === task.target);
  if (targetCall?.output.includes('ERROR [tool_not_active]')) {
    return { calls: [{ name: 'ToolSearch', arguments: { query: `select:${task.target}` } }] };
  }
  if (targetCall)
    return { text: failed(targetCall.output) ? 'Done.' : answerFrom(targetCall.output) };
  const search = calls.find((call) => call.name === 'ToolSearch');
  if (search) {
    const found =
      !failed(search.output) &&
      search.output.includes(task.target) &&
      !search.output.startsWith('No ');
    return { calls: found ? [target] : task.script.fallback(fixture) };
  }
  // The way around the tool ran: answer from what it returned.
  return { text: answerFrom(calls.map((call) => call.output).join('\n')) };
}

/**
 * Prompt caching as Anthropic does it, approximately: a request reads from the cache every leading
 * segment (the tools array, then each message, system first) that the conversation's previous
 * request sent identically, and writes the rest. A tool activation changes the first segment, so
 * the request after it reads nothing. Returns the cached characters.
 */
export function cachedPrefixChars(
  previous: readonly string[] | undefined,
  current: string[],
): number {
  let cached = 0;
  for (const [index, segment] of current.entries()) {
    if (previous?.[index] !== segment) break;
    cached += segment.length;
  }
  return cached;
}

/** The request's segments in cache order: the tools array, then each message. */
export function requestSegments(request: ChatRequest): string[] {
  return [
    JSON.stringify(request.tools ?? []),
    ...(request.messages ?? []).map((m) => JSON.stringify(m)),
  ];
}

const tokensOf = (chars: number): number => Math.ceil(chars / 4);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function streamReply(
  res: ServerResponse,
  id: string,
  model: string,
  reply: MockReply,
  usage: object,
) {
  const base = { id, object: 'chat.completion.chunk', created: 0, model };
  const send = (chunk: object) => res.write(`data: ${JSON.stringify({ ...base, ...chunk })}\n\n`);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  send({ choices: [{ index: 0, delta: { role: 'assistant' } }] });
  if ('text' in reply) {
    send({ choices: [{ index: 0, delta: { content: reply.text } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  } else {
    reply.calls.forEach((call, index) =>
      send({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: `call_${id}_${index}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                },
              ],
            },
          },
        ],
      }),
    );
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  }
  send({ choices: [], usage });
  res.write('data: [DONE]\n\n');
  res.end();
}

export interface MockProvider {
  baseUrl: string;
  close(): Promise<void>;
}

/** Serve the scripted models on 127.0.0.1:`port` (0 takes any free port). */
export async function startMockProvider(
  port: number,
  fixture: ToolEvalFixture,
): Promise<MockProvider> {
  // The previous request's segments, per conversation (keyed by its first user message; the
  // harness runs one conversation at a time).
  const conversations = new Map<string, string[]>();
  let requests = 0;
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end('not found');
        return;
      }
      const request = JSON.parse(await readBody(req)) as ChatRequest;
      const model = request.model ?? '';
      const [policy, taskName] = model.split('.') as [MockPolicy, string];
      const task = TOOL_EVAL_TASKS.find((candidate) => candidate.name === taskName);
      if (!MOCK_POLICIES.includes(policy) || !task) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `unknown scripted model "${model}"` } }));
        return;
      }
      const reply = mockReply(policy, task, fixture, request);
      const segments = requestSegments(request);
      const key = text(request.messages?.find((message) => message.role === 'user')?.content);
      const promptChars = segments.reduce((total, segment) => total + segment.length, 0);
      // A conversation's first request reads nothing: the same task ran before, but in another run.
      const opening = !request.messages?.some((message) => message.role === 'assistant');
      const cachedChars = cachedPrefixChars(opening ? undefined : conversations.get(key), segments);
      conversations.set(key, segments);
      const promptTokens = tokensOf(promptChars);
      const completionTokens = tokensOf(JSON.stringify(reply).length);
      streamReply(res, `eval-${++requests}`, model, reply, {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: Math.min(promptTokens, tokensOf(cachedChars)) },
      });
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const { port: bound } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${bound}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
