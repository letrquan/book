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
 * A turn with a `match` regex answers any request whose last USER message
 * matches it WITHOUT consuming a position in the sequence. That is how a
 * scripted session survives Book's own model calls landing at unpredictable
 * indices: the compaction reducer's request, for one, arrives whenever the
 * preflight gate fires. `{ "match": "BEGIN HISTORICAL EVENTS", "checkpoint": true }`
 * answers the reducer with a minimal valid ConversationCheckpointV2 (the host
 * overwrites its generation), so compaction takes its healthy path rather than
 * the deterministic fallback. Only a user-role last message is matched: after a
 * tool call the last message is the tool result, and a Read of a file that
 * happens to contain the marker must not hijack the main agent's turn. Patterns
 * are compiled at load, so an invalid one fails before READY.
 *
 * `--overflow-above <tokens>` makes the mock behave like a model whose real
 * window is smaller than the one Book assumes: any unmatched chat request
 * estimated (chars/4) above the number is refused with a 400 whose body Book
 * classifies as a context overflow, which exercises the loop's recovery path end
 * to end. Matched requests (the reducer's) are always answered.
 *
 * With no --script the server always replies with a single text turn taken from
 * --reply (default: a fixed sentence). Every request is appended as JSON to
 * book-mock-<port>.requests.jsonl in the OS temp directory (--request-log overrides
 * it) so you can assert on what Book sent; `n` is the request's ordinal and
 * `sequenceIndex` the scripted turn it was answered with (absent for matches).
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
const overflowAbove = Number(arg('overflow-above', '0'));
// os.tmpdir(), not /tmp: on Windows node resolves /tmp to C:\tmp, which usually does not
// exist, and the best-effort writes below then lose every request without a word.
const requestLog = arg('request-log', join(tmpdir(), `book-mock-${port}.requests.jsonl`));

const turns = scriptPath ? JSON.parse(readFileSync(scriptPath, 'utf8')) : [{ text: replyText }];
const matchedTurns = turns
  .filter((turn) => typeof turn.match === 'string')
  .map((turn) => ({ ...turn, pattern: new RegExp(turn.match) }));
const sequenceTurns = turns.filter((turn) => typeof turn.match !== 'string');

/** Ordinal of the next request; only sequence turns advance the script position. */
let requestCount = 0;
let sequencePosition = 0;

// Truncate the request log so each server run starts from a clean slate.
try {
  writeFileSync(requestLog, '');
} catch {
  /* best-effort */
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/** The text of the request's last message when it is a user turn; '' for any other role. */
function lastUserMessageText(parsed) {
  const last = parsed.messages?.at(-1);
  if (last?.role !== 'user') return '';
  const content = last.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

/** Rough size of a chat request, the same chars/4 rule Book's own estimator uses. */
function estimateRequestTokens(parsed) {
  return Math.ceil(JSON.stringify(parsed.messages ?? []).length / 4);
}

/** A minimal checkpoint the reducer's validator accepts; the host sets the generation itself. */
function checkpointText() {
  return JSON.stringify({
    version: 2,
    generation: 1,
    state: { summary: 'Mock checkpoint.', status: 'active' },
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

    const n = requestCount;
    requestCount += 1;
    const estimatedTokens = estimateRequestTokens(parsed);
    const prompt = lastUserMessageText(parsed);
    const matched = matchedTurns.find((turn) => turn.pattern.test(prompt));
    // A matched request (the reducer's, in practice) is never refused: the
    // reducer may run on another model, and what the probe is after is the
    // agent's own request being rejected and the recovery that follows.
    const overflow = !matched && overflowAbove > 0 && estimatedTokens > overflowAbove;
    let sequenceIndex;
    let turn;
    if (overflow) {
      turn = undefined;
    } else if (matched) {
      turn = matched.checkpoint ? { text: checkpointText() } : matched;
    } else if (sequenceTurns.length === 0) {
      // A script made only of `match` turns still has to answer ordinary requests.
      turn = { text: replyText };
    } else {
      sequenceIndex = Math.min(sequencePosition, sequenceTurns.length - 1);
      turn = sequenceTurns[sequenceIndex];
      sequencePosition += 1;
    }
    const id = `chatcmpl-mock-${matched ? 'matched-' : ''}${n}`;
    try {
      appendFileSync(
        requestLog,
        JSON.stringify({
          n,
          matched: Boolean(matched),
          sequenceIndex,
          estimatedTokens,
          overflow,
          body: parsed,
        }) + '\n',
      );
    } catch {
      /* logging is best-effort */
    }

    if (overflow) {
      // The shape OpenAI uses; Book's classifier keys on the message text.
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: `This model's maximum context length is ${overflowAbove} tokens. However, your messages resulted in ${estimatedTokens} tokens. Please reduce the length of the messages.`,
            type: 'invalid_request_error',
            code: 'context_length_exceeded',
          },
        }),
      );
      return;
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
