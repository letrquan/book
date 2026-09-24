/** Deeply nested value access by dot-separated key path. */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Deeply nested value setter, creating intermediate objects as needed. */
export function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (
      !(parts[i] in current) ||
      typeof current[parts[i]] !== 'object' ||
      current[parts[i]] === null
    ) {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

/** Delete a dot-path and prune only empty ancestor objects on that path. */
export function deleteNestedValue(
  obj: Record<string, unknown>,
  path: string | readonly string[],
): boolean {
  const parts = typeof path === 'string' ? path.split('.') : [...path];
  const ancestors: Array<{ parent: Record<string, unknown>; key: string }> = [];
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!Object.prototype.hasOwnProperty.call(current, key)) return false;
    const next = current[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return false;
    ancestors.push({ parent: current, key });
    current = next as Record<string, unknown>;
  }

  const leaf = parts[parts.length - 1];
  if (!Object.prototype.hasOwnProperty.call(current, leaf)) return false;
  delete current[leaf];

  for (let i = ancestors.length - 1; i >= 0; i--) {
    const { parent, key } = ancestors[i];
    const child = parent[key];
    if (
      typeof child === 'object' &&
      child !== null &&
      !Array.isArray(child) &&
      Object.keys(child).length === 0
    ) {
      delete parent[key];
    } else {
      break;
    }
  }
  return true;
}

/**
 * Parse a numeric CLI flag, refusing anything that is not a usable number.
 *
 * `parseInt('none', 10)` is `NaN`, and the old guard was truthiness — `'none'` is
 * truthy, so the typo sailed through. Downstream, `NaN` loses every comparison it
 * takes part in, which is the worst possible failure for a limit: `--max-turns`
 * ran zero turns and reported `completed`, and `--max-budget-usd` read as
 * *configured* while permitting unbounded spend. Reject it at the boundary, and
 * test presence with `!== undefined` so an explicit `0` is a real zero rather than
 * a missing flag.
 */
export function parseNumericFlag(
  raw: unknown,
  flag: string,
  opts: { integer?: boolean; min?: number } = {},
): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const text = String(raw).trim();
  const value = opts.integer ? Number.parseInt(text, 10) : Number.parseFloat(text);
  // Number.parse* stops at the first bad character, so '12abc' would otherwise
  // silently become 12.
  if (!Number.isFinite(value) || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) {
    throw new Error(`${flag} expects a number, but received "${text}".`);
  }
  // `Number.parseInt('2.5', 10)` is 2, so testing the parsed value would never
  // catch a fractional input for an integer flag - it would silently truncate.
  if (opts.integer && text.includes('.')) {
    throw new Error(`${flag} expects a whole number, but received "${text}".`);
  }
  const min = opts.min ?? 0;
  if (value < min) {
    throw new Error(`${flag} must be at least ${min}, but received "${text}".`);
  }
  return value;
}

/**
 * Merge the root positional argument into `-p/--print [prompt]`.
 *
 * `--print` carries its prompt as its own optional value, so a prompt written
 * after a later flag (`book -p --model m "fix it"`) is a stray positional that
 * commander rejected with "too many arguments" (#226). Claude Code accepts the
 * prompt in either place, and so does Book now: the positional is the prompt
 * when the flag has no value of its own. Both at once is an error rather than a
 * silent choice, and a positional without `--print` is an error too, because the
 * TUI has nowhere to put it — and it is the shape a mistyped subcommand takes.
 *
 * Returns the resolved `--print` value, or `{ error }` for commander to report.
 */
export function resolvePrintPrompt(
  print: string | boolean | undefined,
  positional: string | undefined,
): { print: string | boolean | undefined } | { error: string } {
  if (positional === undefined) return { print };
  if (print === undefined) {
    return {
      error: `unexpected argument '${positional}'. A prompt on the command line needs -p/--print (book -p "${positional}"); run book --help for the subcommands.`,
    };
  }
  if (typeof print === 'string') {
    return {
      error: `the prompt was given twice: --print '${print}' and the argument '${positional}'. Pass it once, either as the --print value or as the argument.`,
    };
  }
  return { print: positional };
}
