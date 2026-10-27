export const FILE_MUTATING_TOOLS = new Set([
  'ApplyPatch',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

export function isFileMutatingTool(canonicalName: string): boolean {
  return FILE_MUTATING_TOOLS.has(canonicalName);
}

/**
 * Read-only tools that never prompt, in any mode, `dontAsk` and `plan` included: they report on
 * this session's surroundings and change nothing. `SessionList` (#620) lists the live sessions on
 * this machine. A `deny` rule still blocks one, and an `ask` rule still asks.
 */
export const UNPROMPTED_READ_TOOLS: ReadonlySet<string> = new Set(['SessionList']);

/**
 * Tools that act outside this session: `SessionSend` (#620) puts text in another session's
 * conversation. Such a tool is in no allow-set (`ALWAYS_ALLOWED_TOOLS`, `READ_ONLY_PLAN_TOOLS`, the
 * file-mutating set `accept-edits` approves), so the ordinary flow decides it (D7): it asks in
 * `default` and `accept-edits`, is hidden in `plan`, is refused in `dontAsk`, and runs unasked
 * only in the modes that run everything, `auto` and `bypassPermissions`.
 */
export const OUTWARD_FACING_TOOLS: ReadonlySet<string> = new Set(['SessionSend']);

/**
 * Tools a rule names by recipient: a call's `to` and a rule's pattern are both read as the
 * recipient's name, its ` [ref]` left out (`canonicalRecipient`), so `SessionSend(book-3f)` and
 * `SessionSend(book-3f [a1b2c3])` are one rule, and cover every spelling of that session.
 */
export const RECIPIENT_RULE_TOOLS: ReadonlySet<string> = new Set(['SessionSend']);
