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
 * `--chunk-delay-ms <n>` waits n ms before every streamed delta after the role chunk (each
 * 12-character content piece, and the tool call), so a reply arrives as a paced stream the
 * TUI renders frame by frame rather than in one read. The default, 0, sends them back to back.
 * It applies to every turn, matched ones included, so it also slows the reducer's checkpoint.
 * A turn's own `"chunkDelayMs"` overrides it for that turn: a long history can arrive at once
 * while only the turn under test is paced.
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
 * A tool turn may carry `"rawArguments": "<text>"` in place of `arguments`: the
 * string is sent as the call's arguments verbatim, not JSON-encoded, so a
 * scenario can send the malformed JSON a real model sometimes emits (an
 * unescaped backslash or newline inside a string).
 *
 * With no --script the server always replies with a single text turn taken from
 * --reply (default: a fixed sentence). Every request is appended as JSON to
 * `requests.jsonl` inside a private temp directory the run creates
 * (`book-mock-<port>-XXXXXX/` in the OS temp directory) once it is listening, so
 * the log holds whole request bodies and nothing else on the machine can read or
 * replace it; the path is named on the READY line. --request-log <path> puts it
 * somewhere else instead, and is refused if it is a symbolic link. `n` is the
 * request's ordinal and `sequenceIndex` the scripted turn it was answered with
 * (absent for matches).
 *
 * A turn that is not the shape streaming expects (`{"text": 5}`) is answered with
 * a 500 naming the turn, not a crash: the mock serves the rest of the run.
 */
import { createServer } from 'node:http';
import {
  constants,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
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
const chunkDelayMs = Math.max(0, Number(arg('chunk-delay-ms', '0')) || 0);
// The log path is settled once the port is ours, so a mock that never listened
// creates nothing. `null` until then, and after a log that could not be opened:
// the run is worth more than its log.
const requestLogOverride = arg('request-log', null);
let requestLogPath = null;
let requestLogFd = null;

const turns = scriptPath ? JSON.parse(readFileSync(scriptPath, 'utf8')) : [{ text: replyText }];
const matchedTurns = turns
  .filter((turn) => typeof turn.match === 'string')
  .map((turn) => ({ ...turn, pattern: new RegExp(turn.match) }));
const sequenceTurns = turns.filter((turn) => typeof turn.match !== 'string');

/** Ordinal of the next request; only sequence turns advance the script position. */
let requestCount = 0;
let sequencePosition = 0;

/** Thrown out of a turn whose client went away (Esc aborts Book's request). */
class ClientGone extends Error {}

/**
 * Open the request log, once, and keep the descriptor.
 *
 * Every request is then appended with `writeSync` on that descriptor rather than
 * by naming the path again, so a path replaced between two requests cannot
 * redirect the log anywhere. The default lives in a private `mkdtemp` directory
 * (mode 0700 on POSIX) rather than at `<tmp>/book-mock-<port>.requests.jsonl`,
 * which is a name anyone on the machine can predict, pre-create or read — the log
 * holds whole request bodies.
 *
 * An explicit `--request-log` is truncated as it always was, but a symbolic link
 * at that path is refused outright: a link is the one way a caller can point the
 * mock's appends at a file it did not name. That refusal is fatal and happens
 * before the server serves anything, so the driver reports it at once. (The
 * `O_NOFOLLOW` on the open closes the same hole when the link appears in the
 * window between the check and the open; it does not exist on Windows.)
 */
function openRequestLog() {
  if (requestLogOverride) {
    const existing = lstatSync(requestLogOverride, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink()) {
      console.error(
        `mock-provider: refusing the request log ${requestLogOverride}: it is a symbolic link`,
      );
      process.exit(1);
    }
    try {
      writeFileSync(requestLogOverride, '');
    } catch {
      /* best-effort */
    }
    requestLogPath = requestLogOverride;
    try {
      // Numeric flags, so O_NOFOLLOW is a flag rather than the mode argument.
      requestLogFd = openSync(
        requestLogOverride,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      console.error(
        `mock-provider: cannot log requests to ${requestLogOverride}: ${error.message}`,
      );
    }
    return;
  }
  // os.tmpdir(), not /tmp: on Windows node resolves /tmp to C:\tmp, which usually does not
  // exist, and the request log would then live somewhere the run cannot write.
  try {
    requestLogPath = join(mkdtempSync(join(tmpdir(), `book-mock-${port}-`)), 'requests.jsonl');
    // 'wx': the directory is this run's own, so the log cannot already be there.
    requestLogFd = openSync(requestLogPath, 'wx', 0o600);
  } catch (error) {
    requestLogPath = null;
    console.error(`mock-provider: cannot log requests: ${error.message}`);
  }
}

/** Why a scripted turn is unusable, or null when it can be streamed. */
function turnProblem(turn) {
  if (typeof turn !== 'object' || turn === null || Array.isArray(turn)) return 'is not an object';
  if ('text' in turn && typeof turn.text !== 'string') return '`text` is not a string';
  if ('status' in turn && typeof turn.status !== 'number') return '`status` is not a number';
  for (const field of ['thinkMs', 'holdMs', 'chunkDelayMs']) {
    if (field in turn && typeof turn[field] !== 'number') return `\`${field}\` is not a number`;
  }
  const hasTools = 'tools' in turn;
  if (hasTools && !Array.isArray(turn.tools)) return '`tools` is not an array';
  const calls = hasTools ? turn.tools : 'tool' in turn ? [turn.tool] : [];
  for (const [index, call] of calls.entries()) {
    const where = hasTools ? `\`tools[${index}]\`` : '`tool`';
    if (typeof call !== 'object' || call === null || Array.isArray(call))
      return `${where} is not an object`;
    if (typeof call.name !== 'string') return `${where} has no string \`name\``;
    if ('rawArguments' in call && typeof call.rawArguments !== 'string')
      return `${where} has a \`rawArguments\` that is not a string`;
  }
  return null;
}

/**
 * Answer a turn that cannot be sent, or report one that failed while it was.
 *
 * Before the headers that is a 500 Book's own loop can classify and retry, which
 * is what a malformed scenario turn is: the scenario author's bug, on one request,
 * not a reason for the mock to die mid-run. After the headers there is no status
 * left to send, so the response is destroyed and the server carries on.
 */
function failTurn(res, which, reason) {
  const message = `mock-provider: scenario turn ${which} is malformed: ${reason}`;
  console.error(message);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: 'mock_scenario_error' } }));
}

/**
 * A pause inside a turn (`thinkMs`, `holdMs`, a paced delta) that ends early when the client
 * closes the response, so an aborted turn stops at once rather than after its whole script.
 */
function pause(res, ms) {
  return new Promise((resolve) => {
    const onClose = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      res.off('close', onClose);
      resolve();
    }, ms);
    res.once('close', onClose);
  });
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
  const delayMs = typeof turn.chunkDelayMs === 'number' ? turn.chunkDelayMs : chunkDelayMs;
  // Every write and pause checks the response: once Book closes it (Esc, a timeout), the
  // turn stops rather than writing the rest of its script into a closed socket.
  let sent = 0;
  const write = (text) => {
    if (res.destroyed) throw new ClientGone();
    res.write(text);
    sent += 1;
  };
  const send = (obj) => write(`data: ${JSON.stringify(obj)}\n\n`);
  const wait = async (ms) => {
    await pause(res, ms);
    if (res.destroyed) throw new ClientGone();
  };

  try {
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant' } }] });
    // `thinkMs` holds the turn before its first delta, the way a real model pauses
    // to think, so the working spinner is on screen long enough to be seen.
    if (turn.thinkMs) await wait(turn.thinkMs);

    // `tools: [...]` sends several calls in one turn, the way a model that
    // batches parallel reads does; `tool` is the one-call shorthand.
    const turnTools = Array.isArray(turn.tools) ? turn.tools : turn.tool ? [turn.tool] : [];
    if (turnTools.length > 0) {
      if (turn.text) {
        for (const piece of turn.text.match(/.{1,12}/gs) ?? [turn.text]) {
          if (delayMs > 0) await wait(delayMs);
          send({ ...base, choices: [{ index: 0, delta: { content: piece } }] });
        }
      }
      if (turn.holdMs) await wait(turn.holdMs);
      for (const [index, tool] of turnTools.entries()) {
        if (delayMs > 0) await wait(delayMs);
        // Tool arguments are streamed as a JSON string, exactly like OpenAI does.
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index,
                    id: `call_mock_${id}_${index}`,
                    type: 'function',
                    function: {
                      name: tool.name,
                      arguments:
                        typeof tool.rawArguments === 'string'
                          ? tool.rawArguments
                          : JSON.stringify(tool.arguments ?? {}),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      // Chunk the text so the TUI exercises its streaming render path.
      const text = substituteEvents(turn.text ?? replyText, prompt);
      for (const piece of text.match(/.{1,12}/gs) ?? [text]) {
        if (delayMs > 0) await wait(delayMs);
        send({ ...base, choices: [{ index: 0, delta: { content: piece } }] });
      }
      if (turn.holdMs) await wait(turn.holdMs);
      // `finishReason` overrides the terminal reason of a text turn: `content_filter`
      // is what Gemini's safety filter answers on ordinary code-shaped prose.
      send({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: turn.finishReason ?? 'stop' }],
      });
    }

    send({
      ...base,
      choices: [],
      // `usage` overrides the reported usage; `{prompt_tokens: 0, completion_tokens: 0}`
      // is the tell of a router that rendered an upstream error as content.
      usage:
        turn.usage ??
        (usageFromEstimate
          ? {
              prompt_tokens: estimatedTokens,
              completion_tokens: 20,
              total_tokens: estimatedTokens + 20,
            }
          : { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }),
    });
    write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    if (!(error instanceof ClientGone)) throw error;
    console.error(`mock-provider: ${id} closed by the client after ${sent} chunks; stopped`);
  }
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  // Everything a request can throw on, it throws here rather than as an uncaught
  // exception: one of those ends the process, and a mock that outlives a mistake in
  // a single scenario turn is the whole point of it.
  req.on('end', () => {
    try {
      serve(req, res, body);
    } catch (error) {
      failTurn(res, 'request', error.message);
    }
  });
});

function serve(req, res, body) {
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
    // A checkpoint turn keeps its own fields (`chunkDelayMs`, `holdMs`); only the text is made.
    turn = matched.checkpoint ? { ...matched, text: checkpointText() } : matched;
  } else if (sequenceTurns.length === 0) {
    // A script made only of `match` turns still has to answer ordinary requests.
    turn = { text: replyText };
  } else {
    sequenceIndex = Math.min(sequencePosition, sequenceTurns.length - 1);
    turn = sequenceTurns[sequenceIndex];
    sequencePosition += 1;
  }
  const id = `chatcmpl-mock-${matched ? 'matched-' : ''}${n}`;
  // How a turn is named when it goes wrong: where it sits in the script, or the
  // pattern it matched on.
  const which = matched ? `match /${turn.match}/` : `${sequenceIndex}`;
  try {
    if (requestLogFd !== null) {
      writeSync(
        requestLogFd,
        JSON.stringify({
          n,
          matched: Boolean(matched),
          sequenceIndex,
          estimatedTokens,
          overflow,
          body: parsed,
        }) + '\n',
      );
    }
  } catch {
    /* logging is best-effort */
  }

  // Checked here, before any of the reply is written: a turn a scenario mistyped
  // used to throw inside streamTurn — after the 200 was on the wire, where nothing
  // caught it, so an unhandled rejection took the whole mock down mid-run. The
  // script position has already advanced, so the next request is the next turn.
  const problem = turn && turnProblem(turn);
  if (problem) {
    failTurn(res, which, problem);
    return;
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
  // `.catch` and not `void`: a promise nobody handles that rejects takes the whole
  // process with it, and a failure after these headers can only end the response.
  streamTurn(res, turn, parsed.model ?? 'mock-model', id, prompt, estimatedTokens).catch((error) =>
    failTurn(res, which, error.message),
  );
}

// A port someone else holds is the common failure: say so in one line and exit, so the
// driver (which watches this process) fails at once with the reason.
server.on('error', (error) => {
  if (server.listening) {
    // After READY (an accept failure such as EMFILE): the driver reports the exit.
    console.error(`mock-provider: server error on 127.0.0.1:${port}: ${error.message}`);
    process.exit(1);
  }
  const reason =
    error.code === 'EADDRINUSE' ? `port ${port} is already in use (EADDRINUSE)` : error.message;
  console.error(`mock-provider: cannot listen on 127.0.0.1:${port}: ${reason}`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  // Only once the port is ours: a second mock on a taken port must not create a log
  // directory, wipe the first one's log, or exit on a path the first run is using.
  openRequestLog();
  // The driver polls for this exact line, and names the log from it.
  console.log(
    `MOCK-PROVIDER-READY http://127.0.0.1:${port}/v1 (requests -> ${requestLogPath ?? 'none'})`,
  );
});
