/**
 * The legacy `.bookrc.json` (v0.1.0 format, deprecated).
 *
 * One parser for everything that reads it: the config loader, which acts on the values, and the
 * trust command and doctor, which fingerprint its `baseUrl` for an approval. A second, laxer
 * reader would compute a different fingerprint for the same file, and the approval the user
 * recorded would not be the one the loader checks.
 */
import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { unboundedInt } from './settings.js';

/**
 * Any string `new URL()` accepts, returned unchanged: what Zod 3's `.url()` checked. Zod 4's
 * `z.url()` also trims the value and strips whitespace inside it, which would change the base URL
 * a `.bookrc.json` names.
 */
const legacyUrlSchema = z.string().check((ctx) => {
  if (!URL.canParse(ctx.value)) {
    ctx.issues.push({ code: 'invalid_format', format: 'url', input: ctx.value });
  }
});

export const legacyConfigSchema = z.object({
  model: z.string().optional(),
  baseUrl: legacyUrlSchema.optional(),
  maxTurns: unboundedInt().min(1).optional(),
  maxTokens: unboundedInt().min(1000).optional(),
  autoCompactEnabled: z.boolean().optional(),
  animation: z
    .object({
      typewriterSpeed: z.number().int().min(1).max(50).default(3),
      spinnerStyle: z.enum(['braille', 'dots']).default('braille'),
    })
    .optional(),
  accessibility: z
    .object({
      screenReader: z.boolean().default(false),
      reducedMotion: z.boolean().default(false),
    })
    .optional(),
});

export type LegacyConfig = z.infer<typeof legacyConfigSchema>;

/** The path of the legacy file in a workspace. */
export function legacyConfigPath(workspace: string): string {
  return join(workspace, '.bookrc.json');
}

/**
 * Parse the workspace's `.bookrc.json`: null when there is none. Throws on a file that is not
 * JSON (naming the path) or does not match the schema, as a launch with it present does.
 */
export function parseLegacyConfig(workspace: string): LegacyConfig | null {
  const path = legacyConfigPath(workspace);
  if (!existsSync(path)) return null;
  try {
    return legacyConfigSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${path}`);
    }
    throw e;
  }
}

/**
 * The legacy `baseUrl`, for a reader that has no use for the error: undefined when the file is
 * absent, unparseable or names no usable URL, which is when there is nothing to decide either.
 */
export function readLegacyBaseUrl(workspace: string): string | undefined {
  try {
    return parseLegacyConfig(workspace)?.baseUrl;
  } catch {
    return undefined;
  }
}
