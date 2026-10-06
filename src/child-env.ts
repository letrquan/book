/**
 * The environment every command Book starts is built here.
 *
 * `runtime-env.ts` defaults `NODE_ENV=production` before React loads, because the development
 * renderer is 2-3x slower per pass. That default is a fact about Book's own process: it is why
 * the TUI is fast, and nothing else. Inherited by a child it silently changes what the command
 * does — `npm install` drops devDependencies, a test runner reads a production build flag, a
 * framework refuses to serve a source map — while the user, who set nothing, has no way to see
 * why.
 *
 * So the default is marked (`DEFAULTED_NODE_ENV_MARKER`), and the marker is a full stop: a child
 * never sees it, and a child only loses its NODE_ENV when the marker says Book invented it. A
 * NODE_ENV the user exported before Book started has no marker and always passes through, as
 * does one a caller sets explicitly in `overrides` — a hook's own `env`, an MCP server's `env`,
 * or `ToolContext.env`. The marker is also what covers Book's own detached processes
 * (`job-runner.ts`, `job-supervisor.ts`), which build their environment from `process.env` and
 * would otherwise hand the default on to a persistent job that outlives Book.
 *
 * `ToolContext.env` is `process.env` in the agent, so the default arrives through the override
 * layer as well. The marker is what tells that apart from a request: an override object carrying
 * the marker is a copy of Book's own environment, and its NODE_ENV is the default arriving by a
 * second route. Every other override object is a declaration — even one whose NODE_ENV happens to
 * equal `production`, which is the single value an explicit request and Book's default share, and
 * the one a value-comparison rule would silently delete.
 */

/**
 * Every process Book starts runs under Book, so a `book` among them is driven by Book, not by the
 * user typing (`src/session-driver.ts`): it may keep what it learns, never its delegator's
 * instructions, as a delegated run of any other harness does. Its own `--session-driver` flag
 * still wins.
 */
export const CHILD_SESSION_DRIVER = 'agent';

/** Set alongside the default `NODE_ENV`, and stripped from every child. */
export const DEFAULTED_NODE_ENV_MARKER = 'BOOK_DEFAULTED_NODE_ENV';

/**
 * Build the environment for one child process.
 *
 * `base` defaults to Book's own environment. The result is a fresh object: a caller that
 * mutates it cannot reach back into `process.env`, which is shared with every other child.
 */
export function buildChildEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...overrides };
  delete env[DEFAULTED_NODE_ENV_MARKER];
  env.BOOK_SESSION_DRIVER = CHILD_SESSION_DRIVER;
  // Only Book's own default is removed, and only when nothing asked for it. A NODE_ENV that
  // arrived some other way is the user's and the command's to keep.
  //
  // An override carrying the marker is a copy of Book's own environment rather than a declaration:
  // `ToolContext.env` is `process.env` in the agent, and a persistent job's spec carries the
  // environment its runner was started with. Both carry the default without having asked for it.
  const overrideIsAmbient = overrides[DEFAULTED_NODE_ENV_MARKER] !== undefined;
  if (overrideIsAmbient || (base[DEFAULTED_NODE_ENV_MARKER] !== undefined && !overrides.NODE_ENV)) {
    delete env.NODE_ENV;
  }
  return env;
}
