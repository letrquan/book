#!/usr/bin/env node
/**
 * Mock OpenAI-compatible provider for driving Book without a real API key.
 *
 * Book refuses to start at all without BOOK_API_KEY (loadConfig throws), and a
 * real key costs money and makes runs non-deterministic. This server speaks the
 * subset of the OpenAI chat-completions SSE protocol that
 * src/provider/openai-compatible.ts consumes:
 *
 *   POST <base>/chat/completions  { stream: true, stream_options.include_usage }
 *     -> data: {choices:[{delta:{content|tool_calls}}]}
 *     -> data: {choices:[{finish_reason}], usage:{...}}
 *     -> data: [DONE]
 *
 * It replies with a scripted sequence of turns. Turn N is used for the Nth
 * request, and the last turn repeats forever after that.
 *
 * Usage:
 *   node mock-provider.mjs --port 8919 [--script scenario.json]
 *
 * Scenario format (array of turns):
 *   [
 *     { "text": "hello from the mock" },
 *     { "tool": { "name": "Read", "arguments": { "file_path": "/etc/hostname" } } },
 *     { "text": "done" }
 *   ]
 *
 * A turn with a `match` regex answers any request whose last message matches it
 * WITHOUT consuming a position in the sequence. That is how a scripted session
 * survives Book's own model calls landing at unpredictable indices: the
 * compaction reducer's request, for one, arrives whenever the preflight gate
 * fires. `{ "match": "BEGIN HISTORICAL EVENTS", "checkpoint": true }` answers the
 * reducer with a minimal valid ConversationCheckpointV2 whose generation is read
 * from the prompt, so compaction takes its healthy path rather than the
 * deterministic fallback.
 *
 * With no --script the server always replies with a single text turn taken from
 * --reply (default: a fixed sentence). Every request is appended as JSON to
 * book-mock-<port>.requests.jsonl in the OS temp directory (--request-log overrides
 * it) so you can assert on what Book sent.
 */
import { createServer } from 'node:http';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

const port = Number(arg('port', '8919'));
const replyText = arg('reply', 'MOCK-OK: Book reached the provider and streamed this reply.');
const scriptPath = arg('script', null);
// os.tmpdir(), not /tmp: on Windows node resolves /tmp to C:\tmp, which usually does not
// exist, and the best-effort writes below then lose every request without a word.
const requestLog = arg('request-log', join(tmpdir(), `book-mock-${port}.requests.jsonl`));

const turns = scriptPath ? JSON.parse(readFileSync(scriptPath, 'utf8')) : [{ text: replyText }];
const matchedTurns = turns.filter((turn) => typeof turn.match === 'string');
const sequenceTurns = turns.filter((turn) => typeof turn.match !== 'string');

let requestCount = 0;

// Truncate the request log so each server run starts from a clean slate.
try {
  writeFileSync(requestLog, '');
} catch {
  /* best-effort */
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/** The text of the request's last message, whether a string or content parts. */
function lastMessageText(parsed) {
  const last = parsed.messages?.at(-1);
  const content = last?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

/** A minimal checkpoint the reducer's validator accepts, for the generation the prompt asks for. */
function checkpointText(prompt) {
  const generation = Number(/generation (\d+)/.exec(prompt)?.[1] ?? '1');
  return JSON.stringify({
    version: 2,
    generation,
    state: { summary: `Mock checkpoint for generation ${generation}.`, status: 'active' },
    constraints: [],
    files: [],
    episodes: [],
    openThreads: [],
    statistics: { summarizedMessages: 0, retainedMessages: 0, preTokens: 0, postTokens: 0 },
  });
}

function streamTurn(res, turn, model, id) {
  const base = { id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {} }] };

  sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant' } }] });

  if (turn.tool) {
    // Tool arguments are streamed as a JSON string, exactly like OpenAI does.
    sse(res, {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call_mock_${id}`,
                type: 'function',
                function: {
                  name: turn.tool.name,
                  arguments: JSON.stringify(turn.tool.arguments ?? {}),
                },
              },
            ],
          },
        },
      ],
    });
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    // Chunk the text so the TUI exercises its streaming render path.
    const text = turn.text ?? replyText;
    for (const piece of text.match(/.{1,12}/gs) ?? [text]) {
      sse(res, { ...base, choices: [{ index: 0, delta: { content: piece } }] });
    }
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }

  sse(res, {
    ...base,
    choices: [],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model', object: 'model' }] }));
      return;
    }
    if (!req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end('not found');
      return;
    }

    let parsed = {};
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      /* keep the raw body in the log below */
    }

    const prompt = lastMessageText(parsed);
    const matched = matchedTurns.find((turn) => new RegExp(turn.match).test(prompt));
    let turn;
    let id;
    if (matched) {
      turn = matched.checkpoint ? { text: checkpointText(prompt) } : matched;
      id = `chatcmpl-mock-matched-${requestCount}`;
    } else {
      turn = sequenceTurns[Math.min(requestCount, sequenceTurns.length - 1)];
      id = `chatcmpl-mock-${requestCount}`;
      requestCount += 1;
    }
    try {
      appendFileSync(
        requestLog,
        JSON.stringify({ n: requestCount, matched: Boolean(matched), body: parsed }) + '\n',
      );
    } catch {
      /* logging is best-effort */
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    streamTurn(res, turn, parsed.model ?? 'mock-model', id);
  });
});

server.listen(port, '127.0.0.1', () => {
  // The driver polls for this exact line.
  console.log(`MOCK-PROVIDER-READY http://127.0.0.1:${port}/v1 (requests -> ${requestLog})`);
});
