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
 * A turn with both `text` and `tool` streams the content deltas first and the
 * tool call after them, the way a router that inlines reasoning does — the
 * `<think></think>` a thinking model emits ahead of every tool call arrives as
 * content on the same turn, not as a turn of its own.
 *
 * `holdMs` on a turn pauses after the content deltas and before the finish, so
 * the turn stays open with its text already on the wire: the state a slow model
 * leaves the TUI in, and the only time the live (unsettled) rendering shows.
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
 * A reply's text may cite the events Book showed the reducer: `{{event:N}}` is
 * replaced with the Nth (1-based) `session://current/event/<id>` reference in
 * the request's last user message, so a scripted checkpoint can carry sources
 * the host's validator accepts even though message ids are minted at runtime.
 * A placeholder with no Nth event is left as written.
 *
 * `--usage-from-estimate` reports `prompt_tokens` as the mock's own chars/4
 * estimate of the request instead of a fixed 100, so Book's usage-triggered
 * compaction -- which reads the provider's count -- can fire against the mock.
 *
 * `--overflow-above <tokens>` makes the mock behave like a model whose real
 * window is smaller than the one Book assumes: any unmatched chat request
 * estimated (chars/4) above the number is refused with a 400 whose body Book
 * classifies as a context overflow, which exercises the loop's recovery path end
 * to end. Matched requests (the reducer's) are always answered.
 *
 * A turn may also be `{"status": 503, "body": "…"}` (answer with that HTTP status and
 * body, no stream), carry `"finishReason": "content_filter"` on a text turn, or
 * `"usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}` to
 * override the usage block — the three provider failure shapes the agent loop
 * classifies.
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
const usageFromEstimate = argv.includes('--usage-from-estimate');
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

/** `{{event:N}}` -> the Nth event reference the reducer was shown, so scripted sources resolve. */
function substituteEvents(text, prompt) {
  if (!text.includes('{{event:')) return text;
  const refs = [...prompt.matchAll(/\[event:(session:\/\/current\/event\/[^\]]+)\]/g)].map(
    (match) => match[1],
  );
  return text.replace(/\{\{event:(\d+)\}\}/g, (whole, index) => refs[Number(index) - 1] ?? whole);
}

async function streamTurn(res, turn, model, id, prompt = '', estimatedTokens = 100) {
  const base = { id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {} }] };

  sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant' } }] });

  if (turn.tool) {
    if (turn.text) {
      for (const piece of turn.text.match(/.{1,12}/gs) ?? [turn.text]) {
        sse(res, { ...base, choices: [{ index: 0, delta: { content: piece } }] });
      }
    }
    if (turn.holdMs) await new Promise((resolve) => setTimeout(resolve, turn.holdMs));
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
    const text = substituteEvents(turn.text ?? replyText, prompt);
    for (const piece of text.match(/.{1,12}/gs) ?? [text]) {
      sse(res, { ...base, choices: [{ index: 0, delta: { content: piece } }] });
    }
    if (turn.holdMs) await new Promise((resolve) => setTimeout(resolve, turn.holdMs));
    // `finishReason` overrides the terminal reason of a text turn: `content_filter`
    // is what Gemini's safety filter answers on ordinary code-shaped prose.
    sse(res, {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: turn.finishReason ?? 'stop' }],
    });
  }

  sse(res, {
    ...base,
    choices: [],
    // `usage` overrides the reported usage; `{prompt_tokens: 0, completion_tokens: 0}`
    // is the tell of a router that rendered an upstream error as content.
    usage:
      turn.usage ??
      (usageFromEstimate
        ? { prompt_tokens: estimatedTokens, completion_tokens: 20, total_tokens: estimatedTokens + 20 }
        : { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }),
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

    if (turn && typeof turn.status === 'number') {
      // An HTTP error turn: `{"status": 503, "body": "..."}` answers with that
      // status and body instead of a stream, the way a router wraps an upstream
      // failure. The next request consumes the next turn, so a retry is scripted
      // as the turn after it.
      res.writeHead(turn.status, { 'Content-Type': 'application/json' });
      res.end(typeof turn.body === 'string' ? turn.body : JSON.stringify(turn.body ?? {}));
      return;
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
    void streamTurn(res, turn, parsed.model ?? 'mock-model', id, prompt, estimatedTokens);
  });
});

server.listen(port, '127.0.0.1', () => {
  // The driver polls for this exact line.
  console.log(`MOCK-PROVIDER-READY http://127.0.0.1:${port}/v1 (requests -> ${requestLog})`);
});
