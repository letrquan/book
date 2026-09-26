/**
 * Error codes of tool results refused before the tool ran: an unknown or inactive tool, arguments
 * the run's allowed-tools rules do not cover, arguments that failed validation or never parsed,
 * and a call cancelled before it started (an abort, or a stream that ended first). Such a call
 * read nothing, so it never counts as "ran" - for example toward memory quarantine in
 * `toolNamesFromHistory`.
 */
export const PRE_EXECUTION_ERROR_CODES: ReadonlySet<string> = new Set([
  'unknown_tool',
  'tool_not_active',
  'arguments_not_allowed',
  'invalid_arguments',
  'invalid_json_arguments',
  'cancelled_before_start',
]);
