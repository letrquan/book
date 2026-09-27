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
 * layer as well; and a persistent job's spec carries the environment it was started with. An
 * override that restates the base value has chosen nothing, so it does not count as a request
 * for it — otherwise the two layers together would put the default straight back on every
 * command. An override that differs is still an explicit request, and wins.
 */

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
  // Only Book's own default is removed, and only when nothing asked for it. A NODE_ENV that
  // arrived some other way is the user's and the command's to keep.
  const requestedNodeEnv = overrides.NODE_ENV;
  const choseNodeEnv = requestedNodeEnv !== undefined && requestedNodeEnv !== base.NODE_ENV;
  if (base[DEFAULTED_NODE_ENV_MARKER] !== undefined && !choseNodeEnv) {
    delete env.NODE_ENV;
  }
  return env;
}
