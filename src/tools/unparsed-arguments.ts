import type { ToolCall } from '../types/tools.js';

/**
 * The key both provider clients used to wrap tool-call arguments in when they were
 * not valid JSON: `{ __raw: "<text>" }` (`parseToolArguments` in
 * provider/openai-compatible.ts and provider/anthropic.ts).
 *
 * It survives in two places and is never written again: on the Anthropic wire, where
 * `tool_use.input` must be an object and so cannot carry unparseable text verbatim,
 * and in sessions persisted before `ToolCall.unparsedArguments` existed.
 */
export const RAW_ARGUMENTS_KEY = '__raw';

/**
 * The argument text of a call that never parsed, or `undefined` when it did.
 *
 * The typed field is the only source a new call has. A `{ __raw: "<text>" }`
 * arguments object is read only when it is exactly the sentinel — one key, a string
 * value, and text `JSON.parse` still rejects — because `{ __raw: "{...}" }` is a
 * literal argument the model meant to send and the schema is there to judge it.
 */
export function unparsedArgumentsText(call: ToolCall): string | undefined {
  if (call.unparsedArguments) return call.unparsedArguments.raw;
  // `?? {}`: a session persisted before `arguments` was always a field can load a tool
  // call without one, and the replay path in agent/context.ts reads this on every
  // assistant tool call.
  const args = call.arguments ?? {};
  if (Object.keys(args).length !== 1) return undefined;
  const raw = args[RAW_ARGUMENTS_KEY];
  if (typeof raw !== 'string') return undefined;
  try {
    JSON.parse(raw);
    return undefined;
  } catch {
    return raw;
  }
}
