/**
 * `npm audit` as a CI gate that tells a finding from a registry outage (#598).
 *
 * A real `high` or `critical` advisory fails at once, with no retry. A transient registry error
 * (a 5xx, a timeout, a dropped connection) is retried with a backoff. Anything else, such as an
 * HTTP 400 from a retired endpoint or an unreadable lockfile, fails at once and says so: retrying
 * it would only hide that the gate is not working.
 *
 * npm 10 falls back from the bulk advisory endpoint to the retired `audits/quick` one on ANY bulk
 * failure, so a transient bulk error surfaces there as a 400 and cannot be told from a permanent
 * one. npm 11 dropped that fallback (npm/cli 080a0f2d), so CI installs npm 11 before this runs.
 *
 *   tsx scripts/audit-gate.ts [npm audit flags, e.g. --omit=dev]
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export type AuditOutcome =
  | { kind: 'ok' }
  | { kind: 'findings'; message: string }
  | { kind: 'transient'; message: string }
  | { kind: 'fatal'; message: string };

export interface AuditRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface AuditJson {
  error?: { code?: string; summary?: string; detail?: string };
  metadata?: { vulnerabilities?: Record<string, number> };
  vulnerabilities?: Record<string, { severity?: string }>;
}

/** An answer the registry will give again: retrying cannot change it. */
const PERMANENT = /\b4\d\d\b|being retired|invalid package tree|ENOLOCK|ELOCKVERIFY|lockfile/i;
/** A failure of the request, not of what was asked. */
const TRANSIENT =
  /\b5\d\d\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|ENOTFOUND|EPIPE|ESOCKETTIMEDOUT|socket hang up|timed? ?out|network|audit endpoint returned an error/i;

function parse(stdout: string): AuditJson | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    return typeof value === 'object' && value !== null ? (value as AuditJson) : undefined;
  } catch {
    return undefined;
  }
}

/** Decide what one `npm audit --json --audit-level=high` run means. */
export function classifyAudit(run: AuditRun): AuditOutcome {
  const json = parse(run.stdout);
  const counts = json?.metadata?.vulnerabilities ?? {};
  const serious = (counts.high ?? 0) + (counts.critical ?? 0);
  if (serious > 0) {
    const names = Object.entries(json?.vulnerabilities ?? {})
      .filter(([, vuln]) => vuln.severity === 'high' || vuln.severity === 'critical')
      .map(([name, vuln]) => `${name} (${vuln.severity})`);
    return {
      kind: 'findings',
      message: `${serious} high or critical vulnerabilities${names.length ? `: ${names.join(', ')}` : ''}`,
    };
  }
  if (!json?.error && run.status === 0) return { kind: 'ok' };

  const detail = [json?.error?.code, json?.error?.summary, json?.error?.detail, run.stderr]
    .filter(Boolean)
    .join(' ')
    .trim();
  const message = detail || `npm audit exited with ${String(run.status)} and no report`;
  if (PERMANENT.test(message)) return { kind: 'fatal', message };
  if (TRANSIENT.test(message)) return { kind: 'transient', message };
  return { kind: 'fatal', message };
}

function runAudit(args: string[]): Promise<AuditRun> {
  return new Promise((done) => {
    const child = spawn('npm', ['audit', '--json', '--audit-level=high', ...args], {
      // npm is npm.cmd on Windows, which only a shell can start.
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error) => done({ status: null, stdout, stderr: error.message }));
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

export interface GateOptions {
  attempts?: number;
  delaysMs?: number[];
  run?: (args: string[]) => Promise<AuditRun>;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** Run the gate; resolves to the process exit code. */
export async function auditGate(args: string[], options: GateOptions = {}): Promise<number> {
  const attempts = options.attempts ?? 3;
  const delaysMs = options.delaysMs ?? [10_000, 30_000];
  const run = options.run ?? runAudit;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = options.log ?? ((line: string) => console.error(line));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const outcome = classifyAudit(await run(args));
    if (outcome.kind === 'ok') return 0;
    if (outcome.kind === 'findings') {
      log(`npm audit: ${outcome.message}`);
      return 1;
    }
    if (outcome.kind === 'fatal') {
      log(`npm audit failed and will not be retried: ${outcome.message}`);
      return 1;
    }
    if (attempt === attempts) {
      log(`npm audit: the registry kept failing (${attempts} attempts): ${outcome.message}`);
      return 1;
    }
    const delay = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] ?? 0;
    log(`npm audit: registry error, retrying in ${delay / 1000}s: ${outcome.message}`);
    await sleep(delay);
  }
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await auditGate(process.argv.slice(2));
}
