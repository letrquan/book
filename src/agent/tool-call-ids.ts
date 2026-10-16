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

/**
 * `metadata` with the `tool_use` content blocks of renamed calls carrying their new
 * id (the Anthropic path replays these blocks verbatim), or `metadata` itself when
 * no block is affected.
 */
export function renameToolUseBlocks(
  metadata: ProviderMessageMetadata | undefined,
  renames: ReadonlyMap<string, string>,
): ProviderMessageMetadata | undefined {
  const blocks = metadata?.anthropicContentBlocks;
  if (!metadata || !blocks || renames.size === 0) return metadata;
  let changed = false;
  const renamed = blocks.map((block) => {
    const next = block.type === 'tool_use' ? renames.get(String(block.id)) : undefined;
    if (next === undefined) return block;
    changed = true;
    return { ...block, id: next };
  });
  return changed ? { ...metadata, anthropicContentBlocks: renamed } : metadata;
}

function renameMessage(message: Message, used: Set<string>, seen: Set<string>): Message {
  const calls = message.toolCalls;
  if (!calls?.length) return message;

  // New id for each occurrence of a raw id on this message, in call order.
  const occurrences = new Map<string, string[]>();
  const renames = new Map<string, string>();
  const renamedCalls: ToolCall[] = calls.map((call) => {
    let id = call.id;
    if (seen.has(id)) {
      id = uniqueToolCallId(used, id);
      used.add(id);
      renames.set(call.id, id);
    }
    seen.add(id);
    const list = occurrences.get(call.id) ?? [];
    list.push(id);
    occurrences.set(call.id, list);
    return id === call.id ? call : { ...call, id };
  });
  if (renames.size === 0) return message;

  const consumed = new Map<string, number>();
  const toolResults = message.toolResults?.map((result): ToolResult => {
    const list = occurrences.get(result.toolCallId);
    const k = consumed.get(result.toolCallId) ?? 0;
    consumed.set(result.toolCallId, k + 1);
    const id = list?.[k];
    return id === undefined || id === result.toolCallId ? result : { ...result, toolCallId: id };
  });
  return {
    ...message,
    toolCalls: renamedCalls,
    ...(toolResults ? { toolResults } : {}),
    ...(message.providerMetadata
      ? { providerMetadata: renameToolUseBlocks(message.providerMetadata, renames) }
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
  let used: Set<string> | undefined;
  let out: Message[] | undefined;
  for (const [index, message] of messages.entries()) {
    if (!message.includeInContext || !message.toolCalls?.length) continue;
    const calls = message.toolCalls;
    // Common path: a message whose ids are all new claims them and moves on.
    const clashes = calls.some(
      (call, i) => seen.has(call.id) || calls.findIndex((other) => other.id === call.id) !== i,
    );
    if (!clashes) {
      for (const call of calls) seen.add(call.id);
      continue;
    }
    used ??= collectIds(messages);
    const renamed = renameMessage(message, used, seen);
    if (renamed === message) continue;
    out ??= [...messages];
    out[index] = renamed;
  }
  return out ?? messages;
}

/** The tool call ids in use across `messages`, as `dedupeToolCallIds` renders them. */
export function renderedToolCallIds(messages: readonly Message[]): Set<string> {
  return collectIds(dedupeToolCallIds(messages));
}
