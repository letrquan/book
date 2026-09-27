/**
 * The one grammar for a boolean environment variable: `1`/`true`/`on`/`yes` and
 * `0`/`false`/`off`/`no`, case-insensitive and trimmed, and undefined for
 * anything else.
 *
 * Tri-state on purpose. A flag that reads "unset" as "off" cannot tell a caller
 * that wants the default from one that was never told, and every such caller
 * then hard-codes a second grammar beside it. `BOOK_STARTUP_ANIMATION` needs all
 * three: it has to outrank a settings file when set, leave that file alone when
 * not, and say nothing rather than guess when the value is a typo — a wrong guess
 * either delays the first render or hides the input bar a script is waiting for.
 */
export function parseEnvBoolean(raw: string | undefined): boolean | undefined {
  switch (raw?.trim().toLowerCase()) {
    case '0':
    case 'false':
    case 'off':
    case 'no':
      return false;
    case '1':
    case 'true':
    case 'on':
    case 'yes':
      return true;
    default:
      return undefined;
  }
}
