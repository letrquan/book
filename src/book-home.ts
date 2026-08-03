import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Resolve Book's user-global state root, allowing evaluation runs to isolate it explicitly. */
export function resolveBookHome(
  env: NodeJS.ProcessEnv = process.env,
  systemHome = homedir(),
): string {
  const configured = env.BOOK_HOME?.trim();
  return configured ? resolve(configured) : join(systemHome, '.book');
}
