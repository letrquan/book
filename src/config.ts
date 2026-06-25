import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AgentConfig } from './types.js';

const configSchema = z.object({
  model: z.string().default('gpt-4o'),
  baseUrl: z.string().url().default('https://api.openai.com/v1'),
  maxTurns: z.number().int().min(1).max(100).default(25),
  animation: z.object({
    typewriterSpeed: z.number().int().min(1).max(50).default(3),
    spinnerStyle: z.enum(['braille', 'dots']).default('braille'),
  }).default({}),
  tools: z.object({
    browser: z.object({
      enabled: z.boolean().default(true),
      headless: z.boolean().default(true),
    }).default({}),
    design: z.object({
      enabled: z.boolean().default(true),
    }).default({}),
  }).default({}),
});

export function loadConfig(workspace?: string): AgentConfig {
  const apiKey = process.env.BOOK_API_KEY;
  if (!apiKey) {
    throw new Error('BOOK_API_KEY not set. Set it via environment variable or .bookrc.json');
  }

  const baseUrl = process.env.BOOK_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.BOOK_MODEL || 'gpt-4o';
  const maxTurns = process.env.BOOK_MAX_TURNS ? parseInt(process.env.BOOK_MAX_TURNS, 10) : 25;
  const resolvedWorkspace = workspace || process.env.BOOK_WORKSPACE || process.cwd();

  let fileConfig: z.infer<typeof configSchema> = {} as z.infer<typeof configSchema>;

  const configPaths = [
    workspace ? join(workspace, '.bookrc.json') : null,
    join(homedir(), '.bookrc.json'),
  ].filter(Boolean) as string[];

  for (const path of configPaths) {
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        fileConfig = configSchema.parse(raw);
        break;
      } catch (e) {
        if (e instanceof SyntaxError) {
          throw new Error(`Invalid JSON in config file: ${path}`);
        }
        throw e;
      }
    }
  }

  return {
    apiKey,
    baseUrl: process.env.BOOK_BASE_URL || fileConfig.baseUrl || baseUrl,
    model: process.env.BOOK_MODEL || fileConfig.model || model,
    maxTurns: process.env.BOOK_MAX_TURNS ? parseInt(process.env.BOOK_MAX_TURNS, 10) : fileConfig.maxTurns || maxTurns,
    workspace: resolvedWorkspace,
    animation: fileConfig.animation || { typewriterSpeed: 3, spinnerStyle: 'braille' },
    tools: fileConfig.tools || {
      browser: { enabled: true, headless: true },
      design: { enabled: true },
    },
  };
}
