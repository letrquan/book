import type { ToolResult } from '../types/tools.js';

/**
 * Error codes only the registry and the loop produce, and only before a tool ran: an
 * unknown or inactive tool, arguments the run's allowed-tools rules do not cover,
 * arguments that never parsed, and a call cancelled before it started (an abort, or a
 * stream that ended first). A tool never returns one of these itself.
 *
 * {@link refusedBeforeRun} also reads the registry's own `preExecution` flag, which is
 * what decides the codes a tool does return — `invalid_arguments` above all, because
 * `Read {outline: true, offset}` reads the file and only then refuses the two
 * arguments, and that refusal did run the tool.
 */
const PRE_EXECUTION_ONLY_CODES: ReadonlySet<string> = new Set([
  'unknown_tool',
  'tool_not_active',
  'arguments_not_allowed',
  'invalid_json_arguments',
  'cancelled_before_start',
]);

/**
 * Did this result come from a call that never ran?
 *
 * A rejection made before the tool executes reads nothing, so it never counts as "ran":
 * for example toward memory quarantine in `toolNamesFromHistory`, or as progress for
 * the loop's no-progress witness. The codes above answer that on their own, so a
 * history written before the flag existed still reads right; a code a tool may also
 * return itself (`invalid_arguments`) is believed only when the refusal carries
 * `details.preExecution`, which every pre-execution rejection in the registry sets.
 */
export function refusedBeforeRun(result: ToolResult | undefined): boolean {
  if (!result) return false;
  if (result.structuredError?.details?.preExecution === true) return true;
  return PRE_EXECUTION_ONLY_CODES.has(result.structuredError?.code ?? '');
}
