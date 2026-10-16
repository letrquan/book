/**
 * Tool call ids that stay unique across the whole conversation Book sends.
 *
 * A provider can mint an id that repeats one from an earlier turn (9router's
 * `call_` + 7 digits does, eventually). Gemini answers a request that carries two
 * tool calls with one id with `400 INVALID_ARGUMENT`, and a session that persisted
 * both can never be sent again (#410). Renaming is deterministic -- no clock, no
 * randomness -- so an earlier turn re-renders byte-for-byte on every request and
 * the provider's prompt cache keeps matching.
 */
import type { Message, ProviderMessageMetadata } from '../types/messages.js';
import type { ToolCall, ToolResult } from '../types/tools.js';

/** `id` when nothing in `used` has it, else `${id}_${k}` for the smallest unused k >= 2. */
export function uniqueToolCallId(used: ReadonlySet<string>, id: string): string {
  if (!used.has(id)) return id;
  for (let k = 2; ; k++) {
    const candidate = `${id}_${k}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Every id a tool call or tool result carries in `messages` that are sent to the model. */
function collectIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (!message.includeInContext) continue;
    for (const call of message.toolCalls ?? []) ids.add(call.id);
    for (const result of message.toolResults ?? []) ids.add(result.toolCallId);
  }
  return ids;
}

/** A call's id as the provider sent it, paired with the id it is rendered under. */
export interface ToolCallIdPair {
  raw: string;
  id: string;
}

/**
 * `metadata` with its `tool_use` content blocks carrying the ids their calls were
 * rendered under (the Anthropic path replays these blocks verbatim), or `metadata`
 * itself when no block changes. `pairs` lists every call of the message in order,
 * and blocks follow the same order: the n-th block with raw id X takes the id of the
 * n-th call with raw id X, so a message that repeats an id keeps its first occurrence.
 */
export function renameToolUseBlocks(
  metadata: ProviderMessageMetadata | undefined,
  pairs: readonly ToolCallIdPair[],
): ProviderMessageMetadata | undefined {
  const blocks = metadata?.anthropicContentBlocks;
  if (!metadata || !blocks || pairs.every((pair) => pair.raw === pair.id)) return metadata;
  const queues = new Map<string, string[]>();
  for (const pair of pairs) {
    const queue = queues.get(pair.raw) ?? [];
    queue.push(pair.id);
    queues.set(pair.raw, queue);
  }
  const taken = new Map<string, number>();
  let changed = false;
  const renamed = blocks.map((block) => {
    if (block.type !== 'tool_use') return block;
    const raw = String(block.id);
    const n = taken.get(raw) ?? 0;
    taken.set(raw, n + 1);
    const next = queues.get(raw)?.[n];
    if (next === undefined || next === raw) return block;
    changed = true;
    return { ...block, id: next };
  });
  return changed ? { ...metadata, anthropicContentBlocks: renamed } : metadata;
}

/** `message` with its calls replaced by `renamedCalls` (same order), and results and blocks following. */
function applyCallRenames(message: Message, renamedCalls: readonly ToolCall[]): Message {
  const pairs = (message.toolCalls ?? []).map((call, i) => ({
    raw: call.id,
    id: renamedCalls[i].id,
  }));
  // New id for each occurrence of a raw id on this message, in call order.
  const occurrences = new Map<string, string[]>();
  for (const pair of pairs) {
    const list = occurrences.get(pair.raw) ?? [];
    list.push(pair.id);
    occurrences.set(pair.raw, list);
  }
  const consumed = new Map<string, number>();
  const toolResults = message.toolResults?.map((result): ToolResult => {
    const k = consumed.get(result.toolCallId) ?? 0;
    consumed.set(result.toolCallId, k + 1);
    const id = occurrences.get(result.toolCallId)?.[k];
    return id === undefined || id === result.toolCallId ? result : { ...result, toolCallId: id };
  });
  return {
    ...message,
    toolCalls: [...renamedCalls],
    ...(toolResults ? { toolResults } : {}),
    ...(message.providerMetadata
      ? { providerMetadata: renameToolUseBlocks(message.providerMetadata, pairs) }
      : {}),
  };
}

/**
 * `messages` as the model should see them: the first occurrence of a tool call id
 * keeps it, and every later occurrence -- with its paired result -- gets a fresh one.
 * Messages left out of context are not sent, so they neither claim an id nor are
 * renamed. Returns the input array itself when nothing needs renaming.
 */
export function dedupeToolCallIds(messages: readonly Message[]): readonly Message[] {
  const seen = new Set<string>();
  // Every id in the conversation, so a fresh one never lands on an id a later message
  // carries. Built on the first rename: a conversation with unique ids never pays for it.
  let used: Set<string> | undefined;
  let out: Message[] | undefined;
  for (const [index, message] of messages.entries()) {
    const calls = message.toolCalls;
    if (!message.includeInContext || !calls?.length) continue;
    let renamedCalls: ToolCall[] | undefined;
    for (const [i, call] of calls.entries()) {
      let id = call.id;
      if (seen.has(id)) {
        used ??= collectIds(messages);
        id = uniqueToolCallId(used, id);
        used.add(id);
        renamedCalls ??= calls.slice(0, i);
      }
      seen.add(id);
      renamedCalls?.push(id === call.id ? call : { ...call, id });
    }
    if (!renamedCalls) continue;
    out ??= [...messages];
    out[index] = applyCallRenames(message, renamedCalls);
  }
  return out ?? messages;
}

/** The tool call ids in use across `messages`, as `dedupeToolCallIds` renders them. */
export function renderedToolCallIds(messages: readonly Message[]): Set<string> {
  return collectIds(dedupeToolCallIds(messages));
}
